package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
)

func artifactPaginationRun(t *testing.T, f cloudRunTestFixture, userID int64) *CloudRun {
	t.Helper()
	input := cloudRunTestInput(t, f, userID, "", uuid.NewString(), "pagination")
	if _, _, err := f.runs.CreateCloudRun(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	run, err := f.runs.ClaimCloudRun(context.Background(), "artifact-page-worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return run
}
func seedArtifactPageVersion(t *testing.T, f cloudRunTestFixture, run *CloudRun, created time.Time, familyID string) CloudArtifactVersion {
	t.Helper()
	store := f.store.(CloudArtifactStore)
	input := artifactContractVersion(run)
	if familyID != "" {
		input.FamilyID = familyID
	}
	input.Journal = json.RawMessage(`{"private":"not in list metadata"}`)
	version, _, err := store.ReserveCloudArtifact(context.Background(), run.UserID, run.LeaseOwner, run.Attempt, input)
	if err != nil {
		t.Fatal(err)
	}
	switch s := f.store.(type) {
	case *MemoryStore:
		s.mu.Lock()
		item := s.cloudArtifacts.versions[version.ID]
		item.CreatedAt = created
		s.cloudArtifacts.versions[item.ID] = item
		s.mu.Unlock()
	case *PersistentStore:
		if _, err := s.db.Exec(`UPDATE zeroagent_cloud_artifact_versions SET created_at=$2 WHERE id=$1`, version.ID, created); err != nil {
			t.Fatal(err)
		}
	}
	version.CreatedAt = created
	return *version
}
func runArtifactPaginationContract(t *testing.T, f cloudRunTestFixture) {
	t.Helper()
	ctx := context.Background()
	// This contract deliberately keeps several fixture Runs live to publish
	// immutable versions in different conversations; admission has its own suite.
	if err := f.runs.(CloudRunAdmissionStore).ConfigureCloudRunAdmission(ctx, CloudRunAdmissionLimits{MaxExecutingPerAccount: 8, MaxQueuedPerAccount: 20}); err != nil {
		t.Fatal(err)
	}
	store := f.store.(CloudArtifactStore)
	run := artifactPaginationRun(t, f, 11)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	expected := make([]CloudArtifactVersion, 0, 123)
	for i := 0; i < 123; i++ {
		expected = append(expected, seedArtifactPageVersion(t, f, run, base.Add(time.Duration(i%4)*time.Microsecond), ""))
	}
	sort.Slice(expected, func(i, j int) bool {
		if expected[i].CreatedAt.Equal(expected[j].CreatedAt) {
			return expected[i].ID > expected[j].ID
		}
		return expected[i].CreatedAt.After(expected[j].CreatedAt)
	})
	otherRun := artifactPaginationRun(t, f, 11)
	other := seedArtifactPageVersion(t, f, otherRun, base.Add(-time.Second), "")
	foreignRun := artifactPaginationRun(t, f, 12)
	foreign := seedArtifactPageVersion(t, f, foreignRun, base, "")
	first, err := store.ListCloudArtifacts(ctx, 11, run.ConversationID, "", "", 23)
	if err != nil || len(first.Versions) != 23 || first.NextCursor != expected[22].ID {
		t.Fatalf("first page: %+v %v", first, err)
	}
	anchor := first.Versions[len(first.Versions)-1]
	if _, err = store.DeleteCloudArtifactFamily(ctx, 11, anchor.FamilyID); err != nil {
		t.Fatal(err)
	}
	// A concurrent newer publication belongs to a refresh, never a later page.
	newer := seedArtifactPageVersion(t, f, run, base.Add(time.Hour), "")
	actual := append([]CloudArtifactVersion(nil), first.Versions...)
	cursor := first.NextCursor
	for pageNumber := 0; cursor != ""; pageNumber++ {
		if pageNumber > 10 {
			t.Fatal("pagination loop")
		}
		page, err := store.ListCloudArtifacts(ctx, 11, run.ConversationID, "", cursor, 23)
		if err != nil {
			t.Fatal(err)
		}
		actual = append(actual, page.Versions...)
		cursor = page.NextCursor
	}
	if len(actual) != len(expected) {
		t.Fatalf("page count %d expected %d", len(actual), len(expected))
	}
	seen := map[string]bool{}
	for i, item := range actual {
		if item.ID != expected[i].ID || seen[item.ID] || item.UserID != 11 || item.ConversationID != run.ConversationID || len(item.Journal) != 0 {
			t.Fatalf("unstable/private page result %d", i)
		}
		seen[item.ID] = true
	}
	if seen[newer.ID] || seen[foreign.ID] || seen[other.ID] {
		t.Fatal("cursor included newer/foreign/out-of-scope result")
	}
	account, err := store.ListCloudArtifacts(ctx, 11, "", "", "", 100)
	if err != nil || account.Versions[0].ID != newer.ID || account.NextCursor == "" {
		t.Fatal("account first page invalid")
	}
	tail, err := store.ListCloudArtifacts(ctx, 11, "", "", account.NextCursor, 100)
	if err != nil || len(tail.Versions) != 24 || tail.NextCursor != "" {
		t.Fatalf("account older results missing: %+v %v", tail, err)
	}
	for _, item := range append(account.Versions, tail.Versions...) {
		if item.ID == anchor.ID || item.UserID != 11 {
			t.Fatal("deleted/foreign metadata visible")
		}
	}
	for _, args := range []struct {
		user                         int64
		conversation, family, before string
		limit                        int
		want                         error
	}{
		{12, "", "", first.NextCursor, 23, ErrNotFound},
		{11, otherRun.ConversationID, "", first.NextCursor, 23, ErrNotFound},
		{11, "", other.FamilyID, first.NextCursor, 23, ErrNotFound},
		{11, "", "", "bad-cursor", 23, ErrCloudArtifactInvalid},
		{11, "bad-conversation", "", "", 23, ErrCloudArtifactInvalid},
		{11, "", "bad-family", "", 23, ErrCloudArtifactInvalid},
		{11, "", "", "", 0, ErrCloudArtifactInvalid},
		{11, "", "", "", 101, ErrCloudArtifactInvalid},
	} {
		if _, err := store.ListCloudArtifacts(ctx, args.user, args.conversation, args.family, args.before, args.limit); !errors.Is(err, args.want) {
			t.Fatalf("invalid scope/cursor accepted: %v", err)
		}
	}
	// A family spanning conversations remains owner scoped and page-able.
	child := seedArtifactPageVersion(t, f, otherRun, base.Add(2*time.Hour), other.FamilyID)
	family, err := store.ListCloudArtifacts(ctx, 11, "", other.FamilyID, "", 1)
	if err != nil || family.Versions[0].ID != child.ID || family.NextCursor != child.ID {
		t.Fatal("family first page invalid")
	}
	familyTail, err := store.ListCloudArtifacts(ctx, 11, "", other.FamilyID, family.NextCursor, 1)
	if err != nil || len(familyTail.Versions) != 1 || familyTail.Versions[0].ID != other.ID || familyTail.NextCursor != "" {
		t.Fatal("family tail invalid")
	}
}
func TestCloudArtifactPaginationMemoryContract(t *testing.T) {
	runArtifactPaginationContract(t, cloudRunMemoryFixture(t))
}
func TestCloudArtifactPaginationPostgresContract(t *testing.T) {
	f := cloudRunPostgresFixture(t)
	if _, err := f.store.(*PersistentStore).db.Exec(CloudArtifactSchema); err != nil {
		t.Fatal(err)
	}
	runArtifactPaginationContract(t, f)
}
func TestCloudArtifactPaginationHTTP(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	base := cloudRunTestFixture{store: f.store, runs: f.store}
	input := cloudRunTestInput(t, base, 1, f.conversation.ID, uuid.NewString(), "page")
	if _, _, err := f.store.CreateCloudRun(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	run, err := f.store.ClaimCloudRun(context.Background(), "artifact-page-http", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		seedArtifactPageVersion(t, base, run, time.Now().UTC().Truncate(time.Microsecond), "")
	}
	var ids []string
	cursor := ""
	for {
		path := "/api/web-chat/artifacts?limit=2&conversation_id=" + f.conversation.ID + "&before=" + url.QueryEscape(cursor)
		status, body, _ := f.request(t, "GET", path, "file-owner", nil, nil)
		if status != 200 {
			t.Fatalf("page HTTP status %d", status)
		}
		var page CloudArtifactPage
		if err := json.Unmarshal(body, &page); err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Versions {
			ids = append(ids, item.ID)
			if item.ObjectKey != "" || len(item.Journal) > 0 {
				t.Fatal("private list data")
			}
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if len(ids) != 5 || reflect.DeepEqual(ids[:2], ids[2:4]) {
		t.Fatal("HTTP list failed to advance")
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			t.Fatal("HTTP list repeated a version")
		}
		seen[id] = true
	}
	for _, item := range []struct {
		query, token string
		status       int
	}{
		{"limit=0", "file-owner", 400}, {"limit=101", "file-owner", 400}, {"before=bad", "file-owner", 400}, {"before=" + cursor, "file-other", 404}, {"limit=2", "", 401},
	} {
		status, _, _ := f.request(t, "GET", "/api/web-chat/artifacts?"+item.query, item.token, nil, nil)
		if status != item.status {
			t.Fatalf("HTTP malformed/owner status %d expected %d", status, item.status)
		}
	}
}
