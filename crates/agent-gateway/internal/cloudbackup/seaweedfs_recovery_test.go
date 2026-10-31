package cloudbackup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

// Runs only in the explicitly created network-isolated recovery fixture. The
// actual production backup/restore engine reads real PostgreSQL, Redis, SQLite
// journals and two independently authorized SeaweedFS buckets.
func TestCloudBackupSeaweedFSRecovery(t *testing.T) {
	configPath := os.Getenv("ZEROAGENT_SEAWEEDFS_RECOVERY_CONFIG")
	if configPath == "" {
		t.Skip("explicit disposable SeaweedFS recovery fixture required")
	}
	encoded, err := os.ReadFile(configPath)
	if err != nil || len(encoded) > 16<<10 {
		t.Fatal("read disposable recovery configuration")
	}
	var private struct{ TaskID, SourceKey, SourceSecret, TargetKey, TargetSecret string }
	if json.Unmarshal(encoded, &private) != nil || !regexp.MustCompile(`^[a-f0-9]{16}$`).MatchString(private.TaskID) {
		t.Fatal("invalid recovery fixture identity")
	}
	base, redisURL := os.Getenv("ZEROAGENT_BACKUP_TEST_DATABASE_URL"), os.Getenv("ZEROAGENT_BACKUP_TEST_REDIS_URL")
	node, pg := os.Getenv("ZEROAGENT_BACKUP_TEST_NODE"), os.Getenv("ZEROAGENT_BACKUP_TEST_PG_BIN")
	helper, ledger := os.Getenv("ZEROAGENT_BACKUP_TEST_JOURNAL_HELPER"), os.Getenv("ZEROAGENT_BACKUP_TEST_LEDGER")
	if base == "" || redisURL == "" || node == "" || pg == "" || helper == "" || ledger == "" {
		t.Fatal("missing explicit recovery runtime")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	openObjects := func(bucket, key, secret string) *S3 {
		store, err := NewS3(objectstore.Config{Endpoint: "http://127.0.0.1:18333", Bucket: bucket + private.TaskID, Region: "us-east-1", AccessKeyID: key, SecretAccessKey: secret, AllowLoopbackHTTP: true})
		if err != nil {
			t.Fatal("create recovery object store")
		}
		t.Cleanup(store.Close)
		if err = store.InitializeBucket(ctx); err != nil {
			t.Fatal("initialize isolated recovery bucket")
		}
		return store
	}
	sourceObjects := openObjects("za-backup-source-", private.SourceKey, private.SourceSecret)
	targetObjects := openObjects("za-backup-target-", private.TargetKey, private.TargetSecret)
	sourceDSN, sourceDB := backupDatabase(t, base)
	if _, err = sourceDB.ExecContext(ctx, `CREATE SCHEMA cloudapp`); err != nil {
		t.Fatal("create source schema")
	}
	source, err := account.OpenPersistentStore(ctx, sourceDSN, recoverySessionRedisURL(t, redisURL, 14))
	if err != nil {
		t.Fatal("create canonical source database")
	}
	t.Cleanup(func() { source.Close() })
	sourceRedis, targetRedis := backupRedis(t, redisURL, 14), backupRedis(t, redisURL, 15)
	conversationID := uuid.NewString()
	if err = source.PutCloudConversation(ctx, &account.CloudConversation{ID: conversationID, UserID: 7, Title: "SeaweedFS recovery", CreatedAt: time.Now(), UpdatedAt: time.Now()}); err != nil {
		t.Fatal("seed canonical conversation")
	}
	fileID, familyID, versionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	ownerHash := sha256.Sum256([]byte("7"))
	owner := hex.EncodeToString(ownerHash[:16])
	fileKey := "accounts/" + owner + "/files/" + fileID + "/original"
	artifactKey := "accounts/" + owner + "/artifacts/" + familyID + "/" + versionID + "/content"
	fileBytes, artifactBytes := []byte("中文原件：恢复之后仍可引用。\n"), []byte("name,value\nrestored,42\n")
	for _, resource := range []struct {
		key, mime string
		body      []byte
		metadata  map[string]string
	}{
		{fileKey, "text/plain", fileBytes, map[string]string{"file-id": fileID, "owner-scope": owner}},
		{artifactKey, "text/csv", artifactBytes, map[string]string{"artifact-version": versionID, "artifact-family": familyID, "owner-scope": "account-" + owner}},
	} {
		if _, err = sourceObjects.Put(ctx, resource.key, bytes.NewReader(resource.body), int64(len(resource.body)), objectstore.PutOptions{ContentType: resource.mime, SHA256: testDigest(resource.body), Metadata: resource.metadata}); err != nil {
			t.Fatal("persist real source bytes")
		}
	}
	file, err := source.CreateCloudFile(ctx, &account.CloudFile{ID: fileID, UserID: 7, ConversationID: conversationID, ObjectKey: fileKey, Name: "原件.txt", MIME: "text/plain", Size: int64(len(fileBytes)), SHA256: testDigest(fileBytes), State: account.CloudFileUploading})
	if err != nil {
		t.Fatal("create canonical original")
	}
	file, err = source.UpdateCloudFile(ctx, 7, fileID, file.Version, account.CloudFileUpdate{State: account.CloudFileUploaded, MarkUploaded: true})
	if err != nil {
		t.Fatal("confirm canonical original")
	}
	text := string(fileBytes)
	file, err = source.UpdateCloudFile(ctx, 7, fileID, file.Version, account.CloudFileUpdate{State: account.CloudFileProcessing})
	if err != nil {
		t.Fatal("prepare canonical text")
	}
	if _, err = source.UpdateCloudFile(ctx, 7, fileID, file.Version, account.CloudFileUpdate{State: account.CloudFileReady, Text: &text}); err != nil {
		t.Fatal("confirm canonical text")
	}
	if _, err = sourceDB.ExecContext(ctx, `INSERT INTO cloudapp.zeroagent_cloud_artifact_families(id,user_id,conversation_id,created_at)VALUES($1,7,$2,clock_timestamp())`, familyID, conversationID); err != nil {
		t.Fatal("seed artifact family")
	}
	if _, err = sourceDB.ExecContext(ctx, `INSERT INTO cloudapp.zeroagent_cloud_artifact_versions(id,family_id,number,user_id,conversation_id,source_run_id,tool_operation_id,request_hash,object_key,name,mime,size,sha256,state,created_at,updated_at)VALUES($1,$2,1,7,$3,$4,$5,$6,$7,'result.csv','text/csv',$8,$9,'ready',clock_timestamp(),clock_timestamp())`, versionID, familyID, conversationID, uuid.NewString(), uuid.NewString(), string(bytes.Repeat([]byte("a"), 64)), artifactKey, len(artifactBytes), testDigest(artifactBytes)); err != nil {
		t.Fatal("seed immutable artifact version", err)
	}
	folderID := uuid.NewString()
	if _, err = source.PutCloudSpaceMetadata(ctx, 7, account.CloudSpaceMetadata{ID: folderID, Kind: "folder", Name: "恢复后的项目资料"}); err != nil {
		t.Fatal("seed folder")
	}
	if _, err = source.PutCloudSpaceMetadata(ctx, 7, account.CloudSpaceMetadata{ID: fileID, Kind: "file", Name: "保留的显示名称.txt", FolderID: folderID, Starred: true}); err != nil {
		t.Fatal("seed organization metadata")
	}
	quota := account.CloudSpaceLimits{TotalBytes: 3 << 30, FileBytes: 2 << 30, ArtifactBytes: 2 << 30, MaxFiles: 4000, MaxArtifactVersions: 5000}
	if err = account.ConfigureCloudSpaceLimits(ctx, sourceDB, 7, quota); err != nil {
		t.Fatal("seed explicit personal space limits", err)
	}
	root := t.TempDir()
	savedSite := seedSeaweedRecoverySite(t, ctx, source, sourceDB, sourceObjects, conversationID)
	if err = os.Chmod(root, 0700); err != nil {
		t.Fatal("make recovery workspace private")
	}
	protected := mustJSON(protectedConfiguration{Format: 1, ExecutorNamespace: "zeroagent-seaweed-recovery", ExecutorScopeKey: "synthetic-seaweed-recovery-authority-123456", Files: map[string]string{"gateway.env": recoverySiteConfig, "executor.env": "synthetic executor config"}})
	authority, err := configurationAuthority(protected)
	if err != nil {
		t.Fatal(err)
	}
	protectedPath := filepath.Join(root, "private-config.json")
	if os.WriteFile(protectedPath, protected, 0600) != nil {
		t.Fatal("seed protected configuration")
	}
	journal := filepath.Join(root, "source-journal")
	seedBackupJournal(t, node, ledger, journal, authority)
	cfg := Config{DatabaseURL: sourceDSN, ExpectedDatabase: testDatabaseName(sourceDSN), Schema: "cloudapp", Scope: "isolated-seaweedfs-recovery-" + private.TaskID, PGDumpPath: filepath.Join(pg, "pg_dump"), PGRestorePath: filepath.Join(pg, "pg_restore"), NodePath: node, JournalHelperPath: helper, JournalDirectory: journal, ExpectedJournalAuthority: authority, ProtectedConfigSource: protectedPath, BackupEncryptionKey: bytes.Repeat([]byte("s"), 32), AllowMutations: true, Timeout: 2 * time.Minute}
	engine := &Engine{Config: cfg, DB: sourceDB, Redis: sourceRedis, Objects: sourceObjects}
	bundle := filepath.Join(root, "backup")
	manifest, err := engine.Create(ctx, bundle)
	if err != nil || len(manifest.Resources) != 4 {
		t.Fatal("create real storage backup candidate", err)
	}
	if _, err = engine.Verify(ctx, bundle); err != nil {
		t.Fatal("verify real source backup", err)
	}
	targetDSN, targetDB := backupDatabase(t, base)
	var targetTables int
	if err = targetDB.QueryRowContext(ctx, `SELECT count(*) FROM pg_tables WHERE schemaname NOT IN('pg_catalog','information_schema')`).Scan(&targetTables); err != nil || targetTables != 0 {
		t.Fatal("disposable target database was populated before restore", targetTables, err)
	}
	targetCfg := cfg
	targetCfg.DatabaseURL, targetCfg.ExpectedDatabase = targetDSN, testDatabaseName(targetDSN)
	targetCfg.JournalDirectory, targetCfg.RestoredConfigPath = filepath.Join(root, "target-journal"), filepath.Join(root, "target-config.json")
	target := &Engine{Config: targetCfg, DB: targetDB, Redis: targetRedis, Objects: targetObjects}
	if err = targetRedis.Set(ctx, "zeroagent:web-session:old-recovery-cookie", "synthetic revoked cookie", time.Hour).Err(); err != nil {
		t.Fatal("seed target authentication canary")
	}
	if err = targetRedis.Set(ctx, "unrelated:must-remain", "preserved", time.Hour).Err(); err != nil {
		t.Fatal("seed unrelated canary")
	}
	report, err := target.Restore(ctx, bundle, targetCfg.Scope, targetCfg.ExpectedDatabase, filepath.Join(root, "restore-report.json"))
	if err != nil || report == nil || !report.Complete || !report.AuthInvalidated || !report.WriteSemanticsVerified {
		var probe *ConditionalWriteError
		if errors.As(err, &probe) {
			details, _ := json.Marshal(probe.Probe)
			t.Logf("conditional probe: %s", details)
		}
		t.Fatalf("guarded real SeaweedFS restore phase=%v error=%v", report, err)
	}
	if targetRedis.Exists(ctx, "zeroagent:web-session:old-recovery-cookie").Val() != 0 || targetRedis.Get(ctx, "unrelated:must-remain").Val() != "preserved" {
		t.Fatal("restore authentication isolation")
	}
	if _, err = target.Verify(ctx, bundle); err != nil {
		t.Fatal("verify restored bytes and canonical references", err)
	}
	verifySeaweedRecoverySite(t, ctx, targetDSN, redisURL, targetCfg.RestoredConfigPath, targetObjects, savedSite)
	for _, resource := range manifest.Resources {
		original, err := sourceObjects.Get(ctx, resource.Key)
		if err != nil {
			t.Fatal("restore changed source storage")
		}
		body, readErr := io.ReadAll(original.Body)
		original.Body.Close()
		if readErr != nil || testDigest(body) != resource.SHA256 {
			t.Fatal("source bytes no longer match")
		}
	}
	var name, folder string
	var starred bool
	if err = targetDB.QueryRowContext(ctx, `SELECT name,folder_id::text,starred FROM cloudapp.zeroagent_cloud_space_metadata WHERE user_id=7 AND kind='file' AND id=$1`, fileID).Scan(&name, &folder, &starred); err != nil || name != "保留的显示名称.txt" || folder != folderID || !starred {
		t.Fatal("restored organization metadata differs")
	}
	restoredQuota, err := account.ReadCloudSpaceLimits(ctx, targetDB, 7)
	if err != nil || restoredQuota != quota {
		t.Fatal("restored personal space quota differs", err)
	}
	if _, err = target.Restore(ctx, bundle, targetCfg.Scope, targetCfg.ExpectedDatabase, filepath.Join(root, "retry-report.json")); !errors.Is(err, ErrTargetNotEmpty) {
		t.Fatal("repeat restore did not reject populated target")
	}
	if output := os.Getenv("ZEROAGENT_SEAWEEDFS_RECOVERY_EVIDENCE"); output != "" {
		evidence := map[string]any{"storage": "SeaweedFS 4.51", "resources": len(manifest.Resources), "restored": report.Complete, "source_preserved": true, "organization_preserved": true, "quota_preserved": true, "authentication_fenced": true, "conditional_writes_verified": report.WriteSemanticsVerified, "populated_target_rejected": true, "site_versions_preserved": true, "site_share_preserved": true, "site_revocation_preserved": true, "private_preview_fenced": true, "site_query_preserved": true, "site_signing_authority_preserved": true}
		data, _ := json.MarshalIndent(evidence, "", "  ")
		if os.WriteFile(output, data, 0600) != nil {
			t.Fatal("write recovery evidence")
		}
	}
}
