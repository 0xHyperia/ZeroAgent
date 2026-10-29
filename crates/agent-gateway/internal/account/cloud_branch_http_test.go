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

func TestCloudBranchHTTPAndExportKeepOriginalAndOwner(t *testing.T) {
	service, store, handler := newAccountTestRuntime(t)
	ctx := context.Background()
	for _, id := range []string{"branch-owner", "branch-other"} {
		owner := int64(1)
		if id == "branch-other" {
			owner = 2
		}
		if err := store.PutSession(ctx, &Session{ID: id, UserID: owner, AccessToken: "synthetic-account", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
	}
	conversation, err := service.CreateCloudConversation(ctx, 1, "synthetic")
	if err != nil {
		t.Fatal(err)
	}
	user := CloudMessage{ID: uuid.NewString(), ConversationID: conversation.ID, UserID: 1, Role: "user", Content: cloudJSON("原问题"), CreatedAt: time.Now().Add(-time.Second)}
	assistant := CloudMessage{ID: uuid.NewString(), ConversationID: conversation.ID, UserID: 1, Role: "assistant", Content: cloudJSON("原答案"), CreatedAt: time.Now()}
	for _, m := range []*CloudMessage{&user, &assistant} {
		if err = store.AddCloudMessage(ctx, m); err != nil {
			t.Fatal(err)
		}
	}
	request := func(method, path, owner, body, origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: owner})
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	input := CloudBranchInput{ClientRequestID: uuid.NewString(), MessageID: user.ID, Action: "regenerate"}
	path := "/api/web-chat/conversations/" + conversation.ID + "/branch"
	body := string(cloudJSON(input))
	for i, want := range []int{201, 200} {
		rec := request("POST", path, "branch-owner", body, "")
		if rec.Code != want {
			t.Fatalf("attempt %d status=%d body=%s", i, rec.Code, rec.Body.String())
		}
	}
	lookup := request("GET", "/api/web-chat/branches/"+input.ClientRequestID, "branch-owner", "", "")
	var result struct {
		Branch CloudBranch `json:"branch"`
	}
	if lookup.Code != 200 || json.Unmarshal(lookup.Body.Bytes(), &result) != nil || result.Branch.Conversation == nil || string(result.Branch.DraftContent) != `"原问题"` {
		t.Fatal("branch lookup did not recover accepted result")
	}
	for _, target := range []string{path, "/api/web-chat/branches/" + input.ClientRequestID, "/api/web-chat/conversations/" + conversation.ID + "/export?format=json"} {
		method := "GET"
		payload := ""
		if target == path {
			method = "POST"
			payload = body
		}
		if rec := request(method, target, "branch-other", payload, ""); rec.Code != 404 {
			t.Fatalf("foreign route disclosed resource status=%d", rec.Code)
		}
	}
	for _, format := range []string{"json", "markdown"} {
		rec := request("GET", "/api/web-chat/conversations/"+conversation.ID+"/export?format="+format, "branch-owner", "", "")
		if rec.Code != 200 || !strings.Contains(rec.Header().Get("Content-Disposition"), "attachment") || !strings.Contains(rec.Body.String(), "原答案") || rec.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatal("export missing canonical contents or private download headers")
		}
	}
	if rec := request("POST", path, "branch-owner", body+` {}`, ""); rec.Code != 400 {
		t.Fatal("trailing branch JSON accepted")
	}
	if rec := request("POST", path, "branch-owner", body, "https://foreign.invalid"); rec.Code != 403 {
		t.Fatal("cross-origin branch accepted")
	}
	original, _ := store.ListCloudMessages(ctx, 1, conversation.ID)
	if len(original) != 2 || original[0].ID != user.ID || original[1].ID != assistant.ID {
		t.Fatal("branching changed original")
	}
}
