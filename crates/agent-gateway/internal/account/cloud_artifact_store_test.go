package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func artifactContractRun(t *testing.T, f cloudRunTestFixture) (*CloudRun, string) {
	t.Helper()
	input := cloudRunTestInput(t, f, 11, "", uuid.NewString(), "artifact")
	if _, _, err := f.runs.CreateCloudRun(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	owner := "artifact-contract-worker"
	run, err := f.runs.ClaimCloudRun(context.Background(), owner, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return run, owner
}
func artifactContractVersion(run *CloudRun) *CloudArtifactVersion {
	digest := sha256.Sum256([]byte("a,b\n1,2\n"))
	return &CloudArtifactVersion{ID: uuid.NewString(), FamilyID: uuid.NewString(), ConversationID: run.ConversationID, SourceRunID: run.ID, ToolOperationID: uuid.NewString(), RequestHash: strings.Repeat("a", 64), Name: "report.csv", MIME: "text/csv", Size: 8, SHA256: hex.EncodeToString(digest[:])}
}
func runArtifactStoreContract(t *testing.T, f cloudRunTestFixture, store CloudArtifactStore) {
	t.Helper()
	ctx := context.Background()
	run, owner := artifactContractRun(t, f)
	input := artifactContractVersion(run)
	if _, _, err := store.ReserveCloudArtifact(ctx, 12, owner, run.Attempt, input); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign run reservation: %v", err)
	}
	first, created, err := store.ReserveCloudArtifact(ctx, 11, owner, run.Attempt, input)
	if err != nil || !created || first.Number != 1 || first.State != CloudArtifactStaging {
		t.Fatalf("reserve %+v %v", first, err)
	}
	again, created, err := store.ReserveCloudArtifact(ctx, 11, owner, run.Attempt, input)
	if err != nil || created || again.ID != first.ID {
		t.Fatal("duplicate allocation")
	}
	changed := *input
	changed.RequestHash = strings.Repeat("b", 64)
	if _, _, err = store.ReserveCloudArtifact(ctx, 11, owner, run.Attempt, &changed); !errors.Is(err, ErrCloudArtifactConflict) {
		t.Fatal("changed publication accepted")
	}
	if _, err = store.GetCloudArtifactVersion(ctx, 12, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign version read")
	}
	first, err = store.UpdateCloudArtifact(ctx, 11, first.ID, first.Version, owner, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
	if err != nil {
		t.Fatal(err)
	}
	secondInput := artifactContractVersion(run)
	secondInput.FamilyID = first.FamilyID
	secondInput.Name = "report-v2.csv"
	secondInput.RequestHash = strings.Repeat("c", 64)
	second, _, err := store.ReserveCloudArtifact(ctx, 11, owner, run.Attempt, secondInput)
	if err != nil || second.Number != 2 {
		t.Fatal("version not incremented")
	}
	old, err := store.GetCloudArtifactVersion(ctx, 11, first.ID)
	if err != nil || old.Name != "report.csv" || old.State != CloudArtifactReady || old.SHA256 != first.SHA256 {
		t.Fatal("old version overwritten")
	}
	listed, err := store.ListCloudArtifacts(ctx, 11, run.ConversationID, first.FamilyID, "", 100)
	if err != nil || len(listed.Versions) != 2 {
		t.Fatal("versions missing")
	}
	if _, err = store.DeleteCloudArtifactFamily(ctx, 12, first.FamilyID); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign deletion")
	}
	deleted, err := store.DeleteCloudArtifactFamily(ctx, 11, first.FamilyID)
	if err != nil || len(deleted) != 2 {
		t.Fatal("deletion intent not atomic")
	}
	if _, err = store.UpdateCloudArtifact(ctx, 11, second.ID, second.Version, owner, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady}); !errors.Is(err, ErrCloudArtifactConflict) {
		t.Fatalf("late ready resurrected version: %v", err)
	}
	for _, version := range deleted {
		if version.DeletedAt == nil || version.State != CloudArtifactDeleting {
			t.Fatal("missing tombstone")
		}
		if _, err = store.UpdateCloudArtifact(ctx, 11, version.ID, version.Version, "", 0, CloudArtifactUpdate{State: CloudArtifactDeleted}); err != nil {
			t.Fatal(err)
		}
	}
	listed, err = store.ListCloudArtifacts(ctx, 11, "", "", "", 100)
	if err != nil || len(listed.Versions) != 0 {
		t.Fatal("deleted artifact visible")
	}
}
func TestCloudArtifactMemoryContract(t *testing.T) {
	fixture := cloudRunMemoryFixture(t)
	runArtifactStoreContract(t, fixture, fixture.store.(*MemoryStore))
}
func TestCloudArtifactPostgresContract(t *testing.T) {
	fixture := cloudRunPostgresFixture(t)
	store := fixture.store.(*PersistentStore)
	if _, err := store.db.Exec(CloudArtifactSchema); err != nil {
		t.Fatal(err)
	}
	runArtifactStoreContract(t, fixture, store)
}
