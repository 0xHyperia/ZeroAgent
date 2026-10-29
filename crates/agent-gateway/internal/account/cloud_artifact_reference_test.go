package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCloudArtifactReferenceCanonicalContextAndBranch(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	publication, _ := artifactPublicationFixture(t, f)
	version, err := f.service.PublishCloudArtifact(context.Background(), 1, publication)
	if err != nil {
		t.Fatal(err)
	}
	raw := cloudJSON([]any{map[string]any{"type": "text", "text": "继续修改此表格"}, map[string]any{"type": "artifact_reference", "version_id": strings.ToUpper(version.ID), "name": "forged-name", "family_id": uuid.NewString(), "number": 999, "text": "forged-content", "sandbox_id": "forged-vm"}})
	validated, err := validateCloudContent(raw)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := f.service.canonicalCloudFileReferences(context.Background(), 1, validated)
	if err != nil {
		t.Fatal(err)
	}
	var parts []map[string]any
	if json.Unmarshal(canonical, &parts) != nil || len(parts) != 2 || len(parts[1]) != 8 || parts[1]["version_id"] != version.ID || parts[1]["family_id"] != version.FamilyID || parts[1]["name"] != version.Name || parts[1]["sha256"] != version.SHA256 || parts[1]["number"] != float64(1) || strings.Contains(string(canonical), "forged") {
		t.Fatal("artifact snapshot trusted client metadata or lost immutable fields")
	}
	expanded, code := f.service.cloudModelMessages(context.Background(), 1, []CloudMessage{{Role: "user", Content: canonical}})
	encoded := string(cloudJSON(expanded))
	if code != "" || strings.Contains(encoded, "artifact_reference") || strings.Contains(encoded, "profit,4") || !strings.Contains(encoded, "artifact_version_id") || !strings.Contains(encoded, version.ID) || !strings.Contains(encoded, version.FamilyID) {
		t.Fatal("artifact provider context was not a controlled metadata-only resource")
	}
	if _, err = f.service.canonicalCloudFileReferences(context.Background(), 2, validated); err == nil {
		t.Fatal("foreign account resolved artifact reference")
	}
	if _, code = f.service.cloudModelMessages(context.Background(), 2, []CloudMessage{{Role: "user", Content: canonical}}); code != "artifact_unavailable" {
		t.Fatal("foreign artifact expanded into model context")
	}
	conversation, err := f.service.CreateCloudConversation(context.Background(), 1, "synthetic")
	if err != nil {
		t.Fatal(err)
	}
	message := CloudMessage{ID: uuid.NewString(), ConversationID: conversation.ID, UserID: 1, Role: "user", Content: cloudJSON("原问题"), CreatedAt: time.Now()}
	if err = f.store.AddCloudMessage(context.Background(), &message); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, false).registerCloudBranches(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	input := CloudBranchInput{ClientRequestID: uuid.NewString(), MessageID: message.ID, Action: "edit", Content: raw}
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/web-chat/conversations/"+conversation.ID+"/branch", strings.NewReader(string(cloudJSON(input))))
	request.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "file-owner"})
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body struct {
		Branch CloudBranch `json:"branch"`
	}
	if response.StatusCode != 201 || json.NewDecoder(response.Body).Decode(&body) != nil || string(body.Branch.DraftContent) != string(canonical) {
		t.Fatal("edit branch lost canonical typed artifact snapshot")
	}
	if _, err = f.store.DeleteCloudArtifactFamily(context.Background(), 1, version.FamilyID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.canonicalCloudFileReferences(context.Background(), 1, validated); err == nil {
		t.Fatal("deleted version remained referenceable")
	}
	if _, code = f.service.cloudModelMessages(context.Background(), 1, []CloudMessage{{Role: "user", Content: canonical}}); code != "artifact_unavailable" {
		t.Fatal("deleted artifact history expanded")
	}
	input.ClientRequestID = uuid.NewString()
	request, _ = http.NewRequest(http.MethodPost, server.URL+"/api/web-chat/conversations/"+conversation.ID+"/branch", strings.NewReader(string(cloudJSON(input))))
	request.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "file-owner"})
	response, err = server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("deleted artifact branch status=%d", response.StatusCode)
	}
}

func TestCloudReferencesCombinedBoundAndUnknownVersion(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	for _, count := range []int{8, 9} {
		parts := []any{}
		for index := 0; index < count; index++ {
			if index%2 == 0 {
				parts = append(parts, map[string]any{"type": "file_reference", "file_id": uuid.NewString()})
			} else {
				parts = append(parts, map[string]any{"type": "artifact_reference", "version_id": uuid.NewString()})
			}
		}
		_, err := validateCloudContent(cloudJSON(parts))
		if (err != nil) != (count > 8) {
			t.Fatalf("combined reference bound failed at %d", count)
		}
	}
	for _, id := range []string{"invalid-id", uuid.NewString()} {
		content := cloudJSON([]any{map[string]any{"type": "artifact_reference", "version_id": id}})
		if _, err := f.service.canonicalCloudFileReferences(context.Background(), 1, content); err == nil {
			t.Fatal("unknown artifact accepted")
		}
	}
}
