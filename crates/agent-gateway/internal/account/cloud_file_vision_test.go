package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// A fixed one-pixel PNG byte fixture. Gateway tests never invoke a pixel decoder.
func cloudVisionFixture(t *testing.T) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestCloudFileVisionReadyUsesVerifiedOriginalBytesWithoutFakeOCR(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	original := cloudVisionFixture(t)
	file := f.upload(t, "picture.png", original)
	if file.State != CloudFileVisionReady || file.TextBytes != 0 || file.ProcessingStage != "vision_ready" {
		t.Fatalf("image not explicitly vision-ready: %+v", file)
	}
	content := cloudJSON([]any{map[string]any{"type": "file_reference", "file_id": file.ID, "name": "forged.png", "text": "forged OCR"}})
	canonical, err := f.service.canonicalCloudFileReferences(context.Background(), 1, content)
	if err != nil {
		t.Fatal(err)
	}
	messages, code := f.service.cloudModelMessages(context.Background(), 1, []CloudMessage{{Role: "user", Content: canonical}})
	if code != "" {
		t.Fatal(code)
	}
	encoded := string(cloudJSON(messages))
	if strings.Contains(encoded, "forged OCR") || strings.Contains(encoded, "L1:") || strings.Contains(encoded, "accounts/") {
		t.Fatal("forged text/internal key entered image context")
	}
	parts, ok := messages[1]["content"].([]any)
	if !ok {
		t.Fatal("missing multimodal message")
	}
	image := parts[len(parts)-1].(map[string]any)["image_url"].(map[string]any)["url"].(string)
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(image, "data:image/png;base64,"))
	if err != nil || !bytes.Equal(decoded, original) {
		t.Fatal("original image bytes changed")
	}
	status, _, _ := f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/content", "file-owner", nil, nil)
	if status != http.StatusConflict {
		t.Fatal("image falsely exposed as parsed text")
	}
	if _, err = f.service.canonicalCloudFileReferences(context.Background(), 2, content); err == nil {
		t.Fatal("foreign image reference accepted")
	}
	f.mu.Lock()
	f.corruptGet = true
	f.mu.Unlock()
	if _, code = f.service.cloudModelMessages(context.Background(), 1, []CloudMessage{{Role: "user", Content: canonical}}); code != "image_unavailable" {
		t.Fatal("corrupt image reached model")
	}
}

func TestCloudFileVisionSizeAndAggregateContextAreBounded(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	original := cloudVisionFixture(t)
	large := append(append([]byte(nil), original...), make([]byte, CloudFileMaxVisionBytes-len(original)+1)...)
	file := f.upload(t, "large.png", large)
	if file.State != CloudFileUploaded || file.ProcessingStage != "workspace_only" || file.TextBytes != 0 {
		t.Fatal("oversized inline image accepted")
	}
	if _, err := f.service.canonicalCloudFileReferences(context.Background(), 1, cloudJSON([]any{map[string]any{"type": "file_reference", "file_id": file.ID}})); err == nil {
		t.Fatal("oversized image reference accepted")
	}
	small := f.upload(t, "small.png", original)
	canonical, err := f.service.canonicalCloudFileReferences(context.Background(), 1, cloudJSON([]any{map[string]any{"type": "file_reference", "file_id": small.ID}}))
	if err != nil {
		t.Fatal(err)
	}
	if _, code := f.service.cloudModelMessages(context.Background(), 1, []CloudMessage{{Role: "user", Content: cloudJSON(strings.Repeat("x", CloudRunMaxInputBytes-32))}, {Role: "user", Content: canonical}}); code != "context_limit" {
		t.Fatal("image aggregate context not bounded")
	}
}

func TestCloudFileVisionPostgresState(t *testing.T) {
	fixture := cloudRunPostgresFixture(t)
	store := fixture.store.(*PersistentStore)
	if _, err := store.db.Exec(CloudFileSchema); err != nil {
		t.Fatal(err)
	}
	conversation := &CloudConversation{ID: uuid.NewString(), UserID: 41}
	if err := store.PutCloudConversation(context.Background(), conversation); err != nil {
		t.Fatal(err)
	}
	input := newCloudFileRecord(41, conversation.ID)
	input.Name = "image.png"
	input.MIME = "image/png"
	file, err := store.CreateCloudFile(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	file, err = store.UpdateCloudFile(context.Background(), 41, file.ID, file.Version, CloudFileUpdate{State: CloudFileUploaded, MarkUploaded: true})
	if err != nil {
		t.Fatal(err)
	}
	file, err = store.UpdateCloudFile(context.Background(), 41, file.ID, file.Version, CloudFileUpdate{State: CloudFileVisionReady, ProcessingStage: "vision_ready"})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetCloudFile(context.Background(), 41, file.ID)
	if err != nil || stored.State != CloudFileVisionReady || stored.Text != "" || len(stored.Segments) != 0 {
		t.Fatalf("invalid persisted vision state: %+v %v", stored, err)
	}
	metadata, _ := json.Marshal(stored)
	if strings.Contains(string(metadata), "parser_task") {
		t.Fatal("private task leaked")
	}
}
