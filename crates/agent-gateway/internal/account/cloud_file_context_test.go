package account

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestCloudFileContextUsesOwnedSourceAndStableLines(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	file := f.upload(t, "分析资料.txt", []byte("收入: 10\n成本: 6\n利润: 4"))
	raw := cloudJSON([]any{map[string]any{"type": "text", "text": "分析资料"}, map[string]any{"type": "file_reference", "file_id": file.ID, "name": "伪造名称", "text": "伪造原文"}})
	validated, err := validateCloudContent(raw)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := f.service.canonicalCloudFileReferences(context.Background(), 1, validated)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(canonical), "伪造名称") || !strings.Contains(string(canonical), file.Name) {
		t.Fatal("client name overrode original")
	}
	messages := []CloudMessage{{Role: "user", Content: canonical}, {Role: "assistant", Content: cloudJSON("利润为4")}, {Role: "user", Content: canonical}}
	expanded, code := f.service.cloudModelMessages(context.Background(), 1, messages)
	if code != "" || len(expanded) != 4 {
		t.Fatalf("context failed: %q", code)
	}
	encoded := string(cloudJSON(expanded))
	if !strings.Contains(encoded, "L2: 成本: 6") || !strings.Contains(encoded, "L3: 利润: 4") || strings.Count(encoded, "L2: 成本: 6") != 1 {
		t.Fatal("source lines changed or duplicate source expanded")
	}
	if strings.Contains(encoded, "伪造原文") {
		t.Fatal("client file text entered model context")
	}
	if strings.Contains(encoded, "file_reference") || strings.Contains(encoded, "ObjectKey") {
		t.Fatal("internal reference passed to provider")
	}
	if _, err = f.service.canonicalCloudFileReferences(context.Background(), 2, validated); err == nil {
		t.Fatal("foreign account resolved file")
	}
	if _, code = f.service.cloudModelMessages(context.Background(), 2, messages); code != "file_unavailable" {
		t.Fatalf("foreign file context code=%s", code)
	}
}

func TestCloudFileContextNotReadyAndDeletedAreExplicit(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	file := f.upload(t, "待解析.pdf", []byte("%PDF-1.7\nsynthetic fixture"))
	content := cloudJSON([]any{map[string]any{"type": "file_reference", "file_id": file.ID}})
	_, err := f.service.canonicalCloudFileReferences(context.Background(), 1, content)
	checkSessionAPIStatus(t, err, http.StatusConflict)
	text := f.upload(t, "待删除.txt", []byte("private text"))
	status, _, _ := f.request(t, "DELETE", "/api/web-chat/files/"+text.ID, "file-owner", nil, nil)
	if status != 200 {
		t.Fatalf("delete status=%d", status)
	}
	content = cloudJSON([]any{map[string]any{"type": "file_reference", "file_id": text.ID}})
	_, err = f.service.canonicalCloudFileReferences(context.Background(), 1, content)
	checkSessionAPIStatus(t, err, http.StatusNotFound)
}

func TestCloudFileSourceExcerptIsBoundedAndAccountOwned(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	file := f.upload(t, "引用.txt", []byte("一\n二\n三\n四"))
	path := "/api/web-chat/files/" + file.ID + "/content?from_line=2&to_line=3"
	status, body, headers := f.request(t, "GET", path, "file-owner", nil, nil)
	if status != 200 || headers.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("excerpt status=%d", status)
	}
	var result struct {
		Total int `json:"total_lines"`
		Lines []struct {
			Line int    `json:"line"`
			Text string `json:"text"`
		} `json:"lines"`
	}
	if err := json.Unmarshal(body, &result); err != nil || result.Total != 4 || len(result.Lines) != 2 || result.Lines[0].Line != 2 || result.Lines[0].Text != "二" {
		t.Fatal("excerpt lines do not match source")
	}
	for _, owner := range []string{"file-other", ""} {
		status, _, _ = f.request(t, "GET", path, owner, nil, nil)
		if status != 404 && status != 401 {
			t.Fatalf("foreign excerpt status=%d", status)
		}
	}
	for _, query := range []string{"?from_line=-1", "?from_line=1&to_line=201", "?from_line=9", "?to_line=invalid"} {
		status, _, _ = f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/content"+query, "file-owner", nil, nil)
		if status != 400 {
			t.Fatalf("invalid excerpt range status=%d", status)
		}
	}
}
