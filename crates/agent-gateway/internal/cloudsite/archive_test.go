package cloudsite

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"os"
	"testing"
)

func sampleArchive(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	out := &bytes.Buffer{}
	writer := zip.NewWriter(out)
	for name, data := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}
func TestStaticSiteManifestAndResourceIntegrity(t *testing.T) {
	data := sampleArchive(t, map[string][]byte{"index.html": []byte(`<html><script src="./assets/app.js"></script><h1>资料空间</h1></html>`), "assets/app.js": []byte(`document.querySelector("h1").textContent="完成"`), "资料/说明.txt": []byte("中文")})
	m, err := Inspect(bytes.NewReader(data), int64(len(data)), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Entries) != 3 || m.EntryPoint != "index.html" || m.Format != 1 {
		t.Fatal("incomplete manifest")
	}
	for _, entry := range m.Entries {
		body, err := ReadEntry(bytes.NewReader(data), int64(len(data)), entry)
		if err != nil || int64(len(body)) != entry.Size {
			t.Fatal("resource mismatch", err)
		}
	}
	entry := m.Entries[0]
	entry.SHA256 = string(bytes.Repeat([]byte("0"), 64))
	if _, err = ReadEntry(bytes.NewReader(data), int64(len(data)), entry); err == nil {
		t.Fatal("changed digest accepted")
	}
}
func TestStaticSiteRejectsUnsafeOrUnboundedBundles(t *testing.T) {
	for _, name := range []string{"../app.js", "/app.js", "a\\app.js", "a/%2e/app.js", ".env", "node_modules/app.js", "config/private.key", "assets/server.php"} {
		t.Run(name, func(t *testing.T) {
			data := sampleArchive(t, map[string][]byte{"index.html": []byte("hello"), name: []byte("payload")})
			if _, err := Inspect(bytes.NewReader(data), int64(len(data)), ""); err == nil {
				t.Fatal("unsafe bundle accepted")
			}
		})
	}
	for _, files := range []map[string][]byte{{"app.js": []byte("no entry")}, {"index.html": {}}, {"index.html": []byte("hello"), "A.js": []byte("a"), "a.js": []byte("b")}, {"index.html": bytes.Repeat([]byte("a"), int(MaxEntryBytes+1))}} {
		data := sampleArchive(t, files)
		if _, err := Inspect(bytes.NewReader(data), int64(len(data)), ""); err == nil {
			t.Fatal("invalid bundle accepted")
		}
	}
	data := sampleArchive(t, map[string][]byte{"index.html": []byte("hello"), "app.js": []byte("world")})
	for _, kind := range []string{"dishonest count", "encrypted", "local path mismatch", "truncated"} {
		copy := append([]byte{}, data...)
		end := len(copy) - 22
		central := int(binary.LittleEndian.Uint32(copy[end+16:]))
		switch kind {
		case "dishonest count":
			binary.LittleEndian.PutUint16(copy[end+8:], 1)
			binary.LittleEndian.PutUint16(copy[end+10:], 1)
		case "encrypted":
			copy[central+8] |= 1
		case "local path mismatch":
			copy[30] ^= 1
		case "truncated":
			copy = copy[:len(copy)-1]
		}
		if _, err := Inspect(bytes.NewReader(copy), int64(len(copy)), ""); err == nil {
			t.Fatal(kind, "accepted")
		}
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	header := &zip.FileHeader{Name: "index.html", Method: zip.Store}
	header.SetMode(os.ModeSymlink | 0777)
	entry, _ := writer.CreateHeader(header)
	_, _ = entry.Write([]byte("other.html"))
	_ = writer.Close()
	if _, err := Inspect(bytes.NewReader(out.Bytes()), int64(out.Len()), ""); err == nil {
		t.Fatal("symlink accepted")
	}
}
