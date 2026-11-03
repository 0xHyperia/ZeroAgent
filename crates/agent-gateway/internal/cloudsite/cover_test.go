package cloudsite

import (
	"bytes"
	"strings"
	"testing"
)

func TestCloudSiteCoverIsRealInertAndManifestBound(t *testing.T) {
	data := sampleArchive(t, map[string][]byte{
		"index.html":      []byte(`<html><head><script>secret()</script><link rel="stylesheet" href="assets/site.css"><meta http-equiv="refresh" content="0;url=https://evil.invalid"></head><body onload="secret()"><h1>真正的首页</h1><img src="assets/photo.png" onerror="secret()"><iframe srcdoc="evil"></iframe><a href="https://evil.invalid">访问</a></body></html>`),
		"assets/site.css": []byte(`h1{color:green}/* </style><meta http-equiv="refresh" content="0;url=https://evil.invalid"> */`), "assets/photo.png": []byte("example-image"),
	})
	m, err := Inspect(bytes.NewReader(data), int64(len(data)), "")
	if err != nil {
		t.Fatal(err)
	}
	cover, err := Cover(data, *m)
	if err != nil {
		t.Fatal(err)
	}
	for _, present := range []string{"真正的首页", "h1{color:green}", "data:image/png;base64,", "default-src 'none'"} {
		if !strings.Contains(cover, present) {
			t.Fatalf("cover missing %q", present)
		}
	}
	for _, forbidden := range []string{"<script", "<iframe", "secret()", "<meta http-equiv=\"refresh\"", "href=\"https://evil.invalid", " onload=", " onerror="} {
		if strings.Contains(cover, forbidden) {
			t.Fatalf("active cover content: %s", forbidden)
		}
	}
	for i := range m.Entries {
		if m.Entries[i].Path == m.EntryPoint {
			m.Entries[i].SHA256 = strings.Repeat("0", 64)
		}
	}
	if _, err = Cover(data, *m); err == nil {
		t.Fatal("changed archive entry accepted")
	}
}
