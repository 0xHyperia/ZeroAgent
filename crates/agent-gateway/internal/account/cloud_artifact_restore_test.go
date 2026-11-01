package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"testing"
	"time"
)

func runArtifactRestoreContract(t *testing.T, f cloudRunTestFixture, store CloudArtifactStore) {
	ctx := context.Background()
	run, owner := artifactContractRun(t, f)
	first, _, err := store.ReserveCloudArtifact(ctx, 11, owner, run.Attempt, artifactContractVersion(run))
	if err != nil {
		t.Fatal(err)
	}
	first, err = store.UpdateCloudArtifact(ctx, 11, first.ID, first.Version, owner, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
	if err != nil {
		t.Fatal(err)
	}
	input := artifactContractVersion(run)
	input.FamilyID = first.FamilyID
	second, _, err := store.ReserveCloudArtifact(ctx, 11, owner, run.Attempt, input)
	if err != nil {
		t.Fatal(err)
	}
	second, err = store.UpdateCloudArtifact(ctx, 11, second.ID, second.Version, owner, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
	if err != nil {
		t.Fatal(err)
	}
	restores := store.(CloudArtifactRestoreStore)
	if _, _, err = restores.ReserveCloudArtifactRestore(ctx, 12, first.ID, second.ID, uuid.NewString()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign restore %v", err)
	}
	if _, _, err = restores.ReserveCloudArtifactRestore(ctx, 11, first.ID, first.ID, uuid.NewString()); !errors.Is(err, ErrCloudArtifactConflict) {
		t.Fatalf("stale head %v", err)
	}
	request := uuid.NewString()
	third, created, err := restores.ReserveCloudArtifactRestore(ctx, 11, first.ID, second.ID, request)
	if err != nil || !created || third.Number != 3 || third.ObjectKey == first.ObjectKey || third.SHA256 != first.SHA256 {
		t.Fatalf("restore reservation %+v %v", third, err)
	}
	again, created, err := restores.ReserveCloudArtifactRestore(ctx, 11, first.ID, second.ID, request)
	if err != nil || created || again.ID != third.ID {
		t.Fatalf("not idempotent %+v %v", again, err)
	}
	if _, err = restores.UpdateCloudArtifactRestore(ctx, 11, third.ID, third.Version, CloudArtifactUpdate{State: CloudArtifactReady}); !errors.Is(err, ErrCloudArtifactConflict) {
		t.Fatalf("unverified restore ready %v", err)
	}
	if _, err = restores.UpdateCloudArtifactRestore(ctx, 11, second.ID, second.Version, CloudArtifactUpdate{State: CloudArtifactReady}); !errors.Is(err, ErrCloudArtifactConflict) {
		t.Fatal("restore path authorized normal publication")
	}
	var journal cloudArtifactJournal
	_ = json.Unmarshal(third.Journal, &journal)
	journal.PutStarted = true
	journal.ObjectVerified = true
	data, _ := json.Marshal(journal)
	third, err = restores.UpdateCloudArtifactRestore(ctx, 11, third.ID, third.Version, CloudArtifactUpdate{State: CloudArtifactReady, Journal: data})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = restores.ReserveCloudArtifactRestore(ctx, 11, first.ID, second.ID, uuid.NewString()); !errors.Is(err, ErrCloudArtifactConflict) {
		t.Fatal("concurrent head accepted")
	}
	input = artifactContractVersion(run)
	input.FamilyID = first.FamilyID
	normal, _, err := store.ReserveCloudArtifact(ctx, 11, owner, run.Attempt, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.UpdateCloudArtifact(ctx, 11, normal.ID, normal.Version, "", 0, CloudArtifactUpdate{State: CloudArtifactReady}); !errors.Is(err, ErrCloudRunLeaseLost) {
		t.Fatalf("normal lease guard changed %v", err)
	}
	staged, _, err := restores.ReserveCloudArtifactRestore(ctx, 11, first.ID, normal.ID, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.DeleteCloudArtifactFamily(ctx, 11, first.FamilyID); err != nil {
		t.Fatal(err)
	}
	if _, err = restores.UpdateCloudArtifactRestore(ctx, 11, staged.ID, staged.Version, CloudArtifactUpdate{State: CloudArtifactReady, Journal: data}); !errors.Is(err, ErrCloudArtifactConflict) {
		t.Fatal("deleted family resurrected")
	}
}
func TestCloudArtifactRestoreMemoryContract(t *testing.T) {
	f := cloudRunMemoryFixture(t)
	runArtifactRestoreContract(t, f, f.store.(*MemoryStore))
}
func TestCloudArtifactRestorePostgresContract(t *testing.T) {
	f := cloudRunPostgresFixture(t)
	s := f.store.(*PersistentStore)
	if _, err := s.db.Exec(CloudArtifactSchema); err != nil {
		t.Fatal(err)
	}
	runArtifactRestoreContract(t, f, s)
}

func TestCloudArtifactRestoreVerifiedCopyHTTP(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	pub, sdk := artifactPublicationFixture(t, f)
	ctx := context.Background()
	first, err := f.service.PublishCloudArtifact(ctx, 1, pub)
	if err != nil {
		t.Fatal(err)
	}
	sdk.mu.Lock()
	sdk.data = []byte("item,value\nprofit,9\n")
	sdk.mu.Unlock()
	second, err := f.service.PublishCloudArtifact(ctx, 1, nextArtifactPublication(t, f, pub, first.FamilyID))
	if err != nil {
		t.Fatal(err)
	}
	request := uuid.NewString()
	body, _ := json.Marshal(map[string]string{"expected_head_id": second.ID, "client_request_id": request})
	status, data, _ := f.request(t, "POST", "/api/web-chat/artifacts/versions/"+first.ID+"/restore", "file-owner", bytes.NewReader(body), nil)
	if status != 200 {
		t.Fatalf("restore %d %s", status, data)
	}
	var response struct {
		Version CloudArtifactVersion `json:"version"`
	}
	if json.Unmarshal(data, &response) != nil || response.Version.Number != 3 || response.Version.ID == first.ID {
		t.Fatalf("response %s", data)
	}
	status, download, _ := f.request(t, "GET", response.Version.DownloadPath, "file-owner", nil, nil)
	if status != 200 || !bytes.Contains(download, []byte("profit,4")) {
		t.Fatalf("restored bytes %d %s", status, download)
	}
	if _, err = f.service.RestoreCloudArtifact(ctx, 1, first.ID, second.ID, request); err != nil {
		t.Fatal("response retry not idempotent", err)
	}
	receipt, err := f.service.CloudArtifactRestoreReceipt(ctx, 1, request)
	if err != nil || receipt.ID != response.Version.ID {
		t.Fatal("receipt mismatch", err)
	}
	if _, err = f.service.CloudArtifactRestoreReceipt(ctx, 2, request); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign receipt", err)
	}
	status, download, _ = f.request(t, "GET", second.DownloadPath, "file-owner", nil, nil)
	if status != 200 || !bytes.Contains(download, []byte("profit,9")) {
		t.Fatal("head overwritten")
	}
	if bytes.Contains(data, []byte("object_key")) || bytes.Contains(data, []byte("restore_source")) {
		t.Fatal("private journal exposed")
	}
}

func TestCloudArtifactRestoreDeleteDuringCopy(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	ctx := context.Background()
	pub, _ := artifactPublicationFixture(t, f)
	first, err := f.service.PublishCloudArtifact(ctx, 1, pub)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.service.PublishCloudArtifact(ctx, 1, nextArtifactPublication(t, f, pub, first.FamilyID))
	if err != nil {
		t.Fatal(err)
	}
	f.putEntered = make(chan struct{})
	f.putRelease = make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := f.service.RestoreCloudArtifact(ctx, 1, first.ID, second.ID, uuid.NewString())
		done <- err
	}()
	select {
	case <-f.putEntered:
	case <-time.After(3 * time.Second):
		t.Fatal("copy not reached")
	}
	if _, err = f.store.DeleteCloudArtifactFamily(ctx, 1, first.FamilyID); err != nil {
		t.Fatal(err)
	}
	close(f.putRelease)
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("restore resurrected deleted family")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("copy not settled")
	}
	versions, err := f.store.ListCloudArtifactCleanup(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range versions {
		if v.Number == 3 && v.State != CloudArtifactDeleted {
			t.Fatalf("late copied object not cleaned %+v", v)
		}
	}
}
