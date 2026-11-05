package config

import (
	"flag"
	"io"
	"os"
	"testing"
	"time"
)

func TestLoadNormalizesTLSPaths(t *testing.T) {
	t.Setenv("ZEROAGENT_GATEWAY_TLS_CERT", " cert.pem ")
	t.Setenv("ZEROAGENT_GATEWAY_TLS_KEY", "\tkey.pem\r\n")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.TLSCert != "cert.pem" {
		t.Fatalf("TLSCert = %q, want %q", cfg.TLSCert, "cert.pem")
	}
	if cfg.TLSKey != "key.pem" {
		t.Fatalf("TLSKey = %q, want %q", cfg.TLSKey, "key.pem")
	}
}

func TestPublicEnvironmentUsesZeroAgentNamespace(t *testing.T) {
	t.Setenv("LIVEAGENT_GATEWAY_HTTP_ADDR", "127.0.0.1:12345")
	t.Setenv("ZEROAGENT_GATEWAY_HTTP_ADDR", "127.0.0.1:54321")
	resetFlagsForTest(t)
	if got := Load().HTTPAddr; got != "127.0.0.1:54321" {
		t.Fatalf("ZeroAgent public address = %q", got)
	}
	t.Setenv("ZEROAGENT_GATEWAY_HTTP_ADDR", "")
	resetFlagsForTest(t)
	if got := Load().HTTPAddr; got == "127.0.0.1:12345" {
		t.Fatal("old public variable unexpectedly overrode the ZeroAgent configuration")
	}
}

func TestLoadWebSocketHeartbeatGrace(t *testing.T) {
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.WebSocketHeartbeatGrace != 5*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace default = %s, want 5s", cfg.WebSocketHeartbeatGrace)
	}

	t.Setenv("ZEROAGENT_GATEWAY_WS_HEARTBEAT_GRACE", "45s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.WebSocketHeartbeatGrace != 45*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace = %s, want 45s", cfg.WebSocketHeartbeatGrace)
	}

	t.Setenv("ZEROAGENT_GATEWAY_WS_HEARTBEAT_GRACE", "-3s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.WebSocketHeartbeatGrace != 5*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace with negative env = %s, want 5s fallback", cfg.WebSocketHeartbeatGrace)
	}
}

func TestLoadChatTimeouts(t *testing.T) {
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.ChatPrepareTimeout != 2*time.Second {
		t.Fatalf("ChatPrepareTimeout default = %s, want 2s", cfg.ChatPrepareTimeout)
	}
	if cfg.ChatDeliveryTimeout != 5*time.Second {
		t.Fatalf("ChatDeliveryTimeout default = %s, want 5s", cfg.ChatDeliveryTimeout)
	}
	if cfg.ChatStartTimeout != 5*time.Second {
		t.Fatalf("ChatStartTimeout default = %s, want 5s", cfg.ChatStartTimeout)
	}
	if cfg.ChatRenderStartTimeout != 10*time.Second {
		t.Fatalf("ChatRenderStartTimeout default = %s, want 10s", cfg.ChatRenderStartTimeout)
	}

	t.Setenv("ZEROAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT", "750ms")
	t.Setenv("ZEROAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT", "3s")
	t.Setenv("ZEROAGENT_GATEWAY_CHAT_START_TIMEOUT", "4s")
	t.Setenv("ZEROAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT", "8s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.ChatPrepareTimeout != 750*time.Millisecond ||
		cfg.ChatDeliveryTimeout != 3*time.Second ||
		cfg.ChatStartTimeout != 4*time.Second ||
		cfg.ChatRenderStartTimeout != 8*time.Second {
		t.Fatalf("custom chat timeouts = prepare:%s delivery:%s start:%s render:%s",
			cfg.ChatPrepareTimeout,
			cfg.ChatDeliveryTimeout,
			cfg.ChatStartTimeout,
			cfg.ChatRenderStartTimeout,
		)
	}

	t.Setenv("ZEROAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT", "-1s")
	t.Setenv("ZEROAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT", "0s")
	t.Setenv("ZEROAGENT_GATEWAY_CHAT_START_TIMEOUT", "-1s")
	t.Setenv("ZEROAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT", "-1s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.ChatPrepareTimeout != 2*time.Second ||
		cfg.ChatDeliveryTimeout != 5*time.Second ||
		cfg.ChatStartTimeout != 5*time.Second ||
		cfg.ChatRenderStartTimeout != 10*time.Second {
		t.Fatalf("normalized chat timeouts = prepare:%s delivery:%s start:%s render:%s",
			cfg.ChatPrepareTimeout,
			cfg.ChatDeliveryTimeout,
			cfg.ChatStartTimeout,
			cfg.ChatRenderStartTimeout,
		)
	}
}

func TestLoadUsesRailwayPortForHTTPDefault(t *testing.T) {
	t.Setenv("PORT", "8080")

	resetFlagsForTest(t)
	cfg := Load()

	if cfg.HTTPAddr != ":8080" {
		t.Fatalf("HTTPAddr = %q, want :8080", cfg.HTTPAddr)
	}
}

func TestLoadUsesStandaloneDevelopmentDefaults(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("ZEROAGENT_GATEWAY_HTTP_ADDR", "")
	t.Setenv("ZEROAGENT_GATEWAY_COOKIE_SECURE", "")
	t.Setenv("ZEROAGENT_GATEWAY_TLS_CERT", "")
	t.Setenv("ZEROAGENT_GATEWAY_TLS_KEY", "")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.HTTPAddr != ":3001" {
		t.Fatalf("HTTPAddr = %q, want :3001", cfg.HTTPAddr)
	}
	if cfg.CookieSecure {
		t.Fatal("CookieSecure = true, want false for standalone HTTP development")
	}
}

func TestLoadReadsGatewayPublicOrigin(t *testing.T) {
	t.Setenv("USA_ZERO_ORIGIN", " http://127.0.0.1:8080/ ")
	t.Setenv("USA_ZERO_AUTHORIZATION_ORIGIN", " http://127.0.0.1:5173/ ")
	t.Setenv("ZEROAGENT_GATEWAY_PUBLIC_ORIGIN", " https://gateway.example.com ")
	t.Setenv("ZEROAGENT_WEB_OAUTH_CLIENT_SECRET", " zeroagent-test-web-client-secret-32-bytes ")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.PublicOrigin != "https://gateway.example.com" {
		t.Fatalf("PublicOrigin = %q", cfg.PublicOrigin)
	}
	if cfg.USAZeroOrigin != "http://127.0.0.1:8080" || cfg.USAZeroAuthorizationOrigin != "http://127.0.0.1:5173" {
		t.Fatalf("USA-Zero origins were not normalized: api=%q authorization=%q", cfg.USAZeroOrigin, cfg.USAZeroAuthorizationOrigin)
	}
	if cfg.OAuthWebClientSecret != "zeroagent-test-web-client-secret-32-bytes" {
		t.Fatalf("OAuthWebClientSecret was not normalized")
	}
}

func TestLoadDefaultsAuthorizationOriginToAPIOrigin(t *testing.T) {
	t.Setenv("USA_ZERO_ORIGIN", "https://usa.example.com/")
	t.Setenv("USA_ZERO_AUTHORIZATION_ORIGIN", "")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.USAZeroAuthorizationOrigin != "https://usa.example.com" {
		t.Fatalf("USAZeroAuthorizationOrigin = %q", cfg.USAZeroAuthorizationOrigin)
	}
}

func resetFlagsForTest(t *testing.T) {
	t.Helper()
	oldCommandLine := flag.CommandLine
	oldArgs := os.Args
	t.Cleanup(func() {
		flag.CommandLine = oldCommandLine
		os.Args = oldArgs
	})

	flag.CommandLine = flag.NewFlagSet("gateway", flag.ContinueOnError)
	flag.CommandLine.SetOutput(io.Discard)
	os.Args = []string{"gateway"}
}

func TestLoadModelCatalogURL(t *testing.T) {
	t.Setenv("ZEROAGENT_GATEWAY_MODEL_CATALOG_URL", "")
	resetFlagsForTest(t)
	if cfg := Load(); cfg.ModelCatalogURL != DefaultModelCatalogURL {
		t.Fatalf("default ModelCatalogURL = %q", cfg.ModelCatalogURL)
	}
	t.Setenv("ZEROAGENT_GATEWAY_MODEL_CATALOG_URL", " https://mirror.example/catalog.json ")
	resetFlagsForTest(t)
	if cfg := Load(); cfg.ModelCatalogURL != "https://mirror.example/catalog.json" {
		t.Fatalf("mirror ModelCatalogURL = %q", cfg.ModelCatalogURL)
	}
	t.Setenv("ZEROAGENT_GATEWAY_MODEL_CATALOG_URL", " OFF ")
	resetFlagsForTest(t)
	if cfg := Load(); cfg.ModelCatalogURL != "" {
		t.Fatalf("off ModelCatalogURL = %q", cfg.ModelCatalogURL)
	}
}
