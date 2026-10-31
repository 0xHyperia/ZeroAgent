package account

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func runSpaceConfiguredLimits(t *testing.T, store Store, configure func(CloudSpaceLimits) error) {
	t.Helper()
	ctx := context.Background()
	files, space := store.(CloudFileStore), store.(CloudSpaceStore)
	p := CloudSpaceLimits{TotalBytes: 1 << 30, FileBytes: 1 << 30, ArtifactBytes: 1 << 30, MaxFiles: 700, MaxArtifactVersions: 800}
	if err := configure(p); err != nil {
		t.Fatal(err)
	}
	for range 520 {
		f := newCloudFileRecord(1, "")
		f.Size = 0
		if _, err := files.CreateCloudFile(ctx, f); err != nil {
			t.Fatalf("configured count still capped at 500: %v", err)
		}
	}
	var first string
	for range 9 {
		f := newCloudFileRecord(1, "")
		f.Size = CloudFileMaxBytes
		saved, err := files.CreateCloudFile(ctx, f)
		if err != nil {
			t.Fatalf("configured bytes still capped at 256 MiB: %v", err)
		}
		first = saved.ID
	}
	page, err := space.QueryCloudSpace(ctx, 1, CloudSpaceQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if page.Usage.FileCount != 529 || page.Usage.FileBytes != 9*CloudFileMaxBytes || page.Usage.LimitBytes != 1<<30 || page.Usage.FileLimitCount != 700 || page.Usage.ArtifactLimitCount != 800 {
		t.Fatalf("configured limits not reflected %+v", page.Usage)
	}
	other, err := space.QueryCloudSpace(ctx, 2, CloudSpaceQuery{})
	if err != nil || other.Usage.LimitBytes != CloudSpaceDefaultBytes || other.Usage.FileLimitCount != 500 {
		t.Fatalf("quota leaked across owners %+v %v", other, err)
	}
	p.TotalBytes, p.FileBytes, p.ArtifactBytes = 20, 20, 20
	if err = configure(p); err != nil {
		t.Fatal(err)
	}
	f := newCloudFileRecord(1, "")
	f.Size = 0
	if _, err = files.CreateCloudFile(ctx, f); !errors.Is(err, ErrCloudFileQuota) {
		t.Fatal("downgrade allowed new reservation", err)
	}
	if _, err = files.GetCloudFile(ctx, 1, first); err != nil {
		t.Fatal("downgrade removed an original", err)
	}
	if _, err = space.QueryCloudSpace(ctx, 1, CloudSpaceQuery{Cursor: page.NextCursor}); !errors.Is(err, ErrCloudSpacePageChanged) {
		t.Fatal("quota change mixed old/new pages", err)
	}
	updated, err := space.QueryCloudSpace(ctx, 1, CloudSpaceQuery{})
	if err != nil || updated.Usage.FileCount != 529 || updated.Usage.FileBytes != page.Usage.FileBytes || updated.Usage.LimitBytes != 20 {
		t.Fatalf("downgrade lost stored reservations %+v %v", updated, err)
	}
}
func TestCloudSpaceConfiguredLimitsMemory(t *testing.T) {
	s := NewMemoryStore()
	runSpaceConfiguredLimits(t, s, func(p CloudSpaceLimits) error {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.cloudSpacePolicies = map[int64]CloudSpaceLimits{1: p}
		return nil
	})
}
func TestCloudSpaceConfiguredLimitsPostgres(t *testing.T) {
	s := cloudRunPostgresFixture(t).store.(*PersistentStore)
	runSpaceConfiguredLimits(t, s, func(p CloudSpaceLimits) error { return ConfigureCloudSpaceLimits(context.Background(), s.db, 1, p) })
}

func TestCloudSpaceExistingTotalQuotaKeepsCategoryLimits(t *testing.T) {
	s := cloudRunPostgresFixture(t).store.(*PersistentStore)
	ctx := context.Background()
	if _, err := s.db.Exec(`INSERT INTO zeroagent_cloud_space_limits(user_id,limit_bytes)VALUES(1,1073741824)`); err != nil {
		t.Fatal(err)
	}
	for range 8 {
		file := newCloudFileRecord(1, "")
		file.Size = CloudFileMaxBytes
		if _, err := s.CreateCloudFile(ctx, file); err != nil {
			t.Fatal(err)
		}
	}
	file := newCloudFileRecord(1, "")
	file.Size = 1
	if _, err := s.CreateCloudFile(ctx, file); !errors.Is(err, ErrCloudFileQuota) {
		t.Fatal("existing total-only configuration silently increased original quota", err)
	}
	page, err := s.QueryCloudSpace(ctx, 1, CloudSpaceQuery{})
	if err != nil || page.Usage.FileLimitBytes != CloudFileMaxAccountBytes || page.Usage.FileLimitCount != CloudFileMaxAccountFiles {
		t.Fatal("existing category limits changed", err)
	}
}
func TestCloudSpacePostgresQuotaSerializesUnknownArtifactsAndUploads(t *testing.T) {
	s := cloudRunPostgresFixture(t).store.(*PersistentStore)
	ctx := context.Background()
	p := CloudSpaceLimits{TotalBytes: 20, FileBytes: 20, ArtifactBytes: 20, MaxFiles: 1000, MaxArtifactVersions: 1000}
	if err := ConfigureCloudSpaceLimits(ctx, s.db, 1, p); err != nil {
		t.Fatal(err)
	}
	family, conversation, version := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := s.db.Exec(`INSERT INTO zeroagent_cloud_artifact_families(id,user_id,conversation_id,created_at)VALUES($1,1,$2,clock_timestamp())`, family, conversation); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO zeroagent_cloud_artifact_versions(id,family_id,user_id,conversation_id,source_run_id,tool_operation_id,request_hash,number,object_key,name,mime,size,sha256,state,created_at,updated_at)VALUES($1,$2,1,$3,$4,$5,repeat('a',64),1,$6,'unknown.txt','text/plain',15,repeat('b',64),'unknown',clock_timestamp(),clock_timestamp())`, version, family, conversation, uuid.NewString(), uuid.NewString(), "quota/"+version); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 8)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f := newCloudFileRecord(1, "")
			f.Size = 4
			_, err := s.CreateCloudFile(ctx, f)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	accepted := 0
	for err := range results {
		if err == nil {
			accepted++
		} else if !errors.Is(err, ErrCloudFileQuota) {
			t.Fatal(err)
		}
	}
	if accepted != 1 {
		t.Fatalf("combined concurrent reservation accepted %d uploads", accepted)
	}
	page, err := s.QueryCloudSpace(ctx, 1, CloudSpaceQuery{})
	if err != nil || page.Usage.UsedBytes != 19 {
		t.Fatalf("unknown artifact released quota %+v %v", page, err)
	}
	invalid := p
	invalid.MaxFiles = 0
	if err = ConfigureCloudSpaceLimits(ctx, s.db, 1, invalid); !errors.Is(err, ErrCloudFileInvalid) {
		t.Fatal("unbounded file count accepted", err)
	}
}
