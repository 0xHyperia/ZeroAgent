package cloudsite

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/publicsuffix"
)

var siteIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

type Config struct {
	OriginTemplate string
	AppOrigin      string
	ListenAddr     string
	key            []byte
}

func ConfigFromEnv(getenv func(string) string, appOrigin string) (*Config, error) {
	return NewConfig(getenv("ZEROAGENT_SITE_ORIGIN_TEMPLATE"), appOrigin, getenv("ZEROAGENT_SITE_LISTEN_ADDR"), getenv("ZEROAGENT_SITE_SIGNING_KEY"), getenv("ZEROAGENT_SITE_ALLOW_LOCALHOST_HTTP") == "true")
}
func NewConfig(template, appOrigin, listen, key string, allowLocal bool) (*Config, error) {
	if template == "" && listen == "" && key == "" {
		return nil, nil
	}
	if strings.Count(template, "{site}") != 1 || len(key) < 32 || len(key) > 256 || strings.TrimSpace(key) != key {
		return nil, ErrInvalid
	}
	host, port, err := net.SplitHostPort(listen)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() || !validPort(port) {
		return nil, ErrInvalid
	}
	sample := strings.Replace(template, "{site}", strings.Repeat("0", 32), 1)
	content, err := parseOrigin(sample)
	if err != nil {
		return nil, err
	}
	app, err := parseOrigin(appOrigin)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(content.Hostname(), strings.Repeat("0", 32)+".") {
		return nil, ErrInvalid
	}
	base := strings.TrimPrefix(content.Hostname(), strings.Repeat("0", 32)+".")
	local := allowLocal && isLocalHost(base) && isLocalHost(app.Hostname())
	if !local {
		if content.Scheme != "https" || app.Scheme != "https" {
			return nil, ErrInvalid
		}
		contentDomain, e1 := publicsuffix.EffectiveTLDPlusOne(base)
		appDomain, e2 := publicsuffix.EffectiveTLDPlusOne(app.Hostname())
		if e1 != nil || e2 != nil || contentDomain == appDomain {
			return nil, ErrInvalid
		}
	}
	if (content.Scheme == "http" || app.Scheme == "http") && !local {
		return nil, ErrInvalid
	}
	return &Config{OriginTemplate: strings.Replace(content.String(), strings.Repeat("0", 32), "{site}", 1), AppOrigin: app.String(), ListenAddr: listen, key: []byte(key)}, nil
}
func parseOrigin(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || strings.Contains(u.Hostname(), "%") || strings.HasSuffix(u.Hostname(), ".") {
		return nil, ErrInvalid
	}
	if strings.HasSuffix(u.Host, ":") || u.Port() != "" && !validPort(u.Port()) {
		return nil, ErrInvalid
	}
	hostname := strings.ToLower(u.Hostname())
	if net.ParseIP(hostname) == nil {
		if len(hostname) > 253 {
			return nil, ErrInvalid
		}
		for _, label := range strings.Split(hostname, ".") {
			if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return nil, ErrInvalid
			}
			for _, r := range label {
				if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
					return nil, ErrInvalid
				}
			}
		}
	}
	u.Path = ""
	port := u.Port()
	if port != "" {
		number, _ := strconv.Atoi(port)
		port = strconv.Itoa(number)
	}
	if u.Scheme == "https" && port == "443" || u.Scheme == "http" && port == "80" {
		port = ""
	}
	u.Host = hostname
	if port != "" {
		u.Host = net.JoinHostPort(hostname, port)
	} else if strings.Contains(hostname, ":") {
		u.Host = "[" + hostname + "]"
	}
	return u, nil
}
func validPort(value string) bool {
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
func isLocalHost(host string) bool {
	return host == "localhost" || strings.HasSuffix(host, ".localhost") || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}
func (c *Config) Origin(siteID string) (string, error) {
	id := strings.ReplaceAll(siteID, "-", "")
	if c == nil || !siteIDPattern.MatchString(id) {
		return "", ErrInvalid
	}
	return strings.Replace(c.OriginTemplate, "{site}", id, 1), nil
}
func (c *Config) Token(id, binding string) (string, error) {
	raw := strings.ReplaceAll(id, "-", "")
	if c == nil || !siteIDPattern.MatchString(raw) {
		return "", ErrInvalid
	}
	mac := hmac.New(sha256.New, c.key)
	_, _ = mac.Write([]byte(raw + "\n" + binding))
	return raw + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
func GrantID(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 || !siteIDPattern.MatchString(parts[0]) {
		return "", ErrInvalid
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(signature) != 32 {
		return "", ErrInvalid
	}
	bytes, err := hex.DecodeString(parts[0])
	if err != nil {
		return "", ErrInvalid
	}
	return hex.EncodeToString(bytes[:4]) + "-" + hex.EncodeToString(bytes[4:6]) + "-" + hex.EncodeToString(bytes[6:8]) + "-" + hex.EncodeToString(bytes[8:10]) + "-" + hex.EncodeToString(bytes[10:]), nil
}
func (c *Config) VerifyToken(token, id, binding string) bool {
	expected, err := c.Token(id, binding)
	return err == nil && hmac.Equal([]byte(expected), []byte(token))
}
