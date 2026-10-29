package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func newCloudFileRecord(userID int64, conversationID string) *CloudFile {
	id := uuid.NewString()
	digest := sha256.Sum256([]byte("x"))
	return &CloudFile{ID: id, UserID: userID, ConversationID: conversationID, ObjectKey: cloudFileObjectKey(userID, id), Name: "notes.txt", MIME: "text/plain", Size: 1, SHA256: hex.EncodeToString(digest[:]), State: CloudFileUploading}
}

func runCloudFileStoreContract(t *testing.T, store Store, files CloudFileStore) {
	t.Helper()
	ctx := context.Background()
	conversation := &CloudConversation{ID: uuid.NewString(), UserID: 41, Title: "files", Model: "test", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := store.PutCloudConversation(ctx, conversation); err != nil {
		t.Fatal(err)
	}
	foreign := newCloudFileRecord(42, conversation.ID)
	if _, err := files.CreateCloudFile(ctx, foreign); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign create: %v", err)
	}
	input := newCloudFileRecord(41, conversation.ID)
	input.ObjectKey = "accounts/other/files/" + input.ID + "/original"
	if _, err := files.CreateCloudFile(ctx, input); !errors.Is(err, ErrCloudFileInvalid) {
		t.Fatalf("arbitrary key accepted: %v", err)
	}
	input.ObjectKey = cloudFileObjectKey(41, input.ID)
	file, err := files.CreateCloudFile(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = files.GetCloudFile(ctx, 42, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign get: %v", err)
	}
	if _, err = files.UpdateCloudFile(ctx, 42, file.ID, 1, CloudFileUpdate{State: CloudFileDeleting}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign update: %v", err)
	}
	if _, err = files.ListCloudFiles(ctx, 42, conversation.ID, "", 50); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign list: %v", err)
	}
	if _, err = files.UpdateCloudFile(ctx, 41, file.ID, 1, CloudFileUpdate{State: CloudFileReady}); !errors.Is(err, ErrCloudFileInvalid) {
		t.Fatalf("unverified ready: %v", err)
	}
	file, err = files.UpdateCloudFile(ctx, 41, file.ID, 1, CloudFileUpdate{State: CloudFileUploaded, MarkUploaded: true, ProcessingStage: "awaiting_isolated_parser"})
	if err != nil {
		t.Fatal(err)
	}
	if file.UploadedAt == nil || file.Version != 2 {
		t.Fatal("upload verification not durable")
	}
	if _, err = files.UpdateCloudFile(ctx, 41, file.ID, 1, CloudFileUpdate{State: CloudFileProcessing}); !errors.Is(err, ErrCloudFileConflict) {
		t.Fatalf("stale CAS: %v", err)
	}
	text := "extracted text"
	file, err = files.UpdateCloudFile(ctx, 41, file.ID, 2, CloudFileUpdate{State: CloudFileReady, Text: &text, ProcessingStage: "complete"})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(file)
	for _, private := range []string{"object_key", "accounts/", "user_id", "extracted text", "\"text\":"} {
		if strings.Contains(string(data), private) {
			t.Fatalf("private field leaked: %s", private)
		}
	}
	// Two simultaneous updates against one version have exactly one winner.
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := files.UpdateCloudFile(ctx, 41, file.ID, 3, CloudFileUpdate{State: CloudFileProcessing})
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrCloudFileConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("CAS winners=%d conflicts=%d", success, conflict)
	}
	if err = store.DeleteCloudConversation(ctx, 41, conversation.ID); err != nil {
		t.Fatal(err)
	}
	file, err = files.GetCloudFile(ctx, 41, file.ID)
	if err != nil {
		t.Fatalf("conversation deletion removed file: %v", err)
	}
	library, err := files.ListCloudFiles(ctx, 41, "", "", 50)
	if err != nil || len(library) != 1 {
		t.Fatalf("orphaned conversation library: %d %v", len(library), err)
	}
	if _, err = files.ListCloudFiles(ctx, 41, conversation.ID, "", 50); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted conversation scoped list: %v", err)
	}
	file, err = files.UpdateCloudFile(ctx, 41, file.ID, file.Version, CloudFileUpdate{State: CloudFileDeleting})
	if err != nil {
		t.Fatal(err)
	}
	library, err = files.ListCloudFiles(ctx, 41, "", "", 50)
	if err != nil || len(library) != 0 {
		t.Fatal("tombstone remained visible")
	}
	if _, err = files.UpdateCloudFile(ctx, 41, file.ID, file.Version, CloudFileUpdate{State: CloudFileReady, Text: &text}); !errors.Is(err, ErrCloudFileConflict) {
		t.Fatalf("tombstone resurrected: %v", err)
	}
	file, err = files.UpdateCloudFile(ctx, 41, file.ID, file.Version, CloudFileUpdate{State: CloudFileDeleted})
	if err != nil {
		t.Fatal(err)
	}
	if file.DeletedAt == nil {
		t.Fatal("deletion intent was lost")
	}
	if _, err = files.GetCloudFile(ctx, 41, file.ID); err != nil {
		t.Fatal("deletion audit row was removed")
	}
}

func TestCloudFileMemoryContract(t *testing.T) {
	store := NewMemoryStore()
	runCloudFileStoreContract(t, store, store)
}

func TestCloudFilePostgresContract(t *testing.T) {
	fixture := cloudRunPostgresFixture(t)
	store := fixture.store.(*PersistentStore)
	if _, err := store.db.Exec(CloudFileSchema); err != nil {
		t.Fatal(err)
	}
	runCloudFileStoreContract(t, store, store)
	runCloudFileQuotaAndCursor(t, store, store)
}

func TestCloudFileQuotaAndCursor(t *testing.T) {
	store := NewMemoryStore()
	runCloudFileQuotaAndCursor(t, store, store)
	for _, name := range []string{"", "../a.txt", "C:\\a.txt", "a\n.txt", "a\u202e.txt", strings.Repeat("字", 86) + ".txt"} {
		if validCloudFileName(name) {
			t.Fatalf("invalid name accepted: %q", name)
		}
	}
}

func runCloudFileQuotaAndCursor(t *testing.T, store Store, files CloudFileStore) {
	t.Helper()
	ctx := context.Background()
	conversation := &CloudConversation{ID: uuid.NewString(), UserID: 1}
	if err := store.PutCloudConversation(ctx, conversation); err != nil {
		t.Fatal(err)
	}
	var first *CloudFile
	for i := 0; i < 8; i++ {
		file := newCloudFileRecord(1, conversation.ID)
		file.Size = CloudFileMaxBytes
		created, err := files.CreateCloudFile(ctx, file)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = created
		}
	}
	if _, err := files.CreateCloudFile(ctx, newCloudFileRecord(1, conversation.ID)); !errors.Is(err, ErrCloudFileQuota) {
		t.Fatalf("size quota bypassed: %v", err)
	}
	first, err := files.UpdateCloudFile(ctx, 1, first.ID, first.Version, CloudFileUpdate{State: CloudFileDeleting})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = files.CreateCloudFile(ctx, newCloudFileRecord(1, conversation.ID)); !errors.Is(err, ErrCloudFileQuota) {
		t.Fatalf("deleting bytes released early: %v", err)
	}
	if _, err = files.UpdateCloudFile(ctx, 1, first.ID, first.Version, CloudFileUpdate{State: CloudFileDeleted}); err != nil {
		t.Fatal(err)
	}
	if _, err = files.CreateCloudFile(ctx, newCloudFileRecord(1, conversation.ID)); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	quotaResults := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			input := newCloudFileRecord(1, conversation.ID)
			input.Size = CloudFileMaxBytes / 2
			_, err := files.CreateCloudFile(ctx, input)
			quotaResults <- err
		}()
	}
	wg.Wait()
	close(quotaResults)
	accepted, rejected := 0, 0
	for err := range quotaResults {
		if err == nil {
			accepted++
		} else if errors.Is(err, ErrCloudFileQuota) {
			rejected++
		} else {
			t.Fatal(err)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("concurrent account quota accepted=%d rejected=%d", accepted, rejected)
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		page, err := files.ListCloudFiles(ctx, 1, "", cursor, 3)
		if err != nil {
			t.Fatal(err)
		}
		if len(page) == 0 {
			break
		}
		for _, file := range page {
			if seen[file.ID] {
				t.Fatal("duplicate cursor result")
			}
			seen[file.ID] = true
		}
		cursor = page[len(page)-1].ID
	}
	if len(seen) != 9 {
		t.Fatalf("cursor skipped files: %d", len(seen))
	}
}
