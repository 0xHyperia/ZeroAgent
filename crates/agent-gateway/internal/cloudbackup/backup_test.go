package cloudbackup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/objectstore"
	"github.com/redis/go-redis/v9"
)

type testStoredObject struct {
	data   []byte
	header http.Header
}
type backupS3Fixture struct {
	dropPut                    bool
	mu                         sync.Mutex
	data                       map[string]testStoredObject
	corrupt, missing, badOwner bool
	puts                       int
	probePuts                  int
	endpoint                   string
}

func backupTestS3(t *testing.T) (*backupS3Fixture, *S3, *S3) {
	t.Helper()
	fixture := &backupS3Fixture{data: map[string]testStoredObject{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Error("backup bypassed official S3 signing")
		}
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		object, exists := fixture.data[r.URL.Path]
		if r.Method == http.MethodDelete {
			delete(fixture.data, r.URL.Path)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method == http.MethodPut {
			isProbe := strings.Contains(r.URL.Path, "/"+restoreWriteProbePrefix)
			if isProbe {
				fixture.probePuts++
			}
			if (strings.HasPrefix(r.URL.Path, "/backup-target/") || isProbe) && r.Header.Get("If-None-Match") != "*" {
				t.Error("restore lacked atomic no-overwrite precondition")
			}
			if exists && r.Header.Get("If-None-Match") == "*" {
				w.WriteHeader(412)
				return
			}
			data, _ := io.ReadAll(r.Body)
			fixture.data[r.URL.Path] = testStoredObject{data: data, header: r.Header.Clone()}
			fixture.puts++
			if fixture.dropPut && strings.Contains(r.URL.Path, "/accounts/") {
				connection, _, hijackErr := w.(http.Hijacker).Hijack()
				if hijackErr == nil {
					connection.Close()
				}
				return
			}
			w.Header().Set("X-Amz-Checksum-Sha256", r.Header.Get("X-Amz-Checksum-Sha256"))
			w.WriteHeader(200)
			return
		}
		if !exists || fixture.missing {
			w.WriteHeader(404)
			io.WriteString(w, "<Error><Code>NoSuchKey</Code></Error>")
			return
		}
		for key, values := range object.header {
			if strings.HasPrefix(strings.ToLower(key), "x-amz-meta-") {
				w.Header()[key] = values
			}
		}
		if fixture.badOwner && strings.Contains(r.URL.Path, "/accounts/") {
			w.Header().Set("X-Amz-Meta-Owner-Scope", "wrong-owner")
		}
		w.Header().Set("Content-Type", object.header.Get("Content-Type"))
		w.Header().Set("Content-Length", strconv.Itoa(len(object.data)))
		w.Header().Set("X-Amz-Checksum-Sha256", object.header.Get("X-Amz-Checksum-Sha256"))
		if r.Method == http.MethodHead {
			return
		}
		data := append([]byte(nil), object.data...)
		if fixture.corrupt && len(data) > 0 {
			data[0] ^= 1
		}
		w.Write(data)
	}))
	t.Cleanup(server.Close)
	fixture.endpoint = server.URL
	stores := []*S3{}
	for _, bucket := range []string{"backup-source", "backup-target"} {
		store, err := NewS3(objectstore.Config{Endpoint: server.URL, Bucket: bucket, Region: "test-region", AccessKeyID: "synthetic-backup-access", SecretAccessKey: "synthetic-backup-secret", AllowLoopbackHTTP: true})
		if err != nil {
			t.Fatal(err)
		}
		stores = append(stores, store)
		t.Cleanup(store.Close)
	}
	return fixture, stores[0], stores[1]
}

func backupDatabase(t *testing.T, base string) (string, *sql.DB) {
	t.Helper()
	parsed, err := url.Parse(base)
	if err != nil || parsed.Hostname() != "127.0.0.1" {
		t.Fatal("backup test requires explicit loopback DSN")
	}
	admin, err := sql.Open("postgres", base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close() })
	name := "zeroagent_backup_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(`CREATE DATABASE "` + name + `"`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !strings.HasPrefix(name, "zeroagent_backup_") || !identifier.MatchString(name) {
			t.Error("invalid cleanup target")
			return
		}
		if _, err := admin.Exec(`DROP DATABASE "` + name + `" WITH (FORCE)`); err != nil {
			t.Error(err)
		}
	})
	parsed.Path = "/" + name
	query := parsed.Query()
	query.Set("search_path", "cloudapp")
	parsed.RawQuery = query.Encode()
	db, err := sql.Open("postgres", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return parsed.String(), db
}
func backupRedis(t *testing.T, base string, index int) *redis.Client {
	t.Helper()
	options, err := redis.ParseURL(base)
	if err != nil || !strings.HasPrefix(options.Addr, "127.0.0.1:") {
		t.Fatal("backup test Redis must be explicit loopback")
	}
	options.DB = index
	client := redis.NewClient(options)
	t.Cleanup(func() { client.Close() })
	if n, err := client.DBSize(context.Background()).Result(); err != nil || n != 0 {
		t.Fatal("backup drill requires an unused dedicated Redis DB")
	}
	return client
}
func testDatabaseName(dsn string) string {
	parsed, _ := url.Parse(dsn)
	return strings.TrimPrefix(parsed.Path, "/")
}
func testDigest(data []byte) string { hash := sha256.Sum256(data); return hex.EncodeToString(hash[:]) }

func seedBackupJournal(t *testing.T, node, ledger, directory, authority string) {
	t.Helper()
	script := filepath.Join(t.TempDir(), "seed.mjs")
	const source = `import {pathToFileURL} from 'node:url'; const {Ledger}=await import(pathToFileURL(process.argv[2])); const l=new Ledger(process.argv[3],1000,8000000,process.argv[4]); await l.init(); const now=new Date().toISOString(); for(const [id,state] of [['durable-old-op','succeeded'],['unknown-old-op','unknown']]) await l.save({operation_id:id,action:'command.run',state,created_at:now,updated_at:now,scope_hash:'b'.repeat(64),request_hash:'c'.repeat(64),result:{stdout:'private fixture output'}}); await l.retire(l.get('durable-old-op')); await l.close();`
	if err := os.WriteFile(script, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(node, script, ledger, directory, authority).CombinedOutput(); err != nil {
		t.Fatalf("seed real SDK ledger: %v %s", err, output)
	}
}

func TestCloudBackupIsolatedPostgresRedisS3Recovery(t *testing.T) {
	base := os.Getenv("ZEROAGENT_BACKUP_TEST_DATABASE_URL")
	redisBase := os.Getenv("ZEROAGENT_BACKUP_TEST_REDIS_URL")
	node := os.Getenv("ZEROAGENT_BACKUP_TEST_NODE")
	pg := os.Getenv("ZEROAGENT_BACKUP_TEST_PG_BIN")
	helper := os.Getenv("ZEROAGENT_BACKUP_TEST_JOURNAL_HELPER")
	ledger := os.Getenv("ZEROAGENT_BACKUP_TEST_LEDGER")
	if base == "" || redisBase == "" || node == "" || pg == "" || helper == "" || ledger == "" {
		t.Skip("explicit isolated backup PostgreSQL/Redis/Node/pgtools fixture configuration required")
	}
	ctx := context.Background()
	sourceDSN, sourceDB := backupDatabase(t, base)
	if _, err := sourceDB.Exec(`CREATE SCHEMA cloudapp`); err != nil {
		t.Fatal(err)
	}
	sourceRedis := backupRedis(t, redisBase, 14)
	targetRedis := backupRedis(t, redisBase, 15)
	sourceRedisParsed, _ := url.Parse(redisBase)
	sourceRedisParsed.Path = "/14"
	sourceRedisURL := sourceRedisParsed.String()
	sourceStore, err := account.OpenPersistentStore(ctx, sourceDSN, sourceRedisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sourceStore.Close() })
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"code":0,"data":{}}`) }))
	t.Cleanup(platform.Close)
	sourceService := account.NewService(sourceStore, account.NewUSAClientWithHTTPClient(platform.URL, platform.Client()), time.Hour, time.Hour)
	session := &account.Session{ID: "backup-old-browser-session", UserID: 7, AccessToken: "synthetic-old-access", RefreshToken: "synthetic-old-refresh", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
	if err = sourceStore.PutSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	ref, err := sourceStore.BindCloudRunSession(ctx, session)
	if err != nil {
		t.Fatal(err)
	}
	token := "synthetic-old-device-token"
	deviceID := "agent-" + uuid.NewString()
	device := &account.Device{ID: deviceID, UserID: 7, InstallationID: uuid.NewString(), Name: "restore fixture", CredentialHash: testDigest([]byte(token)), CreatedAt: time.Now(), TokenIssuedAt: time.Now(), LastSeenAt: time.Now()}
	if err = sourceStore.UpsertDevice(ctx, device); err != nil {
		t.Fatal(err)
	}
	conversation := &account.CloudConversation{ID: uuid.NewString(), UserID: 7, Title: "restorable work", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err = sourceStore.PutCloudConversation(ctx, conversation); err != nil {
		t.Fatal(err)
	}
	input := &account.CloudRun{UserID: 7, ConversationID: conversation.ID, SessionRef: ref, ClientRequestID: uuid.NewString(), RequestHash: strings.Repeat("e", 64), Model: "fixture", RequestContent: json.RawMessage(`"restore pending work"`)}
	run, _, err := sourceStore.CreateCloudRun(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	fixture, sourceObjects, targetObjects := backupTestS3(t)
	root := t.TempDir()
	if err = os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	journalDir := filepath.Join(root, "source-journal")
	protected := mustJSON(protectedConfiguration{Format: 1, ExecutorNamespace: "zeroagent-backup-fixture", ExecutorScopeKey: "synthetic-stable-backup-scope-signing-key", Files: map[string]string{"gateway.env": "synthetic gateway configuration", "executor.env": "synthetic executor configuration"}})
	authority, err := configurationAuthority(protected)
	if err != nil {
		t.Fatal(err)
	}
	protectedPath := filepath.Join(root, "current-private-configuration.json")
	if err = os.WriteFile(protectedPath, protected, 0600); err != nil {
		t.Fatal(err)
	}
	seedBackupJournal(t, node, ledger, journalDir, authority)
	config := Config{DatabaseURL: sourceDSN, ExpectedDatabase: testDatabaseName(sourceDSN), Schema: "cloudapp", Scope: "isolated-cloudchat-backup-fixture", PGDumpPath: filepath.Join(pg, "pg_dump"), PGRestorePath: filepath.Join(pg, "pg_restore"), NodePath: node, JournalHelperPath: helper, JournalDirectory: journalDir, ExpectedJournalAuthority: authority, ProtectedConfigSource: protectedPath, BackupEncryptionKey: bytes.Repeat([]byte("k"), 32), Timeout: 2 * time.Minute, AllowMutations: true}
	engine := &Engine{Config: config, DB: sourceDB, Redis: sourceRedis, Objects: sourceObjects}
	fileID, familyID, versionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	owner := sha256.Sum256([]byte("7"))
	prefix := hex.EncodeToString(owner[:16])
	originals := []Resource{{Kind: "file", ID: fileID, UserID: 7, Key: "accounts/" + prefix + "/files/" + fileID + "/original", MIME: "text/plain", Metadata: map[string]string{"file-id": fileID, "owner-scope": prefix}}, {Kind: "artifact", ID: versionID, FamilyID: familyID, UserID: 7, Key: "accounts/" + prefix + "/artifacts/" + familyID + "/" + versionID + "/content", MIME: "text/csv", Metadata: map[string]string{"artifact-version": versionID, "artifact-family": familyID, "owner-scope": "account-" + prefix}}}
	for index := range originals {
		data := []byte("canonical original\n")
		if index == 1 {
			data = []byte("item,value\nprofit,42\n")
		}
		resource := &originals[index]
		resource.Size = int64(len(data))
		resource.SHA256 = testDigest(data)
		resource.Archive = "objects/" + resource.SHA256 + ".bin"
		if _, err = sourceObjects.Put(ctx, resource.Key, bytes.NewReader(data), resource.Size, objectstore.PutOptions{ContentType: resource.MIME, SHA256: resource.SHA256, Metadata: resource.Metadata}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = sourceDB.Exec(`INSERT INTO cloudapp.zeroagent_cloud_files(id,user_id,conversation_id,object_key,name,mime,size,sha256,state,uploaded_at,extracted_text) VALUES($1,7,$2,$3,'notes.txt',$4,$5,$6,'ready',clock_timestamp(),'canonical original')`, fileID, conversation.ID, originals[0].Key, originals[0].MIME, originals[0].Size, originals[0].SHA256); err != nil {
		t.Fatal(err)
	}
	if _, err = sourceDB.Exec(`INSERT INTO cloudapp.zeroagent_cloud_artifact_families(id,user_id,conversation_id,created_at) VALUES($1,7,$2,clock_timestamp());`, familyID, conversation.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = sourceDB.Exec(`INSERT INTO cloudapp.zeroagent_cloud_artifact_versions(id,family_id,user_id,conversation_id,source_run_id,tool_operation_id,request_hash,number,object_key,name,mime,size,sha256,state,created_at,updated_at) VALUES($1,$2,7,$3,$4,$5,$6,1,$7,'report.csv',$8,$9,$10,'ready',clock_timestamp(),clock_timestamp())`, versionID, familyID, conversation.ID, run.ID, uuid.NewString(), strings.Repeat("d", 64), originals[1].Key, originals[1].MIME, originals[1].Size, originals[1].SHA256); err != nil {
		t.Fatal(err)
	}
	// Snapshot only this test's dedicated auth DB; no global SAVE/FLUSH operation.
	for _, prefix := range authPrefixes {
		if err = sourceRedis.Set(ctx, prefix+"fixture-canary", "old authentication", time.Hour).Err(); err != nil {
			t.Fatal(err)
		}
	}
	snapshot := map[string]string{}
	keys, _ := sourceRedis.Keys(ctx, "zeroagent:*").Result()
	for _, key := range keys {
		value, err := sourceRedis.Dump(ctx, key).Result()
		if err != nil {
			t.Fatal(err)
		}
		snapshot[key] = value
	}
	t.Cleanup(func() {
		for key := range snapshot {
			sourceRedis.Del(context.Background(), key)
			targetRedis.Del(context.Background(), key)
		}
		targetRedis.Del(context.Background(), "another-service:keep", "zeroagent:cache:keep")
	})
	bundle := filepath.Join(root, "candidate")
	manifest, err := engine.Create(ctx, bundle)
	if err != nil {
		t.Fatalf("create complete candidate: %v", err)
	}
	if len(manifest.Resources) != 2 || manifest.JournalSummary.UnknownCount != 1 || manifest.JournalSummary.ReceiptCount != 2 || !digest.MatchString(manifest.Dump.SHA256) {
		t.Fatal("candidate omitted a canonical component")
	}
	if _, err = engine.Verify(ctx, bundle); err != nil {
		t.Fatalf("source verify: %v", err)
	}
	fixture.mu.Lock()
	if fixture.probePuts != 0 {
		t.Error("New/Create/Verify performed mutation-only conditional capability probe")
	}
	fixture.mu.Unlock()
	wrongKey := *engine
	wrongKey.Config = config
	wrongKey.Config.BackupEncryptionKey = bytes.Repeat([]byte("x"), 32)
	if _, err = wrongKey.Verify(ctx, bundle); err == nil {
		t.Fatal("wrong external configuration recovery key accepted")
	}
	guard, err := startJournalGuard(ctx, config, filepath.Join(root, "guarded-copy.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	blocked := filepath.Join(root, "active-sdk-candidate")
	if _, err = engine.Create(ctx, blocked); err == nil {
		guard.close()
		t.Fatal("active SDK journal ownership lock was bypassed")
	}
	if err = guard.close(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(blocked, "manifest.json")); !os.IsNotExist(err) {
		t.Fatal("failed SDK guard published a complete manifest")
	}
	fixture.mu.Lock()
	putsBefore := fixture.puts
	fixture.corrupt = true
	fixture.mu.Unlock()
	if _, err = engine.Verify(ctx, bundle); err == nil {
		t.Fatal("corrupt remote object accepted")
	}
	fixture.mu.Lock()
	fixture.corrupt = false
	fixture.missing = true
	fixture.mu.Unlock()
	if _, err = engine.Verify(ctx, bundle); err == nil {
		t.Fatal("missing remote object accepted")
	}
	fixture.mu.Lock()
	fixture.missing = false
	fixture.badOwner = true
	fixture.mu.Unlock()
	if _, err = engine.Verify(ctx, bundle); err == nil {
		t.Fatal("foreign owner metadata accepted")
	}
	fixture.mu.Lock()
	fixture.badOwner = false
	if fixture.puts != putsBefore {
		t.Error("read-only verify mutated objects")
	}
	fixture.mu.Unlock()
	if err = sourceService.Logout(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if err = sourceService.RevokeDevice(ctx, 7, deviceID); err != nil {
		t.Fatal(err)
	}
	// Demonstrate the exact stale-snapshot hazard on an offline naive target.
	naiveDSN, naiveDB := backupDatabase(t, base)
	naiveCfg := config
	naiveCfg.DatabaseURL = naiveDSN
	naiveCfg.ExpectedDatabase = testDatabaseName(naiveDSN)
	if err = runPG(ctx, naiveCfg, true, "--no-owner", "--no-privileges", "--exit-on-error", "--dbname="+naiveCfg.ExpectedDatabase, filepath.Join(bundle, "database.dump")); err != nil {
		t.Fatal("naive fixture dump restore failed")
	}
	for key, value := range snapshot {
		if err = targetRedis.Restore(ctx, key, time.Hour, value).Err(); err != nil {
			t.Fatal(err)
		}
	}
	targetRedisParsed, _ := url.Parse(redisBase)
	targetRedisParsed.Path = "/15"
	naiveStore, err := account.OpenPersistentStore(ctx, naiveDSN, targetRedisParsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { naiveStore.Close() })
	naiveService := account.NewService(naiveStore, account.NewUSAClientWithHTTPClient(platform.URL, platform.Client()), time.Hour, time.Hour)
	if _, err = naiveService.Session(ctx, session.ID); err != nil {
		t.Fatal("naive snapshot did not reproduce old session resurrection hazard")
	}
	if _, _, err = naiveService.AuthenticateAgent(deviceID, token, "", ""); err != nil {
		t.Fatal("naive snapshot did not reproduce old device resurrection hazard")
	}
	targetRedis.Set(ctx, "another-service:keep", "preserve", time.Hour)
	targetRedis.Set(ctx, "zeroagent:cache:keep", "preserve", time.Hour)
	naiveEngine := &Engine{Config: naiveCfg, DB: naiveDB, Redis: targetRedis, Objects: targetObjects}
	if err = naiveEngine.InvalidateAuthentication(ctx, naiveCfg.Scope, naiveCfg.ExpectedDatabase); err != nil {
		t.Fatal(err)
	}
	if _, err = naiveService.Session(ctx, session.ID); err == nil {
		t.Fatal("restored logged-out cookie remains authorized")
	}
	if _, _, err = naiveService.AuthenticateAgent(deviceID, token, "", ""); err == nil {
		t.Fatal("restored revoked device credential remains authorized")
	}
	if _, err = naiveStore.GetCloudRunSession(ctx, ref); err == nil {
		t.Fatal("old Run session reference remains authorized")
	}
	if targetRedis.Get(ctx, "another-service:keep").Val() != "preserve" || targetRedis.Get(ctx, "zeroagent:cache:keep").Val() != "preserve" {
		t.Fatal("invalidation deleted unrelated service/cache state")
	}
	// Full guarded restoration into another fresh target includes mandatory auth
	// invalidation, canonical object PUT+GET checks and the immutable journal.
	targetDSN, targetDB := backupDatabase(t, base)
	targetCfg := config
	targetCfg.DatabaseURL = targetDSN
	targetCfg.ExpectedDatabase = testDatabaseName(targetDSN)
	targetCfg.JournalDirectory = filepath.Join(root, "restored-journal")
	targetCfg.RestoredConfigPath = filepath.Join(root, "restored-private-configuration.json")
	targetEngine := &Engine{Config: targetCfg, DB: targetDB, Redis: targetRedis, Objects: targetObjects}
	report, err := targetEngine.Restore(ctx, bundle, targetCfg.Scope, targetCfg.ExpectedDatabase, filepath.Join(root, "restore-report.json"))
	if err != nil || report == nil || !report.Complete || !report.AuthInvalidated {
		t.Fatalf("guarded restore: %+v %v", report, err)
	}
	restoredStore, err := account.OpenPersistentStore(ctx, targetDSN, targetRedisParsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { restoredStore.Close() })
	restoredService := account.NewService(restoredStore, account.NewUSAClientWithHTTPClient(platform.URL, platform.Client()), time.Hour, time.Hour)
	if _, err = restoredService.Session(ctx, session.ID); err == nil {
		t.Fatal("complete restore revived an old session")
	}
	if _, _, err = restoredService.AuthenticateAgent(deviceID, token, "", ""); err == nil {
		t.Fatal("complete restore revived an old device")
	}
	restoredRun, err := restoredStore.GetCloudRun(ctx, 7, run.ID)
	if err != nil || restoredRun.State != account.CloudRunInterrupted || restoredRun.ErrorCode != "restore_auth_invalidated" {
		t.Fatal("restored active Run was not fenced")
	}
	if _, err = targetEngine.Verify(ctx, bundle); err != nil {
		t.Fatal("restored canonical bytes/references do not match manifest")
	}
	// Load the restored file with the actual SDK ledger and prove an ACKed ID
	// stays retired while an unknown ID remains unknown across this restart.
	checkScript := filepath.Join(root, "check-restored-ledger.mjs")
	const ledgerCheck = `import {pathToFileURL} from 'node:url';const {Ledger}=await import(pathToFileURL(process.argv[2]));const l=new Ledger(process.argv[3],1000,8000000,process.argv[4]);await l.init();const old=l.get('durable-old-op');if(!old?.result_retired||l.get('unknown-old-op')?.state!=='unknown')throw Error('facts_lost');let rejected=false;try{await l.save({...old,result_retired:false,result:{stdout:'should never replace'}})}catch(e){rejected=e.code==='operation_result_retired'}if(!rejected)throw Error('replay_allowed');await l.close();`
	if err = os.WriteFile(checkScript, []byte(ledgerCheck), 0600); err != nil {
		t.Fatal(err)
	}
	if output, checkErr := exec.Command(node, checkScript, ledger, targetCfg.JournalDirectory, authority).CombinedOutput(); checkErr != nil {
		t.Fatalf("restored SDK tombstones/unknown failed: %v %s", checkErr, output)
	}
	restoredConfig, err := os.ReadFile(targetCfg.RestoredConfigPath)
	if err != nil || !bytes.Equal(restoredConfig, protected) {
		t.Fatal("protected configuration did not restore exactly")
	}
	if _, err = targetEngine.Restore(ctx, bundle, targetCfg.Scope, targetCfg.ExpectedDatabase, filepath.Join(root, "second-report.json")); !errors.Is(err, ErrTargetNotEmpty) {
		t.Fatal("nonempty target was allowed to restore again")
	}
	if err = targetObjects.PutIfAbsent(ctx, originals[0].Key, bytes.NewReader([]byte("overwrite")), 9, objectstore.PutOptions{ContentType: originals[0].MIME, SHA256: testDigest([]byte("overwrite")), Metadata: originals[0].Metadata}); !errors.Is(err, ErrTargetNotEmpty) {
		t.Fatal("conditional restore overwrote an existing object")
	}
	if err = verifyObject(ctx, targetObjects, originals[0], nil); err != nil {
		t.Fatal("failed overwrite damaged canonical bytes")
	}
	collisionDSN, collisionDB := backupDatabase(t, base)
	collisionCfg := targetCfg
	collisionCfg.DatabaseURL = collisionDSN
	collisionCfg.ExpectedDatabase = testDatabaseName(collisionDSN)
	collisionCfg.JournalDirectory = filepath.Join(root, "collision-journal")
	collisionCfg.RestoredConfigPath = filepath.Join(root, "collision-config.json")
	collisionEngine := &Engine{Config: collisionCfg, DB: collisionDB, Redis: targetRedis, Objects: targetObjects}
	if _, err = collisionEngine.Restore(ctx, bundle, collisionCfg.Scope, collisionCfg.ExpectedDatabase, filepath.Join(root, "collision-report.json")); !errors.Is(err, ErrTargetNotEmpty) {
		t.Fatal("existing target S3 key was not rejected")
	}
	var collisionTables int
	collisionDB.QueryRow(`SELECT count(*) FROM pg_tables WHERE schemaname='cloudapp'`).Scan(&collisionTables)
	if collisionTables != 0 {
		t.Fatal("object preflight rejection still restored database")
	}
	partialObjects, err := NewS3(objectstore.Config{Endpoint: fixture.endpoint, Bucket: "backup-partial", Region: "test-region", AccessKeyID: "synthetic-backup-access", SecretAccessKey: "synthetic-backup-secret", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(partialObjects.Close)
	partialDSN, partialDB := backupDatabase(t, base)
	partialCfg := targetCfg
	partialCfg.DatabaseURL = partialDSN
	partialCfg.ExpectedDatabase = testDatabaseName(partialDSN)
	partialCfg.JournalDirectory = filepath.Join(root, "partial-journal")
	partialCfg.RestoredConfigPath = filepath.Join(root, "partial-config.json")
	partialEngine := &Engine{Config: partialCfg, DB: partialDB, Redis: targetRedis, Objects: partialObjects}
	fixture.mu.Lock()
	fixture.badOwner = true
	fixture.mu.Unlock()
	partialReport, partialErr := partialEngine.Restore(ctx, bundle, partialCfg.Scope, partialCfg.ExpectedDatabase, filepath.Join(root, "partial-report.json"))
	fixture.mu.Lock()
	fixture.badOwner = false
	fixture.mu.Unlock()
	if partialErr == nil || partialReport == nil || partialReport.Complete || !partialReport.AuthInvalidated || partialReport.Phase != "restore_objects" {
		t.Fatal("partial restoration was not accurately retained")
	}
	unknownObjects, err := NewS3(objectstore.Config{Endpoint: fixture.endpoint, Bucket: "backup-unknown", Region: "test-region", AccessKeyID: "synthetic-backup-access", SecretAccessKey: "synthetic-backup-secret", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unknownObjects.Close)
	unknownDSN, unknownDB := backupDatabase(t, base)
	unknownCfg := targetCfg
	unknownCfg.DatabaseURL = unknownDSN
	unknownCfg.ExpectedDatabase = testDatabaseName(unknownDSN)
	unknownCfg.JournalDirectory = filepath.Join(root, "unknown-journal")
	unknownCfg.RestoredConfigPath = filepath.Join(root, "unknown-config.json")
	unknownEngine := &Engine{Config: unknownCfg, DB: unknownDB, Redis: targetRedis, Objects: unknownObjects}
	fixture.mu.Lock()
	fixture.dropPut = true
	fixture.mu.Unlock()
	unknownReport, unknownErr := unknownEngine.Restore(ctx, bundle, unknownCfg.Scope, unknownCfg.ExpectedDatabase, filepath.Join(root, "unknown-report.json"))
	fixture.mu.Lock()
	fixture.dropPut = false
	preservedUnknownBytes := 0
	for key := range fixture.data {
		if strings.HasPrefix(key, "/backup-unknown/") {
			preservedUnknownBytes++
		}
	}
	fixture.mu.Unlock()
	if !errors.Is(unknownErr, ErrWriteUnknown) || unknownReport == nil || unknownReport.Complete || unknownReport.Failure != "remote_write_unconfirmed" || preservedUnknownBytes != 1 {
		t.Fatal("lost PUT reply was retried, erased or falsely classified as no effect/success")
	}
	targetCfg.AllowMutations = false
	readonly := &Engine{Config: targetCfg}
	if err = readonly.InvalidateAuthentication(ctx, targetCfg.Scope, targetCfg.ExpectedDatabase); !errors.Is(err, ErrMutationDisabled) {
		t.Fatal("default configuration can mutate authentication")
	}
	if evidence := os.Getenv("ZEROAGENT_BACKUP_TEST_EVIDENCE_DIR"); evidence != "" {
		if err = privateDirectory(evidence, false); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"manifest.json", "manifest.sha256.json"} {
			data, readErr := os.ReadFile(filepath.Join(bundle, name))
			if readErr != nil {
				t.Fatal(readErr)
			}
			if err = os.WriteFile(filepath.Join(evidence, name), data, 0600); err != nil {
				t.Fatal(err)
			}
		}
		for _, name := range []string{"restore-report.json", "partial-report.json", "collision-report.json", "unknown-report.json"} {
			data, readErr := os.ReadFile(filepath.Join(root, name))
			if readErr != nil {
				t.Fatal(readErr)
			}
			if err = os.WriteFile(filepath.Join(evidence, name), data, 0600); err != nil {
				t.Fatal(err)
			}
		}
		if err = writeExclusiveJSON(filepath.Join(evidence, "assertions.json"), map[string]any{"complete_restore": true, "ready_objects_verified": len(manifest.Resources), "old_cookie_rejected": true, "old_device_rejected": true, "old_run_session_rejected": true, "unrelated_redis_keys_preserved": true, "retired_sdk_id_not_reexecuted": true, "unknown_sdk_fact_preserved": true, "configuration_roundtrip_exact": true, "partial_restore_not_reported_complete": true, "no_real_cloud_calls": true}); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("verified candidate=%s objects=%d db_sha256=%s journal_sha256=%s; stale cookie/device/RunSession rejected after explicit invalidation", manifest.ID, len(manifest.Resources), manifest.Dump.SHA256, manifest.JournalFile.SHA256)
}

func TestBackupArchiveRejectsTraversalSymlinkAndWrongOwner(t *testing.T) {
	root := t.TempDir()
	data := []byte("canonical")
	hash := testDigest(data)
	file := filepath.Join(root, "body")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../body", "/absolute", "a/../body", "a\\body"} {
		if _, err := archivePath(root, path); err == nil {
			t.Fatalf("unsafe archive path accepted: %s", path)
		}
	}
	link := filepath.Join(root, "symlink")
	if err := os.Symlink(file, link); err == nil {
		if _, err = archivePath(root, "symlink"); err == nil {
			t.Fatal("symlink archive accepted")
		}
	}
	resource := Resource{Kind: "file", ID: uuid.NewString(), UserID: 7, SHA256: hash, Size: int64(len(data)), MIME: "text/plain", Key: "accounts/foreign/files/object/original", Metadata: map[string]string{}, Archive: "objects/" + hash + ".bin"}
	if canonicalResource(resource) {
		t.Fatal("foreign owner/object key accepted")
	}
}
