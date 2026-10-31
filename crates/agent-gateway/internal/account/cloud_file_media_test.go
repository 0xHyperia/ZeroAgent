package account

import (
	"bytes"
	"context"
	"encoding/binary"
	"strings"
	"testing"
)

func TestCloudFileMediaOriginalsDoNotPretendToBeExtracted(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	wav := make([]byte, 48)
	copy(wav, "RIFF")
	binary.LittleEndian.PutUint32(wav[4:], 40)
	copy(wav[8:], "WAVEfmt ")
	inputs := []struct {
		name, mime string
		body       []byte
	}{
		{"tone.wav", "audio/wav", wav},
		{"movie.mp4", "video/mp4", append([]byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'}, make([]byte, 12)...)},
		{"vector.svg", "image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>untrusted()</script></svg>`)},
	}
	for _, input := range inputs {
		t.Run(input.name, func(t *testing.T) {
			file := f.upload(t, input.name, input.body)
			if file.State != CloudFileUploaded || file.ProcessingStage != "workspace_only" || file.TextBytes != 0 || file.MIME != input.mime {
				t.Fatal("media upload claimed extraction or vision capability")
			}
			if _, err := f.service.canonicalCloudFileReferences(context.Background(), 1, cloudJSON([]any{map[string]any{"type": "file_reference", "file_id": file.ID}})); err == nil {
				t.Fatal("media reached model without isolated workspace authority")
			}
			status, body, headers := f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/download", "file-owner", nil, nil)
			if status != 200 || !bytes.Equal(body, input.body) || headers.Get("Content-Type") != input.mime || !strings.HasPrefix(headers.Get("Content-Disposition"), "attachment;") || headers.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(headers.Get("Content-Security-Policy"), "sandbox") {
				t.Fatal("media was inlined or original bytes changed")
			}
		})
	}
	for _, name := range []string{"bad.wav", "bad.mp4", "bad.svg", "bad.avif", "bad.webm"} {
		if _, _, err := cloudFileFormat(name, []byte("disguised content")); err == nil {
			t.Fatalf("extension alone authorized %s", name)
		}
	}
}
