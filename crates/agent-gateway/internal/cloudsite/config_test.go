package cloudsite

import (
	"strings"
	"testing"
)

func TestSiteHostIsolationAndBoundTokens(t *testing.T) {
	key := strings.Repeat("k", 64)
	c, err := NewConfig("https://{site}.example.net", "https://app.example.com", "127.0.0.1:18081", key, false)
	if err != nil {
		t.Fatal(err)
	}
	id := "f0000000-0000-4000-8000-000000000001"
	token, err := c.Token(id, "owner-release-private")
	if err != nil || !c.VerifyToken(token, id, "owner-release-private") || c.VerifyToken(token, id, "other-owner") {
		t.Fatal("token binding failed")
	}
	parsed, err := GrantID(token)
	if err != nil || parsed != id {
		t.Fatal("grant identity failed")
	}
	origin, err := c.Origin(id)
	if err != nil || origin != "https://f0000000000040008000000000000001.example.net" {
		t.Fatal("isolated host mismatch", origin, err)
	}
	for _, test := range []struct {
		template, app, addr, key string
		local                    bool
	}{
		{"https://{site}.sites.example.com", "https://app.example.com", "127.0.0.1:18081", key, false},
		{"http://{site}.example.net", "https://app.example.com", "127.0.0.1:18081", key, true},
		{"https://{site}.example.net/path", "https://app.example.com", "127.0.0.1:18081", key, false},
		{"https://{site}.example.net", "https://app.example.com", "0.0.0.0:18081", key, false},
		{"https://{site}.example.net", "https://app.example.com", "127.0.0.1:18081", "short", false},
		{"https://{site}.example.net", "https://app.example.com", "127.0.0.1:http", key, false},
		{"https://{site}.example.net", "https://app.example.com", "127.0.0.1:65536", key, false},
		{"https://{site}.example.net:65536", "https://app.example.com", "127.0.0.1:18081", key, false},
		{"https://{site}.bad_host.net", "https://app.example.com", "127.0.0.1:18081", key, false},
		{"https://{site}.example.net:", "https://app.example.com", "127.0.0.1:18081", key, false},
		{"https://{site}.-bad.net", "https://app.example.com", "127.0.0.1:18081", key, false},
	} {
		if _, err := NewConfig(test.template, test.app, test.addr, test.key, test.local); err == nil {
			t.Fatal("unsafe host config accepted", test.template)
		}
	}
	if _, err := NewConfig("http://{site}.localhost:18081", "http://127.0.0.1:8080", "127.0.0.1:18081", key, true); err != nil {
		t.Fatal("explicit local fixture rejected", err)
	}
	canonical, err := NewConfig("https://{site}.example.net:00443", "https://app.example.com:443", "127.0.0.1:18081", key, false)
	if err != nil || canonical.OriginTemplate != "https://{site}.example.net" || canonical.AppOrigin != "https://app.example.com" {
		t.Fatal("browser origin and configured origin diverged", err)
	}
}
