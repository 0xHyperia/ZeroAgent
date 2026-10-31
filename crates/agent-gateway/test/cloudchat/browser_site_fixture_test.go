package cloudchat_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/cloudsite"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

func seedBrowserSite(t *testing.T, web *httptest.Server, service *account.Service, store *account.MemoryStore, viewer *account.Session, objects objectstore.Store, output string) {
	t.Helper()
	if os.Getenv("ZEROAGENT_CLOUDCHAT_SITE_FIXTURE") != "1" {
		return
	}
	content := httptest.NewServer(service.CloudSiteContentHandler())
	t.Cleanup(content.Close)
	_, port, err := net.SplitHostPort(content.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := cloudsite.NewConfig("http://{site}.localhost:"+port, web.URL, content.Listener.Addr().String(), strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", ""), true)
	if err != nil {
		t.Fatal("configure isolated synthetic site listener")
	}
	if err = service.SetCloudSiteConfig(cfg); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Now().UTC()
	conversation := uuid.NewString()
	if err = store.PutCloudConversation(ctx, &account.CloudConversation{ID: conversation, UserID: viewer.UserID, Title: "资料空间站点验收", Model: "gpt-5.1", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	ref, err := store.BindCloudRunSession(ctx, viewer)
	if err != nil {
		t.Fatal(err)
	}
	contentJSON, _ := json.Marshal("合成静态站点构建成果，仅用于浏览器验收。")
	run, _, err := store.CreateCloudRun(ctx, &account.CloudRun{ConversationID: conversation, UserID: viewer.UserID, ClientRequestID: uuid.NewString(), SessionRef: ref, RequestHash: acceptanceDigest(contentJSON), Model: "gpt-5.1", RequestContent: contentJSON})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimCloudRun(ctx, "synthetic-site-owner", time.Minute)
	if err != nil || claimed.ID != run.ID {
		t.Fatal("claim synthetic site source", err)
	}
	owner := sha256.Sum256([]byte(strconv.FormatInt(viewer.UserID, 10)))
	family := uuid.NewString()
	versions := []string{}
	for version := 1; version <= 2; version++ {
		var buffer bytes.Buffer
		archive := zip.NewWriter(&buffer)
		files := []struct{ name, body string }{
			{"index.html", fmt.Sprintf(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>资料空间演示 v%d</title><link rel="stylesheet" href="assets/style.css"><main><span class="eyebrow">ZEROAGENT · 私有成果</span><h1>从资料到一个可用的小工具</h1><p>这是版本 %d。内容保存在资料空间，关闭沙箱后仍可访问。</p><section><span>交互计数器</span><button id="counter">增加 · 0</button></section><p id="isolation">正在检查呈现边界…</p></main><script src="assets/app.js"></script></html>`, version, version)},
			{"assets/style.css", `*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#1c2130;font:15px/1.8 system-ui,sans-serif}main{max-width:680px;margin:36px auto;padding:28px}h1{font-size:28px;line-height:1.35;letter-spacing:-.04em}p{color:#616b7b}.eyebrow{font-size:11px;letter-spacing:.1em;color:#667085}section{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:28px 0;padding:24px;background:white;border:1px solid #e2e5eb;border-radius:20px}button{border:0;border-radius:999px;background:#242834;color:white;padding:12px 20px;font:inherit;cursor:pointer}button:hover{background:#41485b}button:active{transform:scale(.97)}#isolation{font-size:12px}@media(max-width:500px){main{margin:0;padding:24px}h1{font-size:24px}section{padding:16px}}`},
			{"assets/app.js", `let count=0;document.getElementById('counter').onclick=e=>{e.target.textContent='增加 · '+(++count)};try{parent.document.body;document.getElementById('isolation').textContent='顶层独立站点'}catch{document.getElementById('isolation').textContent='主站隔离正常 · 本地脚本已加载'}`},
		}
		for _, file := range files {
			writer, err := archive.Create(file.name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = writer.Write([]byte(file.body)); err != nil {
				t.Fatal(err)
			}
		}
		if err = archive.Close(); err != nil {
			t.Fatal(err)
		}
		data := buffer.Bytes()
		a, _, err := store.ReserveCloudArtifact(ctx, viewer.UserID, claimed.LeaseOwner, claimed.Attempt, &account.CloudArtifactVersion{ID: uuid.NewString(), FamilyID: family, ConversationID: conversation, SourceRunID: run.ID, ToolOperationID: uuid.NewString(), RequestHash: acceptanceDigest([]byte(fmt.Sprintf("synthetic site version %d", version))), Name: "站点演示.zip", MIME: "application/zip", Size: int64(len(data)), SHA256: acceptanceDigest(data)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = objects.Put(ctx, a.ObjectKey, bytes.NewReader(data), a.Size, objectstore.PutOptions{ContentType: a.MIME, SHA256: a.SHA256, Metadata: map[string]string{"artifact-version": a.ID, "artifact-family": family, "owner-scope": "account-" + hex.EncodeToString(owner[:16])}}); err != nil {
			t.Fatal("store actual synthetic site bundle")
		}
		objectKey := a.ObjectKey
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := objects.Delete(cleanup, objectKey); err != nil {
				t.Error("clean owned synthetic site object")
			}
		})
		a, err = store.UpdateCloudArtifact(ctx, viewer.UserID, a.ID, a.Version, claimed.LeaseOwner, claimed.Attempt, account.CloudArtifactUpdate{State: account.CloudArtifactReady})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = service.CreateCloudSiteRelease(ctx, viewer, a.ID, ""); err != nil {
			t.Fatal("register verified site for space navigation", err)
		}
		versions = append(versions, a.ID)
	}
	if _, err = store.CommitCloudRun(ctx, viewer.UserID, run.ID, claimed.LeaseOwner, claimed.Attempt, account.CloudRunCommit{OperationID: "synthetic-site-complete", State: account.CloudRunCompleted, Delta: "合成站点成果已保存。【成果:" + versions[len(versions)-1] + "】"}); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(map[string]any{"family_id": family, "versions": versions, "conversation_id": conversation, "content_listener": content.URL, "storage": "explicit browser storage fixture"})
	if err = os.WriteFile(filepath.Join(filepath.Dir(output), "site-seed.json"), encoded, 0600); err != nil {
		t.Fatal("write synthetic site seed receipt")
	}
}
