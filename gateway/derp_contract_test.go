package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"tailscale.com/derp"
	"tailscale.com/derp/derphttp"
	"tailscale.com/ipn"
	"tailscale.com/net/netmon"
	"tailscale.com/tsnet"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

// Real SDK enrollment and DERP transport go through the packaged Caddy proxy.
// All keys belong to disposable local fixtures with private temporary state.
func TestPackagedEmbeddedDERP(t *testing.T) {
	if os.Getenv("HEADSCALE_TEST_DERP") != "1" {
		t.Skip("requires the disposable DERP-enabled packaged fixture")
	}
	base := os.Getenv("HEADSCALE_TEST_URL")
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		t.Fatal("DERP fixture must be localhost")
	}
	t.Setenv("TS_DISABLE_LOGTAIL", "true")
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	publicSTUNPort, err := strconv.Atoi(os.Getenv("HEADSCALE_TEST_STUN_PORT"))
	if err != nil || publicSTUNPort < 1 || publicSTUNPort > 65535 {
		t.Fatal("a public fixture STUN port is required")
	}
	enroll := func(index int) key.NodePrivate {
		payload, _ := json.Marshal(map[string]any{"user": os.Getenv("HEADSCALE_TEST_USER"), "expiration": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "ephemeral": false})
		req, _ := http.NewRequestWithContext(ctx, "POST", base+"/web/api/v1/preauthkey", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Headscale-UI", "1")
		response, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("fixture key creation: HTTP %d", response.StatusCode)
		}
		var created struct {
			PreAuthKey struct{ Key string } `json:"preAuthKey"`
		}
		if err := json.NewDecoder(response.Body).Decode(&created); err != nil || created.PreAuthKey.Key == "" {
			t.Fatal("missing local enrollment key")
		}
		directory := t.TempDir()
		server := &tsnet.Server{Dir: directory, ControlURL: base, Hostname: fmt.Sprintf("derp-fixture-%d", index), AuthKey: created.PreAuthKey.Key, UserLogf: logger.Discard, Logf: logger.Discard}
		defer server.Close()
		state, err := server.Up(ctx)
		if err != nil {
			t.Fatal("DERP fixture node enrollment failed")
		}
		local, err := server.LocalClient()
		if err != nil {
			t.Fatal(err)
		}
		derpMap, err := local.CurrentDERPMap(ctx)
		if err != nil || derpMap == nil {
			t.Fatal("fixture did not receive its DERP map")
		}
		region := derpMap.Regions[999]
		if region == nil || len(region.Nodes) != 1 || region.Nodes[0].STUNPort != publicSTUNPort || region.Nodes[0].HostName != u.Hostname() {
			t.Fatal("client received an incorrect embedded DERP region or public STUN port")
		}
		encoded, err := os.ReadFile(filepath.Join(directory, "tailscaled.state"))
		if err != nil {
			t.Fatal(err)
		}
		var profiles map[string][]byte
		if err := json.Unmarshal(encoded, &profiles); err != nil {
			t.Fatal(err)
		}
		for _, content := range profiles {
			var prefs ipn.Prefs
			if json.Unmarshal(content, &prefs) == nil && prefs.Persist != nil && state.Self != nil && prefs.Persist.NodeID == state.Self.ID && !prefs.Persist.PrivateNodeKey.IsZero() {
				return prefs.Persist.PrivateNodeKey
			}
		}
		t.Fatal("no private node identity in local test state")
		return key.NodePrivate{}
	}
	leftKey, rightKey := enroll(1), enroll(2)
	client := func(nodeKey key.NodePrivate) *derphttp.Client {
		c, err := derphttp.NewClient(nodeKey, base+"/derp", logger.Discard, netmon.NewStatic())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		stop := context.AfterFunc(ctx, func() { c.Close() })
		t.Cleanup(func() { stop() })
		return c
	}
	left, right := client(leftKey), client(rightKey)
	for _, c := range []*derphttp.Client{left, right} {
		if err := c.Connect(ctx); err != nil {
			t.Fatal("registered node could not connect through packaged DERP proxy")
		}
		message, err := c.Recv()
		if _, ok := message.(derp.ServerInfoMessage); err != nil || !ok {
			t.Fatalf("registered DERP handshake: message %T, error %v", message, err)
		}
	}
	check := func(sender, receiver *derphttp.Client, source, destination key.NodePublic) {
		payload := []byte("packaged-headscale-derp-relay")
		if err := sender.Send(destination, payload); err != nil {
			t.Fatal(err)
		}
		for {
			message, err := receiver.Recv()
			if err != nil {
				t.Fatal("embedded DERP did not relay the packet")
			}
			if packet, ok := message.(derp.ReceivedPacket); ok {
				if packet.Source != source || !bytes.Equal(packet.Data, payload) {
					t.Fatal("incorrect DERP packet source or payload")
				}
				return
			}
		}
	}
	check(left, right, leftKey.Public(), rightKey.Public())
	check(right, left, rightKey.Public(), leftKey.Public())
	unknown := client(key.NewNode())
	if err := unknown.Connect(ctx); err == nil {
		message, err := unknown.Recv()
		if _, accepted := message.(derp.ServerInfoMessage); err == nil && accepted {
			t.Fatal("embedded DERP accepted an unregistered client")
		}
	}
	t.Log("Embedded DERP relayed both directions and rejected an unregistered client")
}
