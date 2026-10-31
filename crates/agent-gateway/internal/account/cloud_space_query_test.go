package account

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func runSpacePaginationContract(t *testing.T, store Store) {
	t.Helper()
	ctx := context.Background()
	files, space := store.(CloudFileStore), store.(CloudSpaceStore)
	ids := []string{}
	for i := range 123 {
		file := newCloudFileRecord(1, "")
		file.Name = []string{"A.txt", "a.txt", "季度资料.txt", "文档.txt"}[i%4]
		file.Size = int64(i%5 + 1)
		saved, err := files.CreateCloudFile(ctx, file)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, saved.ID)
	}
	folder, err := space.PutCloudSpaceMetadata(ctx, 1, CloudSpaceMetadata{ID: uuid.NewString(), Kind: "folder", Name: "项目"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = space.PutCloudSpaceMetadata(ctx, 1, CloudSpaceMetadata{ID: ids[0], Kind: "file", FolderID: folder.ID, Starred: true}); err != nil {
		t.Fatal(err)
	}
	if _, err = space.PutCloudSpaceMetadata(ctx, 1, CloudSpaceMetadata{ID: ids[1], Kind: "file", Trashed: true}); err != nil {
		t.Fatal(err)
	}
	for _, order := range []string{"updated", "name", "size"} {
		q := CloudSpaceQuery{Sort: order}
		seen := map[string]bool{}
		var prior *CloudSpaceItem
		pages := 0
		for {
			page, err := space.QueryCloudSpace(ctx, 1, q)
			if err != nil {
				t.Fatal(order, err)
			}
			if len(page.Items) > 50 || page.Total != 122 || page.Usage.FileCount != 123 || len(page.Folders) != 1 || len(page.Pinned) != 1 {
				t.Fatalf("unbounded or incomplete %s page: %+v", order, page)
			}
			for _, item := range page.Items {
				key := item.Kind + ":" + item.ID
				if seen[key] {
					t.Fatalf("repeated %s item %s", order, key)
				}
				seen[key] = true
				if prior != nil && prior.Kind != "folder" && item.Kind == "folder" {
					t.Fatal("folder ordering changed across pages")
				}
				if prior != nil && prior.Kind != "folder" && item.Kind != "folder" {
					if order == "name" && strings.ToLower(prior.Name) > strings.ToLower(item.Name) {
						t.Fatal("name ordering changed across cursor")
					}
					if order == "size" && prior.Size < item.Size {
						t.Fatal("size ordering changed across cursor")
					}
				}
				copy := item
				prior = &copy
			}
			pages++
			if page.NextCursor == "" {
				break
			}
			q.Cursor = page.NextCursor
			if pages > 4 {
				t.Fatal("pagination failed to terminate")
			}
		}
		if len(seen) != 122 || pages != 3 {
			t.Fatalf("lost items: %s %d/%d", order, len(seen), pages)
		}
	}
	first, err := space.QueryCloudSpace(ctx, 1, CloudSpaceQuery{})
	if err != nil {
		t.Fatal(err)
	}
	// A different account's write must not invalidate this account's cursor.
	if _, err = files.CreateCloudFile(ctx, newCloudFileRecord(2, "")); err != nil {
		t.Fatal(err)
	}
	if _, err = space.QueryCloudSpace(ctx, 1, CloudSpaceQuery{Cursor: first.NextCursor}); err != nil {
		t.Fatal(err)
	}
	if _, err = space.QueryCloudSpace(ctx, 2, CloudSpaceQuery{Cursor: first.NextCursor}); !errors.Is(err, ErrCloudFileInvalid) {
		t.Fatal("foreign owner cursor accepted", err)
	}
	if _, err = space.QueryCloudSpace(ctx, 1, CloudSpaceQuery{Cursor: first.NextCursor, Sort: "size"}); !errors.Is(err, ErrCloudFileInvalid) {
		t.Fatal("cursor reused for another order", err)
	}
	if _, err = space.QueryCloudSpace(ctx, 1, CloudSpaceQuery{Cursor: first.NextCursor, Query: "季度"}); !errors.Is(err, ErrCloudFileInvalid) {
		t.Fatal("cursor reused for another search", err)
	}
	if _, err = space.PutCloudSpaceMetadata(ctx, 1, CloudSpaceMetadata{ID: ids[2], Kind: "file", Name: "重命名资料.txt"}); err != nil {
		t.Fatal(err)
	}
	if _, err = space.QueryCloudSpace(ctx, 1, CloudSpaceQuery{Cursor: first.NextCursor}); !errors.Is(err, ErrCloudSpacePageChanged) {
		t.Fatal("mixed library generations accepted", err)
	}
	trash, err := space.QueryCloudSpace(ctx, 1, CloudSpaceQuery{Scope: "trash"})
	if err != nil || trash.Total != 1 || trash.Usage.TrashBytes != 2 {
		t.Fatalf("trash quota/list lost %+v %v", trash, err)
	}
	inFolder, err := space.QueryCloudSpace(ctx, 1, CloudSpaceQuery{Folder: folder.ID})
	if err != nil || inFolder.Total != 1 || inFolder.Items[0].ID != ids[0] {
		t.Fatalf("folder lost %+v %v", inFolder, err)
	}
	search, err := space.QueryCloudSpace(ctx, 1, CloudSpaceQuery{Query: "重命名"})
	if err != nil || search.Total != 1 {
		t.Fatalf("server search failed %+v %v", search, err)
	}
}
func TestCloudSpaceCursorMemory(t *testing.T) { runSpacePaginationContract(t, NewMemoryStore()) }
func TestCloudSpaceCursorPostgres(t *testing.T) {
	runSpacePaginationContract(t, cloudRunPostgresFixture(t).store)
}

func TestCloudSpacePostgresProjectionAndTransactionalFence(t *testing.T) {
	f := cloudRunPostgresFixture(t)
	s := f.store.(*PersistentStore)
	ctx := context.Background()
	family, conversation := uuid.NewString(), uuid.NewString()
	_, err := s.db.ExecContext(ctx, `INSERT INTO zeroagent_cloud_artifact_families(id,user_id,conversation_id,created_at)VALUES($1,1,$2,clock_timestamp())`, family, conversation)
	if err != nil {
		t.Fatal(err)
	}
	latest := ""
	for number := 1; number <= 3; number++ {
		id := uuid.NewString()
		if number == 2 {
			latest = id
		}
		state, deleted := "ready", "NULL"
		if number == 3 {
			state, deleted = "deleting", "clock_timestamp()"
		}
		_, err = s.db.ExecContext(ctx, `INSERT INTO zeroagent_cloud_artifact_versions(id,family_id,user_id,conversation_id,source_run_id,tool_operation_id,request_hash,number,object_key,name,mime,size,sha256,state,created_at,updated_at,deleted_at)
 VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,'text/plain',10,$6,$10,clock_timestamp(),clock_timestamp(),`+deleted+`)`, id, family, conversation, uuid.NewString(), uuid.NewString(), strings.Repeat("a", 64), number, "projection/"+id, fmt.Sprintf("成果%d.txt", number), state)
		if err != nil {
			t.Fatal(err)
		}
	}
	p, err := s.QueryCloudSpace(ctx, 1, CloudSpaceQuery{Category: "outputs"})
	if err != nil {
		t.Fatal(err)
	}
	if p.Total != 1 || p.Items[0].TargetID != latest || p.Items[0].Versions != 2 || p.Usage.ArtifactBytes != 30 || p.Usage.ArtifactVersionCount != 3 {
		t.Fatalf("canonical artifact projection lost %+v", p)
	}
	var before, after int64
	if err = s.db.QueryRow(`SELECT generation FROM zeroagent_cloud_space_revisions WHERE user_id=1`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_artifact_versions SET version=version+1 WHERE id=$1`, latest); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRow(`SELECT generation FROM zeroagent_cloud_space_revisions WHERE user_id=1`).Scan(&after); err != nil || after != before {
		t.Fatalf("rollback invalidated cursor %d %d %v", before, after, err)
	}
}

func TestCloudSpaceRevisionFenceDuringFamilyDeleteAndVersionUpdates(t *testing.T) {
	s := cloudRunPostgresFixture(t).store.(*PersistentStore)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	family, conversation := uuid.NewString(), uuid.NewString()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO zeroagent_cloud_artifact_families(id,user_id,conversation_id,created_at)VALUES($1,1,$2,clock_timestamp())`, family, conversation); err != nil {
		t.Fatal(err)
	}
	rows, err := s.db.QueryContext(ctx, `INSERT INTO zeroagent_cloud_artifact_versions(id,family_id,number,user_id,conversation_id,source_run_id,tool_operation_id,request_hash,object_key,name,mime,size,sha256,state,created_at,updated_at)
 SELECT gen_random_uuid(),$1::uuid,n,1,$2::uuid,gen_random_uuid(),gen_random_uuid(),repeat('a',64),($1::uuid)::text||'/'||n::text,'result.txt','text/plain',10,repeat('b',64),'ready',clock_timestamp(),clock_timestamp() FROM generate_series(1,24)n RETURNING id::text`, family, conversation)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 9)
	var wg sync.WaitGroup
	for _, id := range ids[:8] {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			<-start
			_, err := s.UpdateCloudArtifact(ctx, 1, id, 1, "", 0, CloudArtifactUpdate{State: CloudArtifactDeleting})
			results <- err
		}(id)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		_, err := s.DeleteCloudArtifactFamily(ctx, 1, family)
		results <- err
	}()
	close(start)
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil && !errors.Is(err, ErrCloudArtifactConflict) {
			t.Fatal("concurrent family/version mutation failed", err)
		}
	}
	page, err := s.QueryCloudSpace(ctx, 1, CloudSpaceQuery{Category: "outputs"})
	if err != nil || page.Total != 0 || page.Usage.ArtifactBytes != 240 || page.Usage.ArtifactVersionCount != 24 {
		t.Fatalf("delete/cleanup released unconfirmed bytes %+v %v", page, err)
	}
}
