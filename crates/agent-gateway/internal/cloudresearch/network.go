package cloudresearch

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
	"unicode"
)

// Conservative IANA special-purpose exclusions. Even globally reachable
// special-purpose anycast/service blocks are not generic public page origins.
var blockedPrefixes = func() []netip.Prefix {
	var result []netip.Prefix
	for _, raw := range []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.31.196.0/24", "192.52.193.0/24", "192.88.99.0/24", "192.168.0.0/16", "192.175.48.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "2001::/23", "2001:db8::/32", "2002::/16", "2620:4f:8000::/48", "3fff::/20"} {
		result = append(result, netip.MustParsePrefix(raw))
	}
	return result
}()

func publicIP(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, prefix := range blockedPrefixes {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

// NormalizeURL checks syntax and literal addresses, not DNS. Fetch performs
// DNS validation again immediately before each literal-IP-pinned connection.
func NormalizeURL(raw string) (*url.URL, error) {
	if raw == "" || raw != strings.TrimSpace(raw) || len(raw) > 4096 || strings.Contains(raw, "\\") {
		return nil, ErrUnsafeURL
	}
	for _, char := range raw {
		if unicode.IsControl(char) {
			return nil, ErrUnsafeURL
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || u.Host == "" || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, ErrUnsafeURL
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if strings.ContainsAny(host, "% /\\") || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return nil, ErrUnsafeURL
	}
	if ip, parseErr := netip.ParseAddr(host); parseErr == nil {
		if !publicIP(ip) {
			return nil, ErrUnsafeURL
		}
		host = ip.String()
	} else {
		if len(host) > 253 || !strings.Contains(host, ".") {
			return nil, ErrUnsafeURL
		}
		for _, label := range strings.Split(host, ".") {
			if len(label) < 1 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return nil, ErrUnsafeURL
			}
			for _, char := range label {
				if char != '-' && (char < 'a' || char > 'z') && (char < '0' || char > '9') {
					return nil, ErrUnsafeURL
				}
			}
		}
		// Reject historical numeric IPv4 forms that browsers/resolvers interpret
		// differently (decimal, octal, hexadecimal and shortened dotted forms).
		numeric := true
		for _, char := range host {
			if char != '.' && (char < '0' || char > '9') {
				numeric = false
			}
		}
		if numeric || strings.HasPrefix(host, "0x") {
			return nil, ErrUnsafeURL
		}
	}
	port := u.Port()
	expected := "443"
	if u.Scheme == "http" {
		expected = "80"
	}
	if strings.HasSuffix(u.Host, ":") || port != "" && port != expected {
		return nil, ErrUnsafeURL
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return nil, ErrUnsafeURL
	}
	for key := range query {
		switch strings.ToLower(key) {
		case "access_token", "api_key", "apikey", "authorization", "auth", "password", "secret", "token", "signature", "x-amz-signature", "x-amz-credential", "x-goog-signature", "x-goog-credential":
			return nil, ErrUnsafeURL
		}
	}
	u.Host = host
	if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	}
	u.Fragment, u.RawFragment = "", ""
	return u, nil
}

func resolvedPublicIPs(ctx context.Context, network Network, host string) ([]netip.Addr, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		if !publicIP(ip) {
			return nil, ErrUnsafeURL
		}
		return []netip.Addr{ip.Unmap()}, nil
	}
	ips, err := network.Resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, safeError(ctx, err)
	}
	if len(ips) == 0 || len(ips) > 32 {
		return nil, ErrUnsafeURL
	}
	result := make([]netip.Addr, 0, len(ips))
	seen := make(map[netip.Addr]bool)
	for _, ip := range ips {
		if !publicIP(ip) {
			return nil, ErrUnsafeURL
		}
		ip = ip.Unmap()
		if !seen[ip] {
			result = append(result, ip)
			seen[ip] = true
		}
	}
	return result, nil
}

func pinnedClient(ctx context.Context, u *url.URL, network Network, limits Limits) (*http.Client, func(), error) {
	ips, err := resolvedPublicIPs(ctx, network, u.Hostname())
	if err != nil {
		return nil, nil, err
	}
	port := "443"
	if u.Scheme == "http" {
		port = "80"
	}
	transport := &http.Transport{
		Proxy: nil, DisableCompression: true, DisableKeepAlives: true,
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 5 * time.Second,
		MaxResponseHeaderBytes: int64(limits.MaxHeaderBytes), MaxConnsPerHost: 1,
		DialContext: func(dialCtx context.Context, kind, address string) (net.Conn, error) {
			host, dialPort, splitErr := net.SplitHostPort(address)
			if splitErr != nil || host != u.Hostname() || dialPort != port || kind != "tcp" {
				return nil, ErrUnsafeURL
			}
			for _, ip := range ips {
				conn, dialErr := network.DialContext(dialCtx, "tcp", net.JoinHostPort(ip.String(), port))
				if dialErr != nil {
					if dialCtx.Err() != nil {
						return nil, dialCtx.Err()
					}
					continue
				}
				remoteHost, remotePort, peerErr := net.SplitHostPort(conn.RemoteAddr().String())
				peer, parseErr := netip.ParseAddr(remoteHost)
				if peerErr != nil || parseErr != nil || peer.Unmap() != ip || remotePort != port {
					_ = conn.Close()
					return nil, ErrUnsafeURL
				}
				return conn, nil
			}
			return nil, ErrUnavailable
		},
	}
	client := &http.Client{Transport: transport, Timeout: limits.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return client, transport.CloseIdleConnections, nil
}
