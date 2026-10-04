package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type nodeFixture struct {
	mu          sync.Mutex
	id, address string
	status      int
}

func identityFixture(t *testing.T) (*nodeFixture, string, string) {
	t.Helper()
	fixture := &nodeFixture{id: "3", address: "100.64.0.7", status: http.StatusOK}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/node" || r.Header.Get("Authorization") != "Bearer local-identity-test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		w.WriteHeader(fixture.status)
		nodes := []map[string]any{}
		if fixture.id != "" {
			nodes = append(nodes, map[string]any{"id": fixture.id, "ipAddresses": []string{fixture.address}})
		}
		json.NewEncoder(w).Encode(map[string]any{"nodes": nodes})
	}))
	t.Cleanup(server.Close)
	keyFile := filepath.Join(t.TempDir(), "apikey")
	if err := os.WriteFile(keyFile, []byte("local-identity-test-token"), 0600); err != nil {
		t.Fatal(err)
	}
	return fixture, server.URL, keyFile
}

func (f *nodeFixture) change(id, address string, status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.id, f.address, f.status = id, address, status
}

func TestNodeIdentityRejectsDeletedReassignedAndChangedNodes(t *testing.T) {
	fixture, url, keyFile := identityFixture(t)
	verify, err := newNodeVerifier(url, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	target := rule{NodeID: "3", TargetIP: "100.64.0.7", TargetPort: 445, ListenPort: 1445}
	if err := verify(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		id, address string
		status      int
	}{
		{"", "", 200}, {"4", "100.64.0.7", 200}, {"3", "100.64.0.8", 200}, {"3", "100.64.0.7", 503},
	} {
		fixture.change(test.id, test.address, test.status)
		if verify(context.Background(), target) == nil {
			t.Fatal("accepted a missing, reassigned, changed or unverifiable node")
		}
	}
	fixture.change("3", "fd7a:115c:a1e0::7", 200)
	target.TargetIP = "fd7a:115c:a1e0:0:0:0:0:7"
	if err := verify(context.Background(), target); err != nil {
		t.Fatal("equivalent IPv6 address was rejected")
	}
	for _, unsafe := range []string{"https://example.test", "http://192.168.1.1", url + "/redirect"} {
		if _, err := newNodeVerifier(unsafe, keyFile); err == nil {
			t.Fatal("accepted a non-local API endpoint")
		}
	}
}

func TestForwarderChecksSavedIdentityBeforeEveryPrivateDial(t *testing.T) {
	fixture, url, keyFile := identityFixture(t)
	verify, err := newNodeVerifier(url, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	target := rule{NodeID: "3", TargetIP: "100.64.0.7", TargetPort: 445, ListenPort: 1445}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	listener := &testListener{connections: make(chan net.Conn), done: make(chan struct{})}
	dialed := make(chan string, 3)
	f := &forwarder{mode: "tailnet", slots: make(chan struct{}, 3), idle: time.Second, stats: &counters{},
		verify: func(ctx context.Context, _ string) error { return verify(ctx, target) }}
	f.dial = func(_ context.Context, _, address string) (net.Conn, error) {
		a, b := net.Pipe()
		t.Cleanup(func() { b.Close() })
		dialed <- address
		return a, nil
	}
	go f.serve(ctx, listener, "100.64.0.7:445")
	connect := func() net.Conn {
		a, b := net.Pipe()
		listener.connections <- sourceConnection{b, &net.TCPAddr{IP: net.ParseIP("100.100.100.1"), Port: 12000}}
		return a
	}
	first := connect()
	defer first.Close()
	select {
	case <-dialed:
	case <-time.After(time.Second):
		t.Fatal("valid target was not dialed")
	}
	// Another node receives the old IP while the gateway is still running.
	fixture.change("4", target.TargetIP, 200)
	second := connect()
	defer second.Close()
	second.SetReadDeadline(time.Now().Add(time.Second))
	var one [1]byte
	if _, err := second.Read(one[:]); !errors.Is(err, io.EOF) {
		t.Fatalf("stale target connection remained open: %v", err)
	}
	select {
	case <-dialed:
		t.Fatal("replacement node was dialed")
	default:
	}
	if f.stats.denied.Load() != 1 {
		t.Fatal("missing stale-target rejection")
	}
}

func TestStartupRejectsStaleTargetBeforeEnrollment(t *testing.T) {
	fixture, url, keyFile := identityFixture(t)
	fixture.change("4", "100.64.0.7", 200)
	dir := t.TempDir()
	configPath := filepath.Join(dir, "settings.json")
	c := config{Enabled: true, HeadscaleUserID: "1", SourceMode: "tailnet", MaxConnections: 16, IdleTimeoutSeconds: 900,
		Rules: []rule{{NodeID: "3", TargetIP: "100.64.0.7", TargetPort: 445, ListenPort: 1445}}}
	if err := privateJSON(configPath, c); err != nil {
		t.Fatal(err)
	}
	if run(context.Background(), configPath, dir, "http://127.0.0.1:1", url, keyFile) == nil {
		t.Fatal("stale startup rule was accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "official")); !os.IsNotExist(err) {
		t.Fatal("enrollment started for a stale target")
	}
}
