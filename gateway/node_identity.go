package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"time"
)

// Recheck the saved node identity at startup and before every new private dial.
// A reassigned VPN address must never silently change the selected machine.
func newNodeVerifier(apiURL, keyFile string) (func(context.Context, rule) error, error) {
	u, err := url.Parse(apiURL)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" ||
		(u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		return nil, errors.New("Headscale identity checks require the local API")
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func(ctx context.Context, target rule) error {
		key, err := os.ReadFile(keyFile)
		if err != nil || strings.TrimSpace(string(key)) == "" {
			return errors.New("Headscale identity check unavailable")
		}
		request, err := http.NewRequestWithContext(ctx, "GET", apiURL+"/api/v1/node", nil)
		if err != nil {
			return errors.New("Headscale identity check unavailable")
		}
		request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(key)))
		response, err := client.Do(request)
		if err != nil {
			return errors.New("Headscale identity check unavailable")
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return errors.New("Headscale identity check unavailable")
		}
		var result struct {
			Nodes []struct {
				ID          json.Number `json:"id"`
				IPAddresses []string    `json:"ipAddresses"`
			} `json:"nodes"`
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, 8*1024*1024)).Decode(&result); err != nil {
			return errors.New("Headscale identity check unavailable")
		}
		want, err := netip.ParseAddr(target.TargetIP)
		if err != nil {
			return errors.New("invalid selected address")
		}
		for _, node := range result.Nodes {
			if node.ID.String() != target.NodeID {
				continue
			}
			for _, value := range node.IPAddresses {
				if address, err := netip.ParseAddr(value); err == nil && address.Unmap() == want.Unmap() {
					return nil
				}
			}
		}
		return errors.New("selected Headscale node or address changed")
	}, nil
}
