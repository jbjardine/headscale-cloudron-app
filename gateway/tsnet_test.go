package main

import (
	"context"
	"io"
	"net"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"tailscale.com/net/netns"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

// Both coordination servers and DERP relays are local test fixtures. This test
// never enrolls in official Tailscale or the operator's Headscale network.
func TestIsolatedTsnetGatewayForwardsOnlySelectedPort(t *testing.T) {
	t.Setenv("TS_DISABLE_LOGTAIL", "true")
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	control := func() string {
		c := &testcontrol.Server{Logf: logger.Discard, DERPMap: integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1"), DNSConfig: &tailcfg.DNSConfig{}}
		c.HTTPTestServer = httptest.NewServer(c)
		t.Cleanup(c.HTTPTestServer.Close)
		return c.HTTPTestServer.URL
	}
	privateURL, officialURL := control(), control()
	node := func(url, name string) (*tsnet.Server, netip.Addr) {
		s := &tsnet.Server{Dir: t.TempDir(), ControlURL: url, Hostname: name, Ephemeral: true, Logf: logger.Discard, UserLogf: logger.Discard}
		t.Cleanup(func() { s.Close() })
		state, err := s.Up(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return s, state.TailscaleIPs[0]
	}
	nas, nasIP := node(privateURL, "test-nas")
	privateGateway, _ := node(privateURL, "private-gateway")
	client, clientIP := node(officialURL, "cloud-client")
	officialGateway, gatewayIP := node(officialURL, "official-gateway")
	service, err := nas.Listen("tcp", ":445")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { service.Close() })
	go func() {
		for {
			c, err := service.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	listener, err := officialGateway.Listen("tcp", ":1445")
	if err != nil {
		t.Fatal(err)
	}
	f := &forwarder{dial: privateGateway.Dial, sources: []netip.Prefix{netip.PrefixFrom(clientIP, 32)}, mode: "restricted", slots: make(chan struct{}, 2), idle: time.Second * 10, stats: &counters{}}
	go f.serve(ctx, listener, net.JoinHostPort(nasIP.String(), "445"))
	var connection net.Conn
	for ctx.Err() == nil {
		connection, err = client.Dial(ctx, "tcp", net.JoinHostPort(gatewayIP.String(), "1445"))
		if err == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	connection.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := connection.Write([]byte("private-nas")); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, len("private-nas"))
	if _, err := io.ReadFull(connection, buffer); err != nil || string(buffer) != "private-nas" {
		t.Fatalf("gateway round trip: %q %v", buffer, err)
	}
	// No implicit fallback may forward an unconfigured port to localhost's UI.
	closedCtx, stop := context.WithTimeout(ctx, 2*time.Second)
	defer stop()
	unexpected, err := client.Dial(closedCtx, "tcp", net.JoinHostPort(gatewayIP.String(), "8080"))
	if err == nil {
		unexpected.Close()
		t.Fatal("unconfigured app administration port was exposed")
	}
}
