package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"

	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
)

// Invoked by the packaged-image smoke test against its disposable localhost
// Headscale. A real enrollment key exists only in memory and private tsnet state.
func TestPackagedHeadscaleEnrollment(t *testing.T) {
	base := os.Getenv("HEADSCALE_TEST_URL")
	if base == "" {
		t.Skip("requires the disposable packaged Headscale fixture")
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		t.Fatal("Headscale fixture must be localhost")
	}
	t.Setenv("TS_DISABLE_LOGTAIL", "true")
	payload, _ := json.Marshal(map[string]any{"user": os.Getenv("HEADSCALE_TEST_USER"), "expiration": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "ephemeral": true, "reusable": false})
	req, err := http.NewRequest("POST", base+"/web/api/v1/preauthkey", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Headscale-UI", "1")
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("fixture enrollment key creation: HTTP %d", response.StatusCode)
	}
	var created struct {
		PreAuthKey struct {
			Key string `json:"key"`
		} `json:"preAuthKey"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.PreAuthKey.Key == "" {
		t.Fatal("no fixture enrollment key returned")
	}
	server := &tsnet.Server{Dir: t.TempDir(), ControlURL: base, Hostname: "package-sdk-check", AuthKey: created.PreAuthKey.Key, Ephemeral: true, UserLogf: logger.Discard, Logf: logger.Discard}
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	state, err := server.Up(ctx)
	if err != nil {
		t.Fatal("official tsnet SDK could not enroll in the packaged Headscale")
	}
	if len(state.TailscaleIPs) == 0 {
		t.Fatal("Headscale did not assign a VPN address")
	}
}
