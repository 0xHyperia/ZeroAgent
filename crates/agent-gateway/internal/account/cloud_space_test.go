package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func runCloudSpaceContract(t *testing.T, store Store, files CloudFileStore, space CloudSpaceStore) {
	t.Helper()
	ctx := context.Background()
	// Account originals have no synthetic conversation and remain immediately
	// visible to the same canonical file/reference/download APIs.
	file := newCloudFileRecord(1, "")
	file.Name = "季度总结.txt"
	file.Size = 17
	saved, err := files.CreateCloudFile(ctx, file)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := space.ReadCloudSpace(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Items) != 1 || snapshot.Usage.UsedBytes != 17 || snapshot.Usage.FileCount != 1 || snapshot.Items[0].ConversationID != "" {
		t.Fatalf("bad owned snapshot: %+v", snapshot)
	}
	other, err := space.ReadCloudSpace(ctx, 2)
	if err != nil || len(other.Items) != 0 || other.Usage.UsedBytes != 0 {
		t.Fatalf("other account leaked: %+v %v", other, err)
	}
	folder := CloudSpaceMetadata{ID: uuid.NewString(), Kind: "folder", Name: "产品资料"}
	created, err := space.PutCloudSpaceMetadata(ctx, 1, folder)
	if err != nil {
		t.Fatal(err)
	}
	edit := CloudSpaceMetadata{ID: saved.ID, Kind: "file", Name: "试点方案.txt", FolderID: created.ID, Starred: true}
	updated, err := space.PutCloudSpaceMetadata(ctx, 1, edit)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = space.PutCloudSpaceMetadata(ctx, 1, edit); !errors.Is(err, ErrCloudSpaceConflict) {
		t.Fatalf("stale metadata accepted %v", err)
	}
	if _, err = space.PutCloudSpaceMetadata(ctx, 2, *updated); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other account mutation accepted %v", err)
	}
	deletedFolder := *created
	deletedFolder.Trashed = true
	if _, err = space.PutCloudSpaceMetadata(ctx, 1, deletedFolder); !errors.Is(err, ErrCloudSpaceConflict) {
		t.Fatalf("nonempty folder hidden %v", err)
	}
	snapshot, err = space.ReadCloudSpace(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	found, total := filterCloudSpace(snapshot, "试点", "all", "all", "", "name", 0)
	if total != 1 || found[0].ID != saved.ID {
		t.Fatal("full library name search lost folder contents")
	}
	root, total := filterCloudSpace(snapshot, "", "all", "all", "", "updated", 0)
	if total != 1 || root[0].Kind != "folder" {
		t.Fatal("root did not organize folder contents")
	}
	updated.Trashed = true
	trashed, err := space.PutCloudSpaceMetadata(ctx, 1, *updated)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err = space.ReadCloudSpace(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Usage.UsedBytes != 17 || snapshot.Usage.TrashBytes != 17 {
		t.Fatal("trash falsely released object quota")
	}
	found, total = filterCloudSpace(snapshot, "", "all", "trash", "", "updated", 0)
	if total != 1 || found[0].ID != saved.ID {
		t.Fatal("trash missing")
	}
	// Trash is organization, not revocation: prior citations are not silently broken.
	listed, err := files.ListCloudFiles(ctx, 1, "", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range listed {
		if f.ID == saved.ID {
			t.Fatal("trashed file appeared in the account picker")
		}
	}
	if _, err = files.GetCloudFile(ctx, 1, saved.ID); err != nil {
		t.Fatal(err)
	}
	trashed.Trashed = false
	if _, err = space.PutCloudSpaceMetadata(ctx, 1, *trashed); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	restored := *trashed
	restored.Version++
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); _, e := space.PutCloudSpaceMetadata(ctx, 1, restored); results <- e }()
	}
	wg.Wait()
	close(results)
	ok, conflicts := 0, 0
	for e := range results {
		if e == nil {
			ok++
		} else if errors.Is(e, ErrCloudSpaceConflict) {
			conflicts++
		} else {
			t.Fatal(e)
		}
	}
	if ok != 1 || conflicts != 1 {
		t.Fatalf("metadata CAS race %d/%d", ok, conflicts)
	}
}
func TestCloudSpaceMemoryContract(t *testing.T) {
	s := NewMemoryStore()
	runCloudSpaceContract(t, s, s, s)
}
func TestCloudSpacePostgresContract(t *testing.T) {
	f := cloudRunPostgresFixture(t)
	s := f.store.(*PersistentStore)
	runCloudSpaceContract(t, s, s, s)
}
func TestCloudSpaceHTTPDirectUploadAndServerSearch(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	before, _ := f.store.ListCloudConversations(context.Background(), 1)
	body, headers := cloudFileMultipart(t, "", "source.txt", []byte("A source independent of a conversation."))
	status, data, _ := f.request(t, "POST", "/api/web-chat/files", "file-owner", body, headers)
	if status != http.StatusCreated {
		t.Fatalf("direct upload %d %s", status, data)
	}
	after, _ := f.store.ListCloudConversations(context.Background(), 1)
	if len(before) != len(after) {
		t.Fatal("upload created an empty conversation")
	}
	for i := range 62 {
		file := newCloudFileRecord(1, "")
		file.Name = fmt.Sprintf("资料 %02d.txt", i)
		if _, err := f.store.CreateCloudFile(context.Background(), file); err != nil {
			t.Fatal(err)
		}
	}
	status, data, _ = f.request(t, "GET", "/api/web-chat/space?q=source", "file-owner", nil, nil)
	var page struct {
		Items []CloudSpaceItem `json:"items"`
		Total int              `json:"total"`
		Usage CloudSpaceUsage  `json:"usage"`
	}
	if status != 200 || json.Unmarshal(data, &page) != nil || page.Total != 1 || page.Items[0].Name != "source.txt" {
		t.Fatalf("search outside first page %d %s", status, data)
	}
	status, data, _ = f.request(t, "GET", "/api/web-chat/space", "file-other", nil, nil)
	if status != 200 || json.Unmarshal(data, &page) != nil || page.Total != 0 || page.Usage.UsedBytes != 0 {
		t.Fatalf("account scope %d %s", status, data)
	}
	status, _, _ = f.request(t, "GET", "/api/web-chat/space?offset=-1", "file-owner", nil, nil)
	if status != 400 {
		t.Fatal("invalid query accepted")
	}
}
func TestCloudSpaceQuotaIncludesArtifactReservations(t *testing.T) {
	s := NewMemoryStore()
	s.cloudSpaceLimits = map[int64]int64{1: 20}
	s.cloudArtifacts = &cloudArtifactMemoryState{versions: map[string]CloudArtifactVersion{"a": {UserID: 1, Size: 15, State: CloudArtifactUnknown}}}
	f := newCloudFileRecord(1, "")
	f.Size = 6
	if _, err := s.CreateCloudFile(context.Background(), f); !errors.Is(err, ErrCloudFileQuota) {
		t.Fatalf("combined quota bypassed %v", err)
	}
	s.cloudArtifacts.versions["a"] = CloudArtifactVersion{UserID: 1, Size: 15, State: CloudArtifactDeleted}
	if _, err := s.CreateCloudFile(context.Background(), f); err != nil {
		t.Fatal(err)
	}
}

func TestCloudSpaceArtifactFamiliesKeepImmutableVersionReferences(t *testing.T) {
	family, id1, id2 := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snapshot := (cloudSpaceRecords{artifacts: []CloudArtifactVersion{{ID: id1, FamilyID: family, UserID: 1, Name: "report.csv", MIME: "text/csv", State: CloudArtifactReady, Size: 10, Number: 1}, {ID: id2, FamilyID: family, UserID: 1, Name: "report-v2.csv", MIME: "text/csv", State: CloudArtifactReady, Size: 15, Number: 2}}}).snapshot()
	if len(snapshot.Items) != 1 || snapshot.Items[0].TargetID != id2 || snapshot.Items[0].Versions != 2 || snapshot.Usage.ArtifactBytes != 25 {
		t.Fatalf("artifact family projection %+v", snapshot)
	}
}
