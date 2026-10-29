package cloudresearch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"testing"
)

// Optional free public-page smoke test. No search provider, model, account,
// cookie, uploaded content or sandbox credential is used or transmitted.
func TestLivePublicPage(t *testing.T) {
	if os.Getenv("ZEROAGENT_CLOUD_RESEARCH_LIVE_TEST") != "1" {
		t.Skip("explicit public-page network smoke not requested")
	}
	fetcher, err := NewFetcher(FetchConfig{})
	if err != nil {
		t.Fatal(err)
	}
	document, err := fetcher.Fetch(context.Background(), "https://example.com/")
	if err != nil {
		t.Fatalf("public-page network smoke: %v", err)
	}
	// The page's body copy changes independently of this transport. Check the
	// extracted title and retained body separately rather than inventing a heading.
	if !document.Untrusted || len(document.Lines) == 0 || !strings.Contains(document.Title, "Example Domain") {
		t.Fatal("public page was not retained as verifiable evidence")
	}
	digest := sha256.Sum256([]byte(document.Text))
	if document.SHA256 != hex.EncodeToString(digest[:]) {
		t.Fatal("public page text digest mismatch")
	}
	t.Logf("public page retained: lines=%d bytes=%d truncated=%t", len(document.Lines), len(document.Text), document.Truncated)
}
