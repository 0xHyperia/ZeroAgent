package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
)

func runCloudSpaceSiteContract(t *testing.T, f cloudRunTestFixture) {
	ctx := context.Background()
	artifacts, sites, space := f.store.(CloudArtifactStore), f.store.(CloudSiteStore), f.store.(CloudSpaceStore)
	run, worker := artifactContractRun(t, f)
	data, manifest := siteTestZIP(t, "space site")
	reserve := func(family string) *CloudArtifactVersion {
		input := artifactContractVersion(run)
		if family != "" {
			input.FamilyID = family
		}
		input.Name, input.MIME, input.Size, input.SHA256 = "site.zip", "application/zip", int64(len(data)), archiveDigest(data)
		a, _, err := artifacts.ReserveCloudArtifact(ctx, 11, worker, run.Attempt, input)
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	update := func(a *CloudArtifactVersion, state string) *CloudArtifactVersion {
		a, err := artifacts.UpdateCloudArtifact(ctx, 11, a.ID, a.Version, worker, run.Attempt, CloudArtifactUpdate{State: state, Journal: cloudJSON(cloudArtifactJournal{PutStarted: true, ObjectVerified: true})})
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	query := func(q CloudSpaceQuery) *CloudSpacePage {
		page, err := space.QueryCloudSpace(ctx, 11, q)
		if err != nil {
			t.Fatal(err)
		}
		return page
	}
	a := update(reserve(""), CloudArtifactReady)
	before := query(CloudSpaceQuery{Category: "sites"})
	if before.Total != 0 {
		t.Fatal("unregistered ZIP classified as site")
	}
	if _, err := sites.PutCloudSiteRelease(ctx, 11, a.ID, manifest); err != nil {
		t.Fatal(err)
	}
	page := query(CloudSpaceQuery{Category: "sites"})
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].Kind != "artifact" || page.Items[0].ID != a.FamilyID || page.Items[0].TargetID != a.ID || page.Items[0].SiteVersionID != a.ID || page.Usage.UsedBytes != before.Usage.UsedBytes {
		t.Fatal("site projection duplicates content or loses canonical identity")
	}
	if other, err := space.QueryCloudSpace(ctx, 12, CloudSpaceQuery{Category: "sites"}); err != nil || other.Total != 0 {
		t.Fatal("site projection crossed account", err)
	}
	folder := CloudSpaceMetadata{ID: uuid.NewString(), Kind: "folder", Name: "站点"}
	if _, err := space.PutCloudSpaceMetadata(ctx, 11, folder); err != nil {
		t.Fatal(err)
	}
	meta, err := space.PutCloudSpaceMetadata(ctx, 11, CloudSpaceMetadata{ID: a.FamilyID, Kind: "artifact", Name: "我的决策站点", FolderID: folder.ID, Starred: true})
	if err != nil {
		t.Fatal(err)
	}
	page = query(CloudSpaceQuery{Category: "sites", Scope: "starred", Folder: folder.ID, Query: "决策"})
	if page.Total != 1 || page.Items[0].SiteVersionID != a.ID || page.Items[0].Name != meta.Name {
		t.Fatal("site metadata/search diverged from artifact family")
	}
	second := reserve(a.FamilyID)
	page = query(CloudSpaceQuery{Category: "sites"})
	if page.Total != 1 || page.Items[0].TargetID != second.ID || page.Items[0].SiteVersionID != a.ID {
		t.Fatal("new build hid previous ready site")
	}
	second = update(second, CloudArtifactStaging)
	if _, err = sites.PrepareCloudSiteRelease(ctx, 11, second.ID, second.Version, worker, run.Attempt, manifest); err != nil {
		t.Fatal(err)
	}
	page = query(CloudSpaceQuery{Category: "sites"})
	if page.Items[0].SiteVersionID != a.ID {
		t.Fatal("staging manifest advertised before artifact ready")
	}
	second = update(second, CloudArtifactReady)
	page = query(CloudSpaceQuery{Category: "sites"})
	if page.Items[0].SiteVersionID != second.ID || page.Items[0].Versions != 2 || page.Usage.ArtifactVersionCount != 2 || page.Usage.UsedBytes != 2*int64(len(data)) {
		t.Fatal("ready site version or accounting lost")
	}
	snapshot, err := space.ReadCloudSpace(ctx, 11)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range snapshot.Items {
		if item.ID == a.FamilyID {
			found = true
			if item.SiteVersionID != second.ID {
				t.Fatal("snapshot and paged site projections disagree")
			}
		}
	}
	if !found {
		t.Fatal("site missing from canonical snapshot")
	}
	meta.Trashed = true
	meta, err = space.PutCloudSpaceMetadata(ctx, 11, *meta)
	if err != nil {
		t.Fatal(err)
	}
	if query(CloudSpaceQuery{Category: "sites"}).Total != 0 || query(CloudSpaceQuery{Category: "sites", Scope: "trash"}).Total != 1 {
		t.Fatal("site trash diverged from artifact metadata")
	}
	meta.Trashed = false
	if _, err = space.PutCloudSpaceMetadata(ctx, 11, *meta); err != nil {
		t.Fatal(err)
	}
	if _, err = artifacts.DeleteCloudArtifactFamily(ctx, 11, a.FamilyID); err != nil {
		t.Fatal(err)
	}
	if query(CloudSpaceQuery{Category: "sites"}).Total != 0 {
		t.Fatal("deleted source site still listed")
	}
}

func TestCloudSpaceSitesMemory(t *testing.T) { runCloudSpaceSiteContract(t, cloudRunMemoryFixture(t)) }
func TestCloudSpaceSitesPostgres(t *testing.T) {
	runCloudSpaceSiteContract(t, cloudRunPostgresFixture(t))
}

func runCloudSpaceSiteRevision(t *testing.T, f cloudRunTestFixture) {
	ctx := context.Background()
	artifacts, space, sites := f.store.(CloudArtifactStore), f.store.(CloudSpaceStore), f.store.(CloudSiteStore)
	run, worker := artifactContractRun(t, f)
	var ready *CloudArtifactVersion
	for i := 0; i < 52; i++ {
		input := artifactContractVersion(run)
		input.Name = fmt.Sprintf("%03d.zip", i)
		a, _, err := artifacts.ReserveCloudArtifact(ctx, 11, worker, run.Attempt, input)
		if err != nil {
			t.Fatal(err)
		}
		a, err = artifacts.UpdateCloudArtifact(ctx, 11, a.ID, a.Version, worker, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
		if err != nil {
			t.Fatal(err)
		}
		ready = a
	}
	first, err := space.QueryCloudSpace(ctx, 11, CloudSpaceQuery{})
	if err != nil || first.NextCursor == "" {
		t.Fatal("site revision fixture is not paginated", err)
	}
	_, manifest := siteTestZIP(t, "cursor")
	if _, err = sites.PutCloudSiteRelease(ctx, 11, ready.ID, manifest); err != nil {
		t.Fatal(err)
	}
	if _, err = space.QueryCloudSpace(ctx, 11, CloudSpaceQuery{Cursor: first.NextCursor}); !errors.Is(err, ErrCloudSpacePageChanged) {
		t.Fatal("site-only change did not invalidate old projection", err)
	}
}
func TestCloudSpaceSiteRevisionMemory(t *testing.T) {
	runCloudSpaceSiteRevision(t, cloudRunMemoryFixture(t))
}
func TestCloudSpaceSiteRevisionPostgres(t *testing.T) {
	runCloudSpaceSiteRevision(t, cloudRunPostgresFixture(t))
}

func TestCloudSpaceSiteHTTPRoute(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	data, manifest := siteTestZIP(t, "HTTP site")
	a := siteHTTPArtifact(t, f, "", data)
	if _, err := f.store.PutCloudSiteRelease(context.Background(), 1, a.ID, manifest); err != nil {
		t.Fatal(err)
	}
	status, body, _ := f.request(t, "GET", "/api/web-chat/space?category=sites", "file-owner", nil, nil)
	var page CloudSpacePage
	if status != 200 || json.Unmarshal(body, &page) != nil || page.Total != 1 || page.Items[0].SiteVersionID != a.ID {
		t.Fatal("site query rejected at HTTP boundary", status)
	}
	status, body, _ = f.request(t, "GET", "/api/web-chat/space?category=sites", "file-other", nil, nil)
	if status != 200 || json.Unmarshal(body, &page) != nil || page.Total != 0 {
		t.Fatal("site HTTP query crossed account", status)
	}
}
