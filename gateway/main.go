// The two tsnet servers have separate identities and network stacks. Only
// explicitly configured TCP listeners exist on the official Tailscale side.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/time/rate"
	"tailscale.com/tsnet"
)

type rule struct {
	NodeID     string `json:"nodeId"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
	ListenPort int    `json:"listenPort"`
}

type config struct {
	Enabled            bool     `json:"enabled"`
	HeadscaleUserID    string   `json:"headscaleUserId"`
	SourceMode         string   `json:"sourceMode"`
	AllowedSources     []string `json:"allowedSources"`
	MaxConnections     int      `json:"maxConnections"`
	MaxBytesPerSecond  int      `json:"maxBytesPerSecond"`
	IdleTimeoutSeconds int      `json:"idleTimeoutSeconds"`
	Rules              []rule   `json:"rules"`
}

type counters struct{ active, accepted, denied, transferred atomic.Int64 }
type status struct {
	State        string   `json:"state"`
	Message      string   `json:"message"`
	OfficialIPs  []string `json:"officialIps"`
	HeadscaleIPs []string `json:"headscaleIps"`
	Active       int64    `json:"activeConnections"`
	Accepted     int64    `json:"acceptedConnections"`
	Denied       int64    `json:"deniedConnections"`
	Transferred  int64    `json:"transferredBytes"`
}

func privateJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err = os.WriteFile(path+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

func loadConfig(path string) (config, error) {
	var c config
	f, err := os.Open(path)
	if err != nil {
		return c, err
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, 1024*1024))
	d.DisallowUnknownFields()
	if err = d.Decode(&c); err != nil {
		return c, err
	}
	if !c.Enabled || c.MaxConnections < 1 || c.MaxConnections > 512 || c.MaxBytesPerSecond < 0 || c.MaxBytesPerSecond > 1_000_000_000 || c.IdleTimeoutSeconds < 30 || c.IdleTimeoutSeconds > 86400 || len(c.Rules) > 64 || len(c.AllowedSources) > 64 {
		return c, errors.New("invalid limits")
	}
	user, err := strconv.ParseUint(c.HeadscaleUserID, 10, 64)
	if err != nil || user == 0 {
		return c, errors.New("invalid Headscale user")
	}
	if c.SourceMode != "restricted" && c.SourceMode != "tailnet" {
		return c, errors.New("invalid source mode")
	}
	if c.SourceMode == "restricted" && len(c.Rules) > 0 && len(c.AllowedSources) == 0 {
		return c, errors.New("restricted rules require sources")
	}
	for _, s := range c.AllowedSources {
		if _, err := netip.ParsePrefix(s); err != nil {
			return c, err
		}
	}
	ports := map[int]bool{}
	for _, r := range c.Rules {
		ip, err := netip.ParseAddr(r.TargetIP)
		if err != nil || !tailnetIP(ip) || r.TargetPort < 1 || r.TargetPort > 65535 || r.ListenPort < 1024 || r.ListenPort > 65535 || ports[r.ListenPort] {
			return c, errors.New("invalid forwarding rule")
		}
		ports[r.ListenPort] = true
	}
	return c, nil
}

func tailnetIP(ip netip.Addr) bool {
	return netip.MustParsePrefix("100.64.0.0/10").Contains(ip.Unmap()) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip)
}

func allowed(remote net.Addr, mode string, prefixes []netip.Prefix) bool {
	ipPort, err := netip.ParseAddrPort(remote.String())
	if err != nil || !tailnetIP(ipPort.Addr()) {
		return false
	}
	if mode == "tailnet" {
		return true
	}
	for _, p := range prefixes {
		if p.Contains(ipPort.Addr().Unmap()) {
			return true
		}
	}
	return false
}

type forwarder struct {
	dial    func(context.Context, string, string) (net.Conn, error)
	sources []netip.Prefix
	mode    string
	slots   chan struct{}
	limiter *rate.Limiter
	idle    time.Duration
	stats   *counters
}

// serve never opens a socket in the container's host network. The caller gives
// it a tsnet listener, and dial is the other tsnet server's userspace Dial.
func (f *forwarder) serve(ctx context.Context, listener net.Listener, target string) {
	go func() { <-ctx.Done(); listener.Close() }()
	for {
		incoming, err := listener.Accept()
		if err != nil {
			return
		}
		if !allowed(incoming.RemoteAddr(), f.mode, f.sources) {
			f.stats.denied.Add(1)
			incoming.Close()
			continue
		}
		select {
		case f.slots <- struct{}{}:
			f.stats.active.Add(1)
			go func() {
				defer func() { <-f.slots; f.stats.active.Add(-1) }()
				defer incoming.Close()
				dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
				outgoing, err := f.dial(dialCtx, "tcp", target)
				cancel()
				if err != nil {
					f.stats.denied.Add(1)
					return
				}
				defer outgoing.Close()
				f.stats.accepted.Add(1)
				f.bridge(ctx, incoming, outgoing)
			}()
		default:
			f.stats.denied.Add(1)
			incoming.Close()
		}
	}
}

func (f *forwarder) bridge(ctx context.Context, a, b net.Conn) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { <-ctx.Done(); a.Close(); b.Close() }()
	touch := func() { deadline := time.Now().Add(f.idle); a.SetDeadline(deadline); b.SetDeadline(deadline) }
	touch()
	done := make(chan struct{}, 2)
	copyStream := func(dst, src net.Conn) {
		defer func() { done <- struct{}{} }()
		buffer := make([]byte, 16*1024)
		for {
			n, readErr := src.Read(buffer)
			if n > 0 {
				if f.limiter != nil && f.limiter.WaitN(ctx, n) != nil {
					cancel()
					return
				}
				touch()
				for written := 0; written < n; {
					count, err := dst.Write(buffer[written:n])
					written += count
					f.stats.transferred.Add(int64(count))
					touch()
					if err != nil || count == 0 {
						cancel()
						return
					}
				}
			}
			if readErr != nil {
				if errors.Is(readErr, io.EOF) {
					if half, ok := dst.(interface{ CloseWrite() error }); ok {
						half.CloseWrite()
					} else {
						cancel()
					}
				} else {
					cancel()
				}
				return
			}
		}
	}
	go copyStream(a, b)
	go copyStream(b, a)
	<-done
	<-done
}

func run(ctx context.Context, configPath, dir, controlURL string) error {
	c, err := loadConfig(configPath)
	if err != nil {
		return errors.New("invalid gateway settings")
	}
	s := status{State: "connecting", Message: "Connecting the two gateway identities"}
	statusPath := filepath.Join(dir, "status.json")
	privateJSON(statusPath, s)
	headDir := filepath.Join(dir, "headscale-"+c.HeadscaleUserID)
	for _, path := range []string{filepath.Join(dir, "official"), headDir} {
		if err := os.MkdirAll(path, 0700); err != nil {
			return err
		}
	}
	readKey := func(path string) string { data, _ := os.ReadFile(path); return strings.TrimSpace(string(data)) }
	quiet := func(string, ...any) {} // Authentication URLs and keys never reach UI/logs.
	name := "headscale-gateway"
	official := &tsnet.Server{Dir: filepath.Join(dir, "official"), Hostname: name, ControlURL: "https://controlplane.tailscale.com", AuthKey: readKey(filepath.Join(dir, "official.key")), UserLogf: quiet, Logf: quiet}
	headscale := &tsnet.Server{Dir: headDir, Hostname: name + "-private", ControlURL: controlURL, AuthKey: readKey(filepath.Join(headDir, "enrollment.key")), UserLogf: quiet, Logf: quiet}
	defer official.Close()
	defer headscale.Close()
	upCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	headStatus, err := headscale.Up(upCtx)
	if err != nil {
		return errors.New("Headscale enrollment or policy connection failed")
	}
	if err := os.WriteFile(filepath.Join(headDir, "enrolled"), []byte("registered\n"), 0600); err != nil {
		return errors.New("Could not save gateway identity status")
	}
	officialStatus, err := official.Up(upCtx)
	if err != nil {
		return errors.New("Official Tailscale enrollment or policy connection failed")
	}
	for _, ip := range headStatus.TailscaleIPs {
		s.HeadscaleIPs = append(s.HeadscaleIPs, ip.String())
	}
	for _, ip := range officialStatus.TailscaleIPs {
		s.OfficialIPs = append(s.OfficialIPs, ip.String())
	}
	f := &forwarder{dial: headscale.Dial, mode: c.SourceMode, slots: make(chan struct{}, c.MaxConnections), idle: time.Duration(c.IdleTimeoutSeconds) * time.Second, stats: &counters{}}
	for _, p := range c.AllowedSources {
		prefix, _ := netip.ParsePrefix(p)
		f.sources = append(f.sources, prefix)
	}
	if c.MaxBytesPerSecond > 0 {
		f.limiter = rate.NewLimiter(rate.Limit(c.MaxBytesPerSecond), 16*1024)
	}
	for _, r := range c.Rules {
		for _, ip := range headStatus.TailscaleIPs {
			if ip.String() == r.TargetIP {
				return errors.New("The gateway cannot forward to itself")
			}
		}
		listener, err := official.Listen("tcp", ":"+strconv.Itoa(r.ListenPort))
		if err != nil {
			return errors.New("Could not open a configured Tailscale listener")
		}
		defer listener.Close()
		go f.serve(ctx, listener, net.JoinHostPort(r.TargetIP, strconv.Itoa(r.TargetPort)))
	}
	s.State, s.Message = "running", "Gateway connected; only configured TCP services are exposed"
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		s.Active, s.Accepted, s.Denied, s.Transferred = f.stats.active.Load(), f.stats.accepted.Load(), f.stats.denied.Load(), f.stats.transferred.Load()
		if err := privateJSON(statusPath, s); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func main() {
	configPath := flag.String("config", "/app/data/gateway/settings.json", "Settings file")
	dir := flag.String("state-dir", "/app/data/gateway", "Private state directory")
	control := flag.String("headscale-url", "", "Headscale coordination URL")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, *configPath, *dir, *control); err != nil {
		privateJSON(filepath.Join(*dir, "status.json"), status{State: "error", Message: err.Error()})
		fmt.Fprintln(os.Stderr, "Gateway stopped; inspect its status in the authenticated UI")
		os.Exit(1)
	}
}
