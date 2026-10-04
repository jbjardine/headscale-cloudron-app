package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

func TestSourceRestrictions(t *testing.T) {
	prefixes := []netip.Prefix{netip.MustParsePrefix("100.100.100.1/32")}
	for _, test := range []struct {
		address, mode string
		want          bool
	}{
		{"100.100.100.1:12000", "restricted", true}, {"100.100.100.2:12000", "restricted", false},
		{"100.100.100.2:12000", "tailnet", true}, {"127.0.0.1:12000", "tailnet", false},
		{"[::ffff:100.100.100.1]:12000", "restricted", true},
	} {
		address, err := net.ResolveTCPAddr("tcp", test.address)
		if err != nil {
			t.Fatal(err)
		}
		if got := allowed(address, test.mode, prefixes); got != test.want {
			t.Fatalf("%s %s: got %v", test.address, test.mode, got)
		}
	}
}

func TestConfigRejectsUnsafeDestinationsAndDuplicatePorts(t *testing.T) {
	c := config{Enabled: true, HeadscaleUserID: "1", SourceMode: "tailnet", MaxConnections: 16, IdleTimeoutSeconds: 900,
		Rules: []rule{{NodeID: "3", TargetIP: "127.0.0.1", TargetPort: 445, ListenPort: 1445}}}
	path := filepath.Join(t.TempDir(), "settings.json")
	write := func() {
		data, _ := json.Marshal(c)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	if _, err := loadConfig(path); err == nil {
		t.Fatal("accepted loopback destination")
	}
	c.Rules[0].TargetIP = "100.64.0.7"
	write()
	if _, err := loadConfig(path); err != nil {
		t.Fatal(err)
	}
	c.Rules = append(c.Rules, c.Rules[0])
	write()
	if _, err := loadConfig(path); err == nil {
		t.Fatal("accepted duplicate listeners")
	}
}

func TestBridgeTransfersBothDirectionsAndCancellationClosesConnections(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, incoming := net.Pipe()
	outgoing, service := net.Pipe()
	defer client.Close()
	defer service.Close()
	f := &forwarder{idle: time.Second, stats: &counters{}}
	done := make(chan struct{})
	go func() { f.bridge(ctx, incoming, outgoing); close(done) }()
	go client.Write([]byte("request"))
	buffer := make([]byte, 7)
	if _, err := io.ReadFull(service, buffer); err != nil || string(buffer) != "request" {
		t.Fatalf("request: %q %v", buffer, err)
	}
	go service.Write([]byte("response"))
	buffer = make([]byte, 8)
	if _, err := io.ReadFull(client, buffer); err != nil || string(buffer) != "response" {
		t.Fatalf("response: %q %v", buffer, err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("bridge did not close on cancellation")
	}
	if f.stats.transferred.Load() != 15 {
		t.Fatal("wrong byte count")
	}
}

func TestIdleBridgeCloses(t *testing.T) {
	client, incoming := net.Pipe()
	outgoing, service := net.Pipe()
	defer client.Close()
	defer service.Close()
	f := &forwarder{idle: 30 * time.Millisecond, stats: &counters{}}
	done := make(chan struct{})
	go func() { f.bridge(context.Background(), incoming, outgoing); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("idle connection was not closed")
	}
}

type testListener struct { connections chan net.Conn; done chan struct{}; once sync.Once }
func (l *testListener) Accept() (net.Conn, error) { select { case connection := <-l.connections: return connection, nil; case <-l.done: return nil, net.ErrClosed } }
func (l *testListener) Close() error { l.once.Do(func(){ close(l.done) }); return nil }
func (l *testListener) Addr() net.Addr { return &net.TCPAddr{} }
type sourceConnection struct { net.Conn; source net.Addr }
func (c sourceConnection) RemoteAddr() net.Addr { return c.source }

func TestConnectionLimitAndSourcesRejectBeforeDial(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background()); defer cancel()
	listener := &testListener{connections: make(chan net.Conn), done: make(chan struct{})}
	dialed := make(chan string, 3)
	f := &forwarder{mode: "restricted", sources: []netip.Prefix{netip.MustParsePrefix("100.100.100.1/32")}, slots: make(chan struct{}, 1), idle: time.Second, stats: &counters{}}
	f.dial = func(_ context.Context, _, address string) (net.Conn, error) { a, b := net.Pipe(); t.Cleanup(func(){ b.Close() }); dialed <- address; return a, nil }
	go f.serve(ctx, listener, "100.64.0.7:445")
	connect := func(ip string) net.Conn { a, b := net.Pipe(); listener.connections <- sourceConnection{b, &net.TCPAddr{IP: net.ParseIP(ip), Port: 12000}}; return a }
	first := connect("100.100.100.1"); defer first.Close()
	select { case address := <-dialed: if address != "100.64.0.7:445" { t.Fatal(address) }; case <-time.After(time.Second): t.Fatal("allowed connection was not dialed") }
	for _, source := range []string{"100.100.100.1", "100.100.100.2"} {
		connection := connect(source); connection.SetReadDeadline(time.Now().Add(time.Second))
		var one [1]byte
		if _, err := connection.Read(one[:]); err != io.EOF { t.Fatalf("rejected source remained connected: %v", err) }
		connection.Close()
	}
	if f.stats.denied.Load() != 2 { t.Fatal("incorrect rejection count") }
	select { case <-dialed: t.Fatal("rejected connection reached destination"); default: }
}

func TestSharedBandwidthLimiterDelaysTraffic(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background()); defer cancel()
	client, incoming := net.Pipe(); outgoing, service := net.Pipe()
	defer client.Close(); defer service.Close()
	f := &forwarder{idle: 2*time.Second, stats: &counters{}, limiter: rate.NewLimiter(32768, 16*1024)}
	go f.bridge(ctx, incoming, outgoing)
	payload := make([]byte, 32*1024)
	started := time.Now()
	go client.Write(payload)
	if _, err := io.ReadFull(service, payload); err != nil { t.Fatal(err) }
	if time.Since(started) < 400*time.Millisecond { t.Fatal("bandwidth limit was bypassed") }
}
