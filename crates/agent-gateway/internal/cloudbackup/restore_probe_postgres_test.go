package cloudbackup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

func TestRestoreUnsupportedConditionalServiceStopsBeforeDatabaseAuthAndFormalWritesPostgres(t *testing.T) {
	base, cacheURL := os.Getenv("ZEROAGENT_BACKUP_TEST_DATABASE_URL"), os.Getenv("ZEROAGENT_BACKUP_TEST_REDIS_URL")
	node, pg, helper, ledger := os.Getenv("ZEROAGENT_BACKUP_TEST_NODE"), os.Getenv("ZEROAGENT_BACKUP_TEST_PG_BIN"), os.Getenv("ZEROAGENT_BACKUP_TEST_JOURNAL_HELPER"), os.Getenv("ZEROAGENT_BACKUP_TEST_LEDGER")
	if base == "" || cacheURL == "" || node == "" || pg == "" || helper == "" || ledger == "" {
		t.Skip("explicit isolated PostgreSQL/Redis/Node/pgtools fixture required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	sourceDSN, sourceDB := backupDatabase(t, base)
	if _, err := sourceDB.ExecContext(ctx, `CREATE SCHEMA cloudapp`); err != nil {
		t.Fatal(err)
	}
	sourceStore, err := account.OpenPersistentStore(ctx, sourceDSN, cacheURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sourceStore.Close() })
	cache := backupRedis(t, cacheURL, 15)
	canaryKey := "zeroagent:web-session:conditional-probe-" + uuid.NewString()
	canaryValue := "synthetic authentication must remain unchanged"
	if err = cache.Set(ctx, canaryKey, canaryValue, time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cache.Del(context.Background(), canaryKey) })
	fixture, sourceObjects, _ := backupTestS3(t)
	root := t.TempDir()
	if err = os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	protected := mustJSON(protectedConfiguration{Format: 1, ExecutorNamespace: "zeroagent-conditional-probe", ExecutorScopeKey: "synthetic-conditional-probe-scope-key", Files: map[string]string{"gateway.env": "synthetic", "executor.env": "synthetic"}})
	authority, err := configurationAuthority(protected)
	if err != nil {
		t.Fatal(err)
	}
	privateConfig := filepath.Join(root, "source-config.json")
	if err = os.WriteFile(privateConfig, protected, 0600); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(root, "source-journal")
	seedBackupJournal(t, node, ledger, journal, authority)
	cfg := Config{DatabaseURL: sourceDSN, ExpectedDatabase: testDatabaseName(sourceDSN), Schema: "cloudapp", Scope: "conditional-restore-isolated-fixture", PGDumpPath: filepath.Join(pg, "pg_dump"), PGRestorePath: filepath.Join(pg, "pg_restore"), NodePath: node, JournalHelperPath: helper, JournalDirectory: journal, ExpectedJournalAuthority: authority, ProtectedConfigSource: privateConfig, BackupEncryptionKey: bytes.Repeat([]byte("k"), 32), AllowMutations: true, Timeout: time.Minute}
	engine := &Engine{Config: cfg, DB: sourceDB, Redis: cache, Objects: sourceObjects}
	fileID, conversationID := uuid.NewString(), uuid.NewString()
	ownerHash := sha256.Sum256([]byte("7"))
	owner := hex.EncodeToString(ownerHash[:16])
	key := "accounts/" + owner + "/files/" + fileID + "/original"
	data := []byte("canonical original must not be restored to unsupported storage\n")
	if _, err = sourceObjects.Put(ctx, key, bytes.NewReader(data), int64(len(data)), objectstore.PutOptions{ContentType: "text/plain", SHA256: testDigest(data), Metadata: map[string]string{"file-id": fileID, "owner-scope": owner}}); err != nil {
		t.Fatal(err)
	}
	if err = sourceStore.PutCloudConversation(ctx, &account.CloudConversation{ID: conversationID, UserID: 7, Title: "source", CreatedAt: time.Now(), UpdatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err = sourceDB.ExecContext(ctx, `INSERT INTO cloudapp.zeroagent_cloud_files(id,user_id,conversation_id,object_key,name,mime,size,sha256,state,uploaded_at)VALUES($1,7,$2,$3,'source.txt','text/plain',$4,$5,'ready',clock_timestamp())`, fileID, conversationID, key, len(data), testDigest(data)); err != nil {
		t.Fatal(err)
	}
	for _, withObject := range []bool{true, false} {
		name := "with_object"
		if !withObject {
			name = "zero_objects"
			if _, err = sourceDB.ExecContext(ctx, `DELETE FROM cloudapp.zeroagent_cloud_files WHERE id=$1`, fileID); err != nil {
				t.Fatal(err)
			}
		}
		t.Run(name, func(t *testing.T) {
			bundle := filepath.Join(root, "bundle-"+name)
			manifest, createErr := engine.Create(ctx, bundle)
			if createErr != nil {
				t.Fatal(createErr)
			}
			if (len(manifest.Resources) > 0) != withObject {
				t.Fatal("unexpected source resource count")
			}
			if _, verifyErr := engine.Verify(ctx, bundle); verifyErr != nil {
				t.Fatal(verifyErr)
			}
			fixture.mu.Lock()
			if fixture.probePuts != 0 {
				t.Error("New/Create/Verify wrote a probe")
			}
			fixture.mu.Unlock()
			for _, mode := range []string{"ignore", "unknown-foreign"} {
				t.Run(mode, func(t *testing.T) {
					targetDSN, targetDB := backupDatabase(t, base)
					targetObjects, peer := newProbePeer(t, mode)
					targetCfg := cfg
					targetCfg.DatabaseURL = targetDSN
					targetCfg.ExpectedDatabase = testDatabaseName(targetDSN)
					targetCfg.JournalDirectory = filepath.Join(root, "target-journal-"+uuid.NewString())
					targetCfg.RestoredConfigPath = filepath.Join(root, "target-config-"+uuid.NewString()+".json")
					target := &Engine{Config: targetCfg, DB: targetDB, Redis: cache, Objects: targetObjects}
					report, restoreErr := target.Restore(ctx, bundle, targetCfg.Scope, targetCfg.ExpectedDatabase, filepath.Join(root, "report-"+uuid.NewString()+".json"))
					expected := ErrConditionalWritesUnsupported
					if mode != "ignore" {
						expected = ErrConditionalWritesUnconfirmed
					}
					if !errors.Is(restoreErr, expected) || report == nil || report.Complete || report.AuthInvalidated || report.WriteSemanticsVerified || report.Phase != "verify_restore_write_semantics" || report.WriteProbe == nil {
						t.Fatalf("restore did not stop at capability preflight: %+v %v", report, restoreErr)
					}
					var count int
					if err = targetDB.QueryRowContext(ctx, `SELECT count(*) FROM pg_tables WHERE schemaname NOT IN('pg_catalog','information_schema')`).Scan(&count); err != nil || count != 0 {
						t.Fatal("pg_restore executed before provider proof")
					}
					if value, getErr := cache.Get(ctx, canaryKey).Result(); getErr != nil || value != canaryValue {
						t.Fatal("unsupported preflight invalidated existing test authentication")
					}
					for _, path := range []string{targetCfg.JournalDirectory, targetCfg.RestoredConfigPath} {
						if _, statErr := os.Lstat(path); !os.IsNotExist(statErr) {
							t.Fatal("preflight wrote formal journal/config")
						}
					}
					peer.mu.Lock()
					if peer.formalPuts != 0 {
						t.Error("preflight wrote a formal key")
					}
					peer.mu.Unlock()
				})
			}
		})
	}
}
