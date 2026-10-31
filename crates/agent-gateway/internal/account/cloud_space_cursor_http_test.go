package account

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

func TestCloudSpaceHTTPCursorConflictAndRefresh(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	for i := range 63 {
		file := newCloudFileRecord(1, "")
		file.Name = fmt.Sprintf("第%02d份.txt", i)
		if _, err := f.store.CreateCloudFile(context.Background(), file); err != nil {
			t.Fatal(err)
		}
	}
	status, data, _ := f.request(t, "GET", "/api/web-chat/space", "file-owner", nil, nil)
	var first CloudSpacePage
	if status != 200 || json.Unmarshal(data, &first) != nil || first.NextCursor == "" || len(first.Items) != 50 {
		t.Fatal("first HTTP cursor page unavailable")
	}
	if _, err := f.store.PutCloudSpaceMetadata(context.Background(), 1, CloudSpaceMetadata{ID: first.Items[0].ID, Kind: "file", Name: "新的显示名称.txt"}); err != nil {
		t.Fatal(err)
	}
	status, _, _ = f.request(t, "GET", "/api/web-chat/space?cursor="+first.NextCursor, "file-owner", nil, nil)
	if status != 409 {
		t.Fatalf("mixed generation HTTP status %d", status)
	}
	status, _, _ = f.request(t, "GET", "/api/web-chat/space?cursor="+first.NextCursor, "file-other", nil, nil)
	if status != 400 {
		t.Fatalf("foreign HTTP cursor status %d", status)
	}
	status, data, _ = f.request(t, "GET", "/api/web-chat/space", "file-owner", nil, nil)
	var refreshed CloudSpacePage
	if status != 200 || json.Unmarshal(data, &refreshed) != nil || refreshed.Total != 63 || refreshed.Items[0].Name != "新的显示名称.txt" {
		t.Fatal("explicit refresh did not rebuild current view")
	}
}
