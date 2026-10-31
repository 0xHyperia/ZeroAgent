package cloudbackup

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/cloudsite"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

const recoverySiteSigningKey = "synthetic-recovery-site-signing-authority-0123456789abcdef"
const recoverySiteOrigin = "https://{site}.restore-content.example.net"
const recoverySiteConfig = "ZEROAGENT_SITE_SIGNING_KEY=" + recoverySiteSigningKey + "\nZEROAGENT_SITE_ORIGIN_TEMPLATE=" + recoverySiteOrigin + "\n"

type recoverySiteReceipt struct {
	family, first, second, sessionID string
	share, revoked, private          *account.CloudSiteGrant
}

func recoverySessionRedisURL(t *testing.T, base string, index int) string {
	t.Helper()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal("parse isolated session Redis")
	}
	u.Path = "/" + strconv.Itoa(index)
	return u.String()
}

func recoverySiteService(t *testing.T, store account.Store, objects objectstore.Store, key string) *account.Service {
	t.Helper()
	service := account.NewService(store, nil, time.Hour, time.Hour)
	if err := service.SetCloudObjectStore(objects); err != nil {
		t.Fatal(err)
	}
	cfg, err := cloudsite.NewConfig(recoverySiteOrigin, "https://app.example.com", "127.0.0.1:18081", key, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = service.SetCloudSiteConfig(cfg); err != nil {
		t.Fatal(err)
	}
	return service
}

func assertRecoverySiteContent(t *testing.T, service *account.Service, raw string, status int, version int) {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal("parse synthetic site capability")
	}
	req := httptest.NewRequest("GET", u.RequestURI(), nil)
	req.Host = u.Host
	response := httptest.NewRecorder()
	service.CloudSiteContentHandler().ServeHTTP(response, req)
	if response.Code != status {
		t.Fatalf("recovery site status=%d expected=%d", response.Code, status)
	}
	if status == 200 && !strings.Contains(response.Body.String(), fmt.Sprintf("恢复站点 v%d", version)) {
		t.Fatal("recovery changed fixed site content")
	}
}

func seedSeaweedRecoverySite(t *testing.T, ctx context.Context, store *account.PersistentStore, db *sql.DB, objects *S3, conversationID string) recoverySiteReceipt {
	t.Helper()
	result := recoverySiteReceipt{family: uuid.NewString(), sessionID: "synthetic-site-recovery-" + uuid.NewString()}
	session := &account.Session{ID: result.sessionID, UserID: 7, AccessToken: "synthetic-site-recovery-access", SessionExpiresAt: time.Now().Add(time.Hour)}
	if err := store.PutSession(ctx, session); err != nil {
		t.Fatal("seed source site owner session")
	}
	service := recoverySiteService(t, store, objects, recoverySiteSigningKey)
	if _, err := db.ExecContext(ctx, `INSERT INTO cloudapp.zeroagent_cloud_artifact_families(id,user_id,conversation_id,created_at)VALUES($1,7,$2,clock_timestamp())`, result.family, conversationID); err != nil {
		t.Fatal(err)
	}
	for version := 1; version <= 2; version++ {
		var body bytes.Buffer
		writer := zip.NewWriter(&body)
		entry, err := writer.Create("index.html")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = fmt.Fprintf(entry, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><h1>恢复站点 v%d</h1><script src="app.js"></script></html>`, version); err != nil {
			t.Fatal(err)
		}
		entry, err = writer.Create("app.js")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write([]byte("document.body.dataset.ready='true'")); err != nil {
			t.Fatal(err)
		}
		if err = writer.Close(); err != nil {
			t.Fatal(err)
		}
		id := uuid.NewString()
		key := "accounts/" + testDigest([]byte("7"))[:32] + "/artifacts/" + result.family + "/" + id + "/content"
		data := body.Bytes()
		if _, err = objects.Put(ctx, key, bytes.NewReader(data), int64(len(data)), objectstore.PutOptions{ContentType: "application/zip", SHA256: testDigest(data), Metadata: map[string]string{"artifact-version": id, "artifact-family": result.family, "owner-scope": "account-" + testDigest([]byte("7"))[:32]}}); err != nil {
			t.Fatal("store recovery site original", err)
		}
		if _, err = db.ExecContext(ctx, `INSERT INTO cloudapp.zeroagent_cloud_artifact_versions(id,family_id,number,user_id,conversation_id,source_run_id,tool_operation_id,request_hash,object_key,name,mime,size,sha256,state,created_at,updated_at)VALUES($1,$2,$3,7,$4,$5,$6,$7,$8,'site.zip','application/zip',$9,$10,'ready',clock_timestamp(),clock_timestamp())`, id, result.family, version, conversationID, uuid.NewString(), uuid.NewString(), testDigest([]byte(id)), key, len(data), testDigest(data)); err != nil {
			t.Fatal("seed canonical recovery site", err)
		}
		if _, err = service.CreateCloudSiteRelease(ctx, session, id, ""); err != nil {
			t.Fatal("verify source site manifest", err)
		}
		if version == 1 {
			result.first = id
		} else {
			result.second = id
		}
	}
	var err error
	result.share, err = service.CreateCloudSiteAccess(ctx, session, result.first, uuid.NewString(), "share", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	result.revoked, err = service.CreateCloudSiteAccess(ctx, session, result.second, uuid.NewString(), "share", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.RevokeCloudSiteGrant(ctx, 7, result.revoked.ID, result.revoked.Version); err != nil {
		t.Fatal(err)
	}
	result.private, err = service.CreateCloudSiteAccess(ctx, session, result.second, uuid.NewString(), "private", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	assertRecoverySiteContent(t, service, result.share.URL, 200, 1)
	assertRecoverySiteContent(t, service, result.private.URL, 200, 2)
	assertRecoverySiteContent(t, service, result.revoked.URL, 404, 0)
	return result
}

func verifySeaweedRecoverySite(t *testing.T, ctx context.Context, dsn, redisURL, protectedPath string, objects *S3, receipt recoverySiteReceipt) {
	t.Helper()
	store, err := account.OpenPersistentStore(ctx, dsn, recoverySessionRedisURL(t, redisURL, 15))
	if err != nil {
		t.Fatal("open restored canonical site service", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	data, err := os.ReadFile(protectedPath)
	if err != nil {
		t.Fatal("read restored protected site configuration")
	}
	var configuration protectedConfiguration
	if json.Unmarshal(data, &configuration) != nil || configuration.Files["gateway.env"] != recoverySiteConfig {
		t.Fatal("site signing authority not restored with protected config")
	}
	key := ""
	for _, line := range strings.Split(configuration.Files["gateway.env"], "\n") {
		if strings.HasPrefix(line, "ZEROAGENT_SITE_SIGNING_KEY=") {
			key = strings.TrimPrefix(line, "ZEROAGENT_SITE_SIGNING_KEY=")
		}
	}
	service := recoverySiteService(t, store, objects, key)
	space, err := store.QueryCloudSpace(ctx, 7, account.CloudSpaceQuery{Category: "sites"})
	if err != nil || space.Total != 1 || len(space.Items) != 1 || space.Items[0].ID != receipt.family || space.Items[0].SiteVersionID != receipt.second || space.Items[0].Versions != 2 {
		t.Fatal("restored site organization or version projection differs", err)
	}
	for _, id := range []string{receipt.first, receipt.second} {
		release, err := store.GetCloudSiteRelease(ctx, 7, id)
		if err != nil || release.SiteID != receipt.family || len(release.Manifest.Entries) != 2 {
			t.Fatal("restored immutable site manifest differs", err)
		}
	}
	if _, err = store.GetSession(ctx, receipt.sessionID); err == nil {
		t.Fatal("source login session survived restore")
	}
	assertRecoverySiteContent(t, service, receipt.private.URL, 404, 0)
	assertRecoverySiteContent(t, service, receipt.revoked.URL, 404, 0)
	assertRecoverySiteContent(t, service, receipt.share.URL, 200, 1)
	if _, err = store.RevokeCloudSiteGrant(ctx, 7, receipt.share.ID, receipt.share.Version); err != nil {
		t.Fatal("restored site share could not be revoked", err)
	}
	assertRecoverySiteContent(t, service, receipt.share.URL, 404, 0)
}
