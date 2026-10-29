// Package objectstore implements bounded, explicitly configured S3 object access.
// Resource ownership and the mapping from a file ID to its opaque key belong to
// the authenticated account service, never to a browser-supplied object key.
package objectstore

import (
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultMaxObjectBytes int64 = 64 << 20
	MaximumObjectBytes    int64 = 1 << 30
	DefaultPresignTTL           = 5 * time.Minute
	MaximumPresignTTL           = 15 * time.Minute
)

type Config struct {
	Endpoint          string
	Bucket            string
	Region            string
	AccessKeyID       string `json:"-"`
	SecretAccessKey   string `json:"-"`
	AllowLoopbackHTTP bool
	MaxObjectBytes    int64
	RequestTimeout    time.Duration
	// TempDir optionally selects a private upload staging directory. Temporary
	// files are bounded, opened with mode 0600, and removed by the owning call.
	TempDir string
}

type Status struct {
	Enabled bool     `json:"enabled"`
	Reason  string   `json:"reason,omitempty"`
	Missing []string `json:"missing,omitempty"`
}

func (Config) String() string   { return "objectstore.Config(credentials redacted)" }
func (Config) GoString() string { return "objectstore.Config(credentials redacted)" }

// ConfigFromEnv reads only the named application settings. It deliberately does
// not use AWS profiles, default credential chains, metadata services or AWS_*.
func ConfigFromEnv(getenv func(string) string) (Config, error) {
	if getenv == nil {
		return Config{}, ErrInvalidConfig
	}
	cfg := Config{
		Endpoint:        strings.TrimSpace(getenv("ZEROAGENT_OBJECT_STORAGE_ENDPOINT")),
		Bucket:          strings.TrimSpace(getenv("ZEROAGENT_OBJECT_STORAGE_BUCKET")),
		Region:          strings.TrimSpace(getenv("ZEROAGENT_OBJECT_STORAGE_REGION")),
		AccessKeyID:     strings.TrimSpace(getenv("ZEROAGENT_OBJECT_STORAGE_ACCESS_KEY_ID")),
		SecretAccessKey: getenv("ZEROAGENT_OBJECT_STORAGE_SECRET_ACCESS_KEY"),
	}
	if value := strings.TrimSpace(getenv("ZEROAGENT_OBJECT_STORAGE_ALLOW_LOOPBACK_HTTP")); value != "" {
		var err error
		cfg.AllowLoopbackHTTP, err = strconv.ParseBool(value)
		if err != nil {
			return Config{}, ErrInvalidConfig
		}
	}
	if value := strings.TrimSpace(getenv("ZEROAGENT_OBJECT_STORAGE_MAX_BYTES")); value != "" {
		var err error
		cfg.MaxObjectBytes, err = strconv.ParseInt(value, 10, 64)
		if err != nil || cfg.MaxObjectBytes <= 0 || cfg.MaxObjectBytes > MaximumObjectBytes {
			return Config{}, ErrInvalidConfig
		}
	}
	return cfg, nil
}

var (
	bucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	regionPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$`)
	keyPattern    = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/-]*$`)
	metaPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
)

func normalizedConfig(cfg Config) (Config, Status, error) {
	if cfg.MaxObjectBytes == 0 {
		cfg.MaxObjectBytes = DefaultMaxObjectBytes
	}
	if cfg.MaxObjectBytes < 0 || cfg.MaxObjectBytes > MaximumObjectBytes {
		return Config{}, Status{}, ErrInvalidConfig
	}
	if cfg.RequestTimeout == 0 {
		cfg.RequestTimeout = 2 * time.Minute
	}
	if cfg.RequestTimeout < time.Second || cfg.RequestTimeout > 10*time.Minute {
		return Config{}, Status{}, ErrInvalidConfig
	}
	missing := []string{}
	for _, field := range []struct{ name, value string }{
		{"ZEROAGENT_OBJECT_STORAGE_ENDPOINT", cfg.Endpoint},
		{"ZEROAGENT_OBJECT_STORAGE_BUCKET", cfg.Bucket},
		{"ZEROAGENT_OBJECT_STORAGE_REGION", cfg.Region},
		{"ZEROAGENT_OBJECT_STORAGE_ACCESS_KEY_ID", cfg.AccessKeyID},
		{"ZEROAGENT_OBJECT_STORAGE_SECRET_ACCESS_KEY", cfg.SecretAccessKey},
	} {
		if strings.TrimSpace(field.value) == "" {
			missing = append(missing, field.name)
		}
	}
	if len(missing) != 0 {
		return cfg, Status{Reason: "missing_configuration", Missing: missing}, nil
	}
	endpoint, err := url.Parse(cfg.Endpoint)
	if err != nil || endpoint.Opaque != "" || endpoint.Host == "" || endpoint.Hostname() == "" || endpoint.User != nil ||
		endpoint.RawQuery != "" || endpoint.ForceQuery || endpoint.Fragment != "" ||
		(endpoint.Path != "" && endpoint.Path != "/") || endpoint.RawPath != "" ||
		strings.Contains(endpoint.Hostname(), "%") || strings.HasSuffix(endpoint.Host, ":") {
		return Config{}, Status{}, ErrInvalidConfig
	}
	if port := endpoint.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return Config{}, Status{}, ErrInvalidConfig
		}
	}
	if endpoint.Scheme != "https" {
		ip := net.ParseIP(endpoint.Hostname())
		if endpoint.Scheme != "http" || !cfg.AllowLoopbackHTTP || ip == nil || !ip.IsLoopback() {
			return Config{}, Status{}, ErrInvalidConfig
		}
	}
	if !bucketPattern.MatchString(cfg.Bucket) || strings.Contains(cfg.Bucket, "..") ||
		strings.Contains(cfg.Bucket, ".-") || strings.Contains(cfg.Bucket, "-.") ||
		net.ParseIP(cfg.Bucket) != nil || strings.HasSuffix(cfg.Bucket, "--x-s3") ||
		!regionPattern.MatchString(cfg.Region) || strings.ContainsAny(cfg.AccessKeyID, " \t\r\n") ||
		strings.ContainsAny(cfg.SecretAccessKey, "\r\n\x00") {
		return Config{}, Status{}, ErrInvalidConfig
	}
	cfg.Endpoint = strings.TrimSuffix(endpoint.String(), "/")
	return cfg, Status{Enabled: true}, nil
}

func validateKey(key string) error {
	if len(key) > 1024 || !keyPattern.MatchString(key) || strings.HasSuffix(key, "/") {
		return ErrInvalidKey
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return ErrInvalidKey
		}
	}
	return nil
}

func presignTTL(ttl time.Duration) (time.Duration, error) {
	if ttl == 0 {
		ttl = DefaultPresignTTL
	}
	if ttl < time.Second || ttl > MaximumPresignTTL || ttl%time.Second != 0 {
		return 0, ErrInvalidInput
	}
	return ttl, nil
}
