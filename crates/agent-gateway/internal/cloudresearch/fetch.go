package cloudresearch

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

type FetchConfig struct {
	Limits  Limits
	Network Network
}
type Fetcher struct {
	limits  Limits
	network Network
	gate    chan struct{}
	now     func() time.Time
}

func NewFetcher(config FetchConfig) (*Fetcher, error) {
	limits, err := normalizedLimits(config.Limits)
	if err != nil {
		return nil, err
	}
	return &Fetcher{limits: limits, network: normalizedNetwork(config.Network), gate: make(chan struct{}, limits.MaxConcurrent), now: time.Now}, nil
}

func (f *Fetcher) Fetch(parent context.Context, rawURL string) (Document, error) {
	if f == nil {
		return Document{}, ErrInvalidConfig
	}
	if err := acquire(parent, f.gate); err != nil {
		return Document{}, err
	}
	defer func() { <-f.gate }()
	ctx, cancel := context.WithTimeout(parent, f.limits.Timeout)
	defer cancel()
	u, err := NormalizeURL(rawURL)
	if err != nil {
		return Document{}, err
	}
	requested := u.String()
	for redirects := 0; ; redirects++ {
		client, closeTransport, err := pinnedClient(ctx, u, f.network, f.limits)
		if err != nil {
			return Document{}, safeError(ctx, err)
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			closeTransport()
			return Document{}, ErrInvalidInput
		}
		request.Header.Set("User-Agent", "ZeroAgent-CloudResearch/1")
		request.Header.Set("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9")
		request.Header.Set("Accept-Encoding", "gzip")
		response, err := client.Do(request)
		if err != nil {
			closeTransport()
			return Document{}, safeError(ctx, err)
		}
		if isRedirect(response.StatusCode) {
			location := response.Header.Get("Location")
			response.Body.Close()
			closeTransport()
			if redirects >= 3 {
				return Document{}, ErrRedirectLimit
			}
			next, parseErr := url.Parse(location)
			if parseErr != nil || location == "" {
				return Document{}, ErrInvalidResponse
			}
			u, err = NormalizeURL(u.ResolveReference(next).String())
			if err != nil {
				return Document{}, err
			}
			continue
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			closeTransport()
			return Document{}, responseError(response.StatusCode)
		}
		body, err := readBody(ctx, response, f.limits)
		response.Body.Close()
		closeTransport()
		if err != nil {
			return Document{}, safeError(ctx, err)
		}
		contentType, params, typeErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if typeErr != nil {
			return Document{}, ErrUnsupportedContent
		}
		charset := strings.ToLower(params["charset"])
		if charset != "" && charset != "utf-8" && charset != "utf8" && charset != "us-ascii" {
			return Document{}, ErrUnsupportedContent
		}
		if !utf8.Valid(body) {
			return Document{}, ErrUnsupportedContent
		}
		var text, title string
		var truncated bool
		switch strings.ToLower(contentType) {
		case "text/html", "application/xhtml+xml":
			text, title, truncated, err = extractHTML(ctx, body, f.limits)
		case "text/plain", "text/markdown", "text/csv", "application/json":
			text, truncated = extractPlain(body, f.limits)
		default:
			return Document{}, ErrUnsupportedContent
		}
		if err != nil {
			return Document{}, safeError(ctx, err)
		}
		if ctx.Err() != nil {
			return Document{}, ctx.Err()
		}
		if text == "" {
			return Document{}, ErrNoContent
		}
		textHash := sha256.Sum256([]byte(text))
		bodyHash := sha256.Sum256(body)
		lines := strings.Split(text, "\n")
		numbered := make([]Line, len(lines))
		for i, line := range lines {
			numbered[i] = Line{Number: i + 1, Text: line}
		}
		return Document{RequestedURL: requested, FinalURL: u.String(), Title: title, Text: text, Lines: numbered, SHA256: hex.EncodeToString(textHash[:]), BodySHA256: hex.EncodeToString(bodyHash[:]), FetchedAt: f.now().UTC(), Truncated: truncated, Untrusted: true}, nil
	}
}

func isRedirect(status int) bool {
	return status == 301 || status == 302 || status == 303 || status == 307 || status == 308
}
func responseError(status int) error {
	if status == 401 || status == 403 {
		return ErrAccessDenied
	}
	if status == 429 {
		return ErrThrottled
	}
	return ErrUnavailable
}

func readBody(ctx context.Context, response *http.Response, limits Limits) ([]byte, error) {
	if response.ContentLength > int64(limits.MaxWireBytes) {
		return nil, ErrTooLarge
	}
	wire, err := io.ReadAll(io.LimitReader(response.Body, int64(limits.MaxWireBytes)+1))
	if err != nil {
		return nil, safeError(ctx, err)
	}
	if len(wire) > limits.MaxWireBytes {
		return nil, ErrTooLarge
	}
	if response.ContentLength >= 0 && int64(len(wire)) != response.ContentLength {
		return nil, ErrInvalidResponse
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	encoding := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Encoding")))
	if encoding == "" || encoding == "identity" {
		if len(wire) > limits.MaxResponseBytes {
			return nil, ErrTooLarge
		}
		return wire, nil
	}
	if encoding != "gzip" {
		return nil, ErrUnsupportedContent
	}
	reader, err := gzip.NewReader(bytes.NewReader(wire))
	if err != nil {
		return nil, ErrInvalidResponse
	}
	defer reader.Close()
	decoded, err := io.ReadAll(io.LimitReader(reader, int64(limits.MaxResponseBytes)+1))
	if len(decoded) > limits.MaxResponseBytes {
		return nil, ErrTooLarge
	}
	if err != nil {
		return nil, ErrInvalidResponse
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return decoded, nil
}
