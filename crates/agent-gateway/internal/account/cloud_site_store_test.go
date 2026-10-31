package account

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/cloudsite"
)

func siteTestZIP(t *testing.T, title string) ([]byte, cloudsite.Manifest) {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for _, f := range []struct{ name, body string }{
		{"index.html", "<!doctype html><html><meta charset=utf-8><title>" + title + "</title><link rel=stylesheet href=assets/style.css><button id=counter>0</button><script src=assets/app.js></script></html>"},
		{"assets/app.js", "document.getElementById('counter').onclick = e => { e.target.textContent = Number(e.target.textContent)+1 }"},
		{"assets/style.css", "body{font-family:system-ui;padding:24px}button{padding:12px;border-radius:12px}"},
		{"中文.txt", "受控站点资源"},
	} {
		w, err := z.Create(f.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write([]byte(f.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	data := b.Bytes()
	m, err := cloudsite.Inspect(bytes.NewReader(data), int64(len(data)), "")
	if err != nil {
		t.Fatal(err)
	}
	return data, *m
}
func runSiteStoreContract(t *testing.T, f cloudRunTestFixture) {
	t.Helper()
	ctx := context.Background()
	artifacts := f.store.(CloudArtifactStore)
	sites := f.store.(CloudSiteStore)
	_, manifest := siteTestZIP(t, "测试站点")
	run, worker := artifactContractRun(t, f)
	source, _, err := artifacts.ReserveCloudArtifact(ctx, 11, worker, run.Attempt, artifactContractVersion(run))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sites.PutCloudSiteRelease(ctx, 11, source.ID, manifest); !errors.Is(err, ErrNotFound) {
		t.Fatal("staging artifact was hosted", err)
	}
	source, err = artifacts.UpdateCloudArtifact(ctx, 11, source.ID, source.Version, worker, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sites.PutCloudSiteRelease(ctx, 12, source.ID, manifest); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign artifact registered", err)
	}
	release, err := sites.PutCloudSiteRelease(ctx, 11, source.ID, manifest)
	if err != nil || release.SiteID != source.FamilyID || release.SHA256 != source.SHA256 {
		t.Fatal("release not canonical", err)
	}
	again, err := sites.PutCloudSiteRelease(ctx, 11, source.ID, manifest)
	if err != nil || again.CreatedAt != release.CreatedAt {
		t.Fatal("release was recreated", err)
	}
	release.Manifest.Entries[0].SHA256 = strings.Repeat("c", 64)
	read, err := sites.GetCloudSiteRelease(ctx, 11, source.ID)
	if err != nil || read.Manifest.Entries[0].SHA256 != manifest.Entries[0].SHA256 {
		t.Fatal("release alias changed persisted manifest", err)
	}
	if _, err = sites.PutCloudSiteRelease(ctx, 11, source.ID, release.Manifest); !errors.Is(err, ErrCloudSiteConflict) {
		t.Fatal("immutable manifest overwritten", err)
	}
	if _, err = sites.GetCloudSiteRelease(ctx, 12, source.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign release visible", err)
	}
	input := CloudSiteGrant{ID: uuid.NewString(), ReleaseID: source.ID, Mode: "share", RequestHash: strings.Repeat("a", 64), URL: "https://untrusted.example/"}
	g, err := sites.CreateCloudSiteGrant(ctx, 11, input, time.Hour)
	if err != nil || g.SiteID != source.FamilyID || g.Version != 1 || g.URL != "" || g.ExpiresAt.Sub(g.CreatedAt) != time.Hour {
		t.Fatal("grant mismatch", err)
	}
	replay, err := sites.CreateCloudSiteGrant(ctx, 11, input, time.Hour)
	if err != nil || !replay.ExpiresAt.Equal(g.ExpiresAt) {
		t.Fatal("grant retry extended access", err)
	}
	input.RequestHash = strings.Repeat("b", 64)
	if _, err = sites.CreateCloudSiteGrant(ctx, 11, input, time.Hour); !errors.Is(err, ErrCloudSiteConflict) {
		t.Fatal("request ID binding lost", err)
	}
	if _, err = sites.CreateCloudSiteGrant(ctx, 12, input, time.Hour); err == nil {
		t.Fatal("foreign grant accepted")
	}
	if items, err := sites.ListCloudSiteShares(ctx, 12, source.FamilyID); err != nil || len(items) != 0 {
		t.Fatal("shares leaked to another owner", err)
	}
	encoded, _ := json.Marshal(g)
	for _, private := range []string{"user_id", "request_hash", "session_ref"} {
		if strings.Contains(string(encoded), private) {
			t.Fatal("private grant binding exposed", private)
		}
	}
	if _, err = sites.RevokeCloudSiteGrant(ctx, 12, g.ID, g.Version); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign revocation allowed", err)
	}
	if _, err = sites.RevokeCloudSiteGrant(ctx, 11, g.ID, g.Version+1); !errors.Is(err, ErrCloudSiteConflict) {
		t.Fatal("stale revoke accepted", err)
	}
	revoked, err := sites.RevokeCloudSiteGrant(ctx, 11, g.ID, g.Version)
	if err != nil || revoked.RevokedAt == nil || revoked.Version != 2 {
		t.Fatal("revocation not persisted", err)
	}
	if _, err = sites.CreateCloudSiteGrant(ctx, 11, CloudSiteGrant{ID: g.ID, ReleaseID: g.ReleaseID, Mode: g.Mode, RequestHash: g.RequestHash}, time.Hour); !errors.Is(err, ErrCloudSiteConflict) {
		t.Fatal("revoked grant resurrected", err)
	}
	if items, err := sites.ListCloudSiteShares(ctx, 11, source.FamilyID); err != nil || len(items) != 0 {
		t.Fatal("revoked share listed", err)
	}
	input.ID = uuid.NewString()
	if _, err = artifacts.DeleteCloudArtifactFamily(ctx, 11, source.FamilyID); err != nil {
		t.Fatal(err)
	}
	if _, err = sites.CreateCloudSiteGrant(ctx, 11, input, time.Hour); !errors.Is(err, ErrNotFound) {
		t.Fatal("deleted artifact can issue new access", err)
	}
	if _, err = sites.GetCloudSiteRelease(ctx, 11, "not-a-uuid"); !errors.Is(err, ErrNotFound) {
		t.Fatal("invalid lookup exposed database error", err)
	}
}
func TestCloudSiteMemoryStoreContract(t *testing.T) {
	runSiteStoreContract(t, cloudRunMemoryFixture(t))
}
func TestCloudSitePostgresStoreContract(t *testing.T) {
	f := cloudRunPostgresFixture(t)
	if _, err := f.store.(*PersistentStore).db.Exec(CloudSiteSchema); err != nil {
		t.Fatal(err)
	}
	runSiteStoreContract(t, f)
}

func runSitePreparedReleaseContract(t *testing.T, f cloudRunTestFixture) {
	ctx := context.Background()
	artifacts := f.store.(CloudArtifactStore)
	sites := f.store.(CloudSiteStore)
	_, manifest := siteTestZIP(t, "prepared")
	run, worker := artifactContractRun(t, f)
	source, _, err := artifacts.ReserveCloudArtifact(ctx, 11, worker, run.Attempt, artifactContractVersion(run))
	if err != nil {
		t.Fatal(err)
	}
	prepare := func(version int64, owner string, attempt int64) error {
		_, err := sites.PrepareCloudSiteRelease(ctx, 11, source.ID, version, owner, attempt, manifest)
		return err
	}
	if err := prepare(source.Version, worker, run.Attempt); !errors.Is(err, ErrCloudSiteConflict) {
		t.Fatal("unverified object received site metadata", err)
	}
	source, err = artifacts.UpdateCloudArtifact(ctx, 11, source.ID, source.Version, worker, run.Attempt, CloudArtifactUpdate{State: CloudArtifactStaging, Journal: cloudJSON(cloudArtifactJournal{PutStarted: true, ObjectVerified: true})})
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []struct {
		version int64
		owner   string
		attempt int64
	}{
		{source.Version + 1, worker, run.Attempt}, {source.Version, "other-worker", run.Attempt}, {source.Version, worker, run.Attempt + 1},
	} {
		if err := prepare(invalid.version, invalid.owner, invalid.attempt); err == nil {
			t.Fatal("stale or foreign publication lease prepared a site")
		}
	}
	if _, err = sites.PrepareCloudSiteRelease(ctx, 12, source.ID, source.Version, worker, run.Attempt, manifest); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign owner prepared a release", err)
	}
	if err = prepare(source.Version, worker, run.Attempt); err != nil {
		t.Fatal(err)
	}
	grant := CloudSiteGrant{ID: uuid.NewString(), ReleaseID: source.ID, Mode: "share", RequestHash: strings.Repeat("a", 64)}
	if _, err = sites.CreateCloudSiteGrant(ctx, 11, grant, time.Hour); !errors.Is(err, ErrNotFound) {
		t.Fatal("prepared site was accessible before canonical ready", err)
	}
	source, err = artifacts.UpdateCloudArtifact(ctx, 11, source.ID, source.Version, worker, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sites.CreateCloudSiteGrant(ctx, 11, grant, time.Hour); err != nil {
		t.Fatal("verified ready site unavailable", err)
	}
	if err = prepare(source.Version, worker, run.Attempt); !errors.Is(err, ErrCloudSiteConflict) {
		t.Fatal("ready artifact accepted a staging write", err)
	}

	// A worker losing its run lease may not stage a new publication even when
	// the object journal already reports successful verification.
	pending, _, err := artifacts.ReserveCloudArtifact(ctx, 11, worker, run.Attempt, artifactContractVersion(run))
	if err != nil {
		t.Fatal(err)
	}
	pending, err = artifacts.UpdateCloudArtifact(ctx, 11, pending.ID, pending.Version, worker, run.Attempt, CloudArtifactUpdate{State: CloudArtifactStaging, Journal: cloudJSON(cloudArtifactJournal{PutStarted: true, ObjectVerified: true})})
	if err != nil {
		t.Fatal(err)
	}
	f.expire(run.ID)
	if _, err = sites.PrepareCloudSiteRelease(ctx, 11, pending.ID, pending.Version, worker, run.Attempt, manifest); !errors.Is(err, ErrCloudRunLeaseLost) {
		t.Fatal("expired lease prepared a release", err)
	}
}

func TestCloudSitePreparedReleaseMemory(t *testing.T) {
	runSitePreparedReleaseContract(t, cloudRunMemoryFixture(t))
}
func TestCloudSitePreparedReleasePostgres(t *testing.T) {
	f := cloudRunPostgresFixture(t)
	if _, err := f.store.(*PersistentStore).db.Exec(CloudSiteSchema); err != nil {
		t.Fatal(err)
	}
	runSitePreparedReleaseContract(t, f)
}

func runSiteGrantConcurrentBound(t *testing.T, f cloudRunTestFixture) {
	t.Helper()
	ctx := context.Background()
	store := f.store.(CloudSiteStore)
	artifacts := f.store.(CloudArtifactStore)
	_, m := siteTestZIP(t, "bounded")
	run, worker := artifactContractRun(t, f)
	a, _, err := artifacts.ReserveCloudArtifact(ctx, 11, worker, run.Attempt, artifactContractVersion(run))
	if err != nil {
		t.Fatal(err)
	}
	a, err = artifacts.UpdateCloudArtifact(ctx, 11, a.ID, a.Version, worker, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.PutCloudSiteRelease(ctx, 11, a.ID, m); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 120)
	for range 120 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := store.CreateCloudSiteGrant(ctx, 11, CloudSiteGrant{ID: uuid.NewString(), ReleaseID: a.ID, Mode: "share", RequestHash: strings.Repeat("a", 64)}, time.Hour)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, ErrCloudSiteConflict) {
			t.Fatal(err)
		}
	}
	if success != 100 {
		t.Fatal("concurrent sharing bound failed", success)
	}
	items, err := store.ListCloudSiteShares(ctx, 11, a.FamilyID)
	if err != nil || len(items) != 100 {
		t.Fatal("grant list not bounded", len(items), err)
	}
	if _, err = store.RevokeCloudSiteGrant(ctx, 11, items[0].ID, items[0].Version); err != nil {
		t.Fatal(err)
	}
	if _, err = store.CreateCloudSiteGrant(ctx, 11, CloudSiteGrant{ID: uuid.NewString(), ReleaseID: a.ID, Mode: "share", RequestHash: strings.Repeat("a", 64)}, time.Hour); err != nil {
		t.Fatal("revocation did not release slot", err)
	}
}
func TestCloudSiteMemoryConcurrentGrantLimit(t *testing.T) {
	runSiteGrantConcurrentBound(t, cloudRunMemoryFixture(t))
}
func TestCloudSitePostgresConcurrentGrantLimit(t *testing.T) {
	f := cloudRunPostgresFixture(t)
	if _, err := f.store.(*PersistentStore).db.Exec(CloudSiteSchema); err != nil {
		t.Fatal(err)
	}
	runSiteGrantConcurrentBound(t, f)
}

func TestCloudSiteGrantRejectsMalformedAndSubsecond(t *testing.T) {
	g := CloudSiteGrant{ID: uuid.NewString(), ReleaseID: uuid.NewString(), Mode: "private", RequestHash: strings.Repeat("a", 64), SessionRef: strings.Repeat("b", 64)}
	for _, mutate := range []func(*CloudSiteGrant){func(g *CloudSiteGrant) { g.RequestHash = strings.Repeat("z", 64) }, func(g *CloudSiteGrant) { g.SessionRef = strings.Repeat("z", 64) }, func(g *CloudSiteGrant) { g.ID = "00000000-0000-0000-0000-000000000000" }, func(g *CloudSiteGrant) { g.Mode = "public" }} {
		bad := g
		mutate(&bad)
		if validateSiteGrant(11, bad, time.Minute) == nil {
			t.Fatal("malformed grant accepted")
		}
	}
	for _, ttl := range []time.Duration{time.Millisecond, time.Second + time.Millisecond, 16 * time.Minute} {
		if validateSiteGrant(11, g, ttl) == nil {
			t.Fatal("invalid private expiry accepted", ttl)
		}
	}
}
