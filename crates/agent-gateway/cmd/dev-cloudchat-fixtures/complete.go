package main

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/cloudbackup"
	"github.com/liveagent/agent-gateway/internal/cloudsite"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

// This command is deliberately separate from service admission. Canonical
// publication requires a live execution lease, which a synthetic fixture must
// never acquire. The bounded INSERT-only transaction below creates explicitly
// synthetic terminal lineage and reuses the normal storage and bundle checks.
type fixtureArtifact struct {
	Artifact       account.CloudArtifactVersion `json:"artifact"`
	Site           *cloudsite.Manifest          `json:"site,omitempty"`
	OriginalFileID string                       `json:"original_file_id,omitempty"`
	Data           []byte                       `json:"-"`
}
type fixtureExtras struct {
	Run       *account.CloudRun            `json:"run,omitempty"`
	Tools     []account.CloudToolOperation `json:"tools,omitempty"`
	Artifacts []fixtureArtifact            `json:"artifacts,omitempty"`
	Source    *account.CloudResearchSource `json:"source,omitempty"`
	Queue     *account.CloudPendingQueue   `json:"pending_queue,omitempty"`
	Draft     json.RawMessage              `json:"saved_draft,omitempty"`
}
type fixtureExtraReceipt struct {
	RunID          string                              `json:"synthetic_terminal_run_id,omitempty"`
	Artifacts      []account.CloudPresentationResource `json:"artifacts,omitempty"`
	SourceID       string                              `json:"source_id,omitempty"`
	PendingItemIDs []string                            `json:"pending_item_ids,omitempty"`
	DraftScope     string                              `json:"draft_scope,omitempty"`
}
type fixtureObjectStore interface {
	Get(context.Context, string) (*objectstore.Object, error)
	PutIfAbsent(context.Context, string, io.ReadSeeker, int64, objectstore.PutOptions) error
}

func artifactReference(item fixtureArtifact) account.CloudPresentationResource {
	a := item.Artifact
	kind := "artifact"
	if item.Site != nil {
		kind = "site"
	}
	return account.CloudPresentationResource{Kind: kind, ID: a.ID, FamilyID: a.FamilyID, Version: a.Number, Name: a.Name, MIME: a.MIME, Role: "output"}
}
func extraReceipt(plan fixturePlan) *fixtureExtraReceipt {
	if plan.Extras == nil {
		return nil
	}
	x := plan.Extras
	r := &fixtureExtraReceipt{}
	if x.Run != nil {
		r.RunID = x.Run.ID
	}
	for _, a := range x.Artifacts {
		r.Artifacts = append(r.Artifacts, artifactReference(a))
	}
	if x.Source != nil {
		r.SourceID = x.Source.ID
	}
	if x.Queue != nil {
		for _, item := range x.Queue.Items {
			r.PendingItemIDs = append(r.PendingItemIDs, item.ClientItemID)
		}
	}
	if len(x.Draft) > 0 {
		r.DraftScope = plan.Conversation.ID
	}
	return r
}
func fixtureComposer(text string) json.RawMessage {
	return encoded(map[string]any{"text": text, "textWithoutLargePastes": text, "isEmpty": false, "segments": []any{map[string]string{"type": "text", "text": text}}, "largePastes": []any{}, "skillMentions": []any{}, "appMentions": []any{}, "commitMentions": []any{}, "gitFileMentions": []any{}, "codeMentions": []any{}, "conversationMentions": []any{}})
}

// Read only explicitly named receipt samples, resolving symlinks before opening.
// The original receipt SHA is authoritative, not an arbitrary local filename.
func readFixtureSample(root string, refs []fileReference, extension string) (fileReference, []byte, error) {
	if root == "" {
		return fileReference{}, nil, errors.New("complete profile requires --samples-dir and --space-receipt")
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return fileReference{}, nil, errors.New("cannot resolve sample directory")
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return fileReference{}, nil, err
	}
	for _, ref := range refs {
		if !strings.EqualFold(filepath.Ext(ref.Name), extension) || strings.Contains(ref.Name, "损坏") {
			continue
		}
		if filepath.Base(ref.Name) != ref.Name || strings.ContainsAny(ref.Name, "/\\:") {
			return ref, nil, errors.New("invalid sample name")
		}
		target, err := filepath.EvalSymlinks(filepath.Join(resolved, ref.Name))
		if err != nil {
			return ref, nil, errors.New("receipt sample is missing")
		}
		rel, err := filepath.Rel(resolved, target)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			return ref, nil, errors.New("sample escaped its directory")
		}
		f, err := os.Open(target)
		if err != nil {
			return ref, nil, errors.New("cannot read sample")
		}
		data, readErr := io.ReadAll(io.LimitReader(f, account.CloudArtifactMaxBytes+1))
		_ = f.Close()
		if readErr != nil || int64(len(data)) != ref.Size || int64(len(data)) > account.CloudArtifactMaxBytes || digest(data) != ref.SHA256 {
			return ref, nil, errors.New("sample no longer matches receipt size/SHA256")
		}
		if _, err = zip.NewReader(bytes.NewReader(data), int64(len(data))); err != nil {
			return ref, nil, errors.New("Office sample is not a valid ZIP package")
		}
		return ref, data, nil
	}
	return fileReference{}, nil, fmt.Errorf("receipt has no usable %s sample", extension)
}

func fixtureSite(version int) ([]byte, *cloudsite.Manifest, error) {
	// Deterministic archive, no remote fonts/scripts or automatic publication.
	html := fmt.Sprintf(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合成验收数据 · 项目交付站点 v%d</title><link rel="stylesheet" href="style.css"><main><span class="tag">合成验收数据 · 私有预览 · v%d</span><h1>项目交付看板</h1><p>这是本地静态验收站点，未调用模型或 E2B。用于测试手机布局、版本切换、预览和用户手动分享。</p><section><article><strong>%d</strong><span>已完成事项</span></article><article><strong>3</strong><span>交付资料</span></article></section><button id="details" aria-expanded="false">查看交付说明</button><p id="note" hidden>Word、表格与站点都来自合成样例。当前版本：%d。</p><footer>仅合成数据，不包含真实业务信息。</footer></main><script src="app.js"></script></html>`, version, version, version*4, version)
	css := `*{box-sizing:border-box}body{margin:0;background:#f7f7f8;color:#191919;font:16px/1.7 system-ui,sans-serif}main{max-width:800px;margin:7vh auto;padding:32px}h1{font-size:clamp(30px,6vw,46px);line-height:1.2;letter-spacing:-1px}.tag{background:#fff;border:1px solid #e6e6e6;border-radius:20px;padding:7px 12px;font-size:13px;color:#666}section{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:32px 0}article{background:white;border:1px solid #e8e8e8;border-radius:20px;padding:24px;display:grid}strong{font-size:32px}button{border:0;border-radius:24px;background:#171717;color:white;padding:12px 20px;cursor:pointer;transition:background .15s}button:hover{background:#444}button:focus-visible{outline:3px solid #88bfff;outline-offset:3px}footer{color:#777;font-size:13px;margin-top:40px}@media(max-width:480px){main{padding:20px;margin:4vh auto}section{gap:10px}article{padding:16px}}`
	js := `document.getElementById('details').addEventListener('click',function(){const note=document.getElementById('note');note.hidden=!note.hidden;this.setAttribute('aria-expanded',String(!note.hidden));this.textContent=note.hidden?'查看交付说明':'收起交付说明';});`
	var data bytes.Buffer
	z := zip.NewWriter(&data)
	for _, entry := range []struct{ name, body string }{{"index.html", html}, {"style.css", css}, {"app.js", js}} {
		h := &zip.FileHeader{Name: entry.name, Method: zip.Store}
		h.SetModTime(time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC))
		w, err := z.CreateHeader(h)
		if err != nil {
			return nil, nil, err
		}
		if _, err = w.Write([]byte(entry.body)); err != nil {
			return nil, nil, err
		}
	}
	if err := z.Close(); err != nil {
		return nil, nil, err
	}
	result := data.Bytes()
	manifest, err := cloudsite.Inspect(bytes.NewReader(result), int64(len(result)), "index.html")
	return result, manifest, err
}

func buildCompleteFixtures(user int64, refs []fileReference, samples string) ([]fixturePlan, error) {
	doc, docBytes, err := readFixtureSample(samples, refs, ".docx")
	if err != nil {
		return nil, err
	}
	sheet, sheetBytes, err := readFixtureSample(samples, refs, ".xlsx")
	if err != nil {
		return nil, err
	}
	outputKey := "complete-deliverables-v1"
	sourceID := stableID(user, outputKey+":source")
	turn := fixtureTurn{User: "合成验收数据：查看已保存的文档、表格、两版私有站点及来源。此案例模拟成果保存后后续整理失败，不代表真实模型/E2B执行。", State: "failed", References: []fileReference{doc, sheet}, Blocks: []fixtureBlock{
		{Type: "reasoning", Round: 0, Seconds: 2, Text: "合成验收数据：先检查输入资料。"},
		{Type: "text", Round: 0, Seconds: 1, Text: "先准备可预览的交付成果。"},
		{Type: "reasoning", Round: 0, Seconds: 2, Text: "合成验收数据：继续整理文档、表格与站点的版本关系。"},
		{Type: "tool", Name: "publish_artifact", State: "succeeded", Status: "合成文档已保存", Seconds: 1},
		{Type: "tool", Name: "publish_artifact", State: "succeeded", Status: "合成表格已保存", Seconds: 1},
		{Type: "tool", Name: "publish_site", State: "succeeded", Status: "合成站点第一版已保存", Seconds: 1},
		{Type: "tool", Name: "publish_site", State: "succeeded", Status: "合成站点第二版已保存", Seconds: 1},
		{Type: "tool", Name: "fetch_page", State: "succeeded", Status: "合成来源快照已保存", Seconds: 1},
		{Type: "text", Round: 0, Seconds: 2, Text: "已保存 Word、表格和两版站点，可以直接打开预览。后续文字整理失败不影响这些成果。\n\n合成来源用于验证引用面板，并非联网研究结果。【来源:" + sourceID + ":L1-L3】"},
	}}
	plan, err := buildFixture(user, fixture{Key: outputKey, Title: "合成验收数据 · 成果保留与站点版本", Turns: []fixtureTurn{turn}, Pinned: true}, -4)
	if err != nil {
		return nil, err
	}
	plan.Conversation.Model = "synthetic-local-fixture"
	x := &fixtureExtras{}
	plan.Extras = x
	var p account.CloudPresentation
	if err = json.Unmarshal(plan.Messages[1].Presentation, &p); err != nil {
		return nil, err
	}
	p.Model = plan.Conversation.Model
	p.Usage = nil
	for i := range p.Rounds {
		p.Rounds[i].Model = p.Model
		p.Rounds[i].Usage = nil
	}
	runID := stableID(user, outputKey+":run")
	run := account.CloudRun{ID: runID, ConversationID: plan.Conversation.ID, UserID: user, SessionRef: digest([]byte(namespace + ":synthetic-no-session:" + runID)), ClientRequestID: stableID(user, outputKey+":request"), RequestHash: digest(plan.Messages[0].Content), Model: p.Model, ReasoningEffort: "high", RequestContent: plan.Messages[0].Content, UserMessageID: plan.Messages[0].ID, AssistantMessageID: plan.Messages[1].ID, State: "failed", ErrorCode: "synthetic_fixture", CreatedAt: plan.Messages[1].CreatedAt, UpdatedAt: plan.Conversation.UpdatedAt}
	var content []struct {
		Text string `json:"text"`
	}
	_ = json.Unmarshal(plan.Messages[1].Content, &content)
	for _, part := range content {
		run.Output += part.Text
	}
	x.Run = &run
	input := encoded(map[string]any{"synthetic": true, "fixture_namespace": namespace, "note": "本地合成验收数据；未执行模型、E2B 或联网请求"})
	for blockIndex := range p.Blocks {
		b := &p.Blocks[blockIndex]
		if b.Type != "tool" {
			continue
		}
		index := len(x.Tools)
		op := account.CloudToolOperation{ID: b.ToolID, UserID: user, ConversationID: plan.Conversation.ID, RunID: runID, CallKey: fmt.Sprintf("round:0:call:%d", index), Name: b.Name, Input: input, RequestHash: digest(input), State: "succeeded", Result: encoded(map[string]any{"synthetic": true}), Version: 1, CreatedAt: b.StartedAt, UpdatedAt: *b.CompletedAt}
		x.Tools = append(x.Tools, op)
		if index < 4 {
			familyKey := outputKey + ":document"
			name := "合成验收数据-季度工作方案.docx"
			mime := doc.MIME
			data := docBytes
			original := doc.FileID
			number := int64(1)
			var site *cloudsite.Manifest
			if index == 1 {
				familyKey = outputKey + ":spreadsheet"
				name = "合成验收数据-交付进度.xlsx"
				mime = sheet.MIME
				data = sheetBytes
				original = sheet.FileID
			}
			if index >= 2 {
				familyKey = outputKey + ":site"
				number = int64(index - 1)
				name = fmt.Sprintf("合成验收数据-交付站点-v%d.zip", number)
				mime = "application/zip"
				original = ""
				data, site, err = fixtureSite(int(number))
				if err != nil {
					return nil, err
				}
			}
			id := stableID(user, fmt.Sprintf("%s:version:%d", familyKey, number))
			family := stableID(user, familyKey)
			a := account.CloudArtifactVersion{ID: id, FamilyID: family, Number: number, UserID: user, ConversationID: plan.Conversation.ID, SourceRunID: runID, ToolOperationID: op.ID, RequestHash: digest(encoded([]string{namespace, id, digest(data)})), ObjectKey: fmt.Sprintf("accounts/%s/artifacts/%s/%s/content", digest([]byte(strconv.FormatInt(user, 10)))[:16], family, id), Name: name, MIME: mime, Size: int64(len(data)), SHA256: digest(data), State: "ready", Version: 1, CreatedAt: op.CreatedAt, UpdatedAt: op.UpdatedAt}
			item := fixtureArtifact{Artifact: a, Site: site, OriginalFileID: original, Data: append([]byte(nil), data...)}
			x.Artifacts = append(x.Artifacts, item)
			b.Resources = []account.CloudPresentationResource{artifactReference(item)}
		} else {
			body := "合成验收数据：本地项目交付说明。\n文档和表格使用验收原件，不含真实客户信息。\n静态站点有两个不可变版本，默认仅账号所有者可预览。\n本来源没有访问外部网站，也不证明模型执行。"
			x.Source = &account.CloudResearchSource{ID: sourceID, UserID: user, RunID: runID, ConversationID: plan.Conversation.ID, ToolOperationID: op.ID, Kind: "page", URL: "https://example.invalid/zeroagent-synthetic-fixture", FinalURL: "https://example.invalid/zeroagent-synthetic-fixture", Title: "合成验收数据 · 本地项目交付说明", Snippet: "本地合成来源，用于引用定位与来源阅读验收。", Text: body, SHA256: digest([]byte(body)), BodySHA256: digest([]byte(body)), ObservedAt: op.CreatedAt, TextBytes: len(body), LineCount: strings.Count(body, "\n") + 1, Version: 1, CreatedAt: op.CreatedAt}
			b.Resources = []account.CloudPresentationResource{{Kind: "source", ID: sourceID, Name: x.Source.Title, Version: 1, Role: "source"}}
		}
	}
	plan.Messages[1].Usage = nil
	plan.Messages[1].Presentation = encoded(p)
	run.Presentation = plan.Messages[1].Presentation
	run.LastSeq = int64(len(x.Tools) + 1)
	x.Run = &run
	plan.Fingerprint = ""
	plan.Fingerprint = digest(encoded(plan))

	queue, err := buildFixture(user, fixture{Key: "complete-pending-v1", Title: "合成验收数据 · 待发送队列", Turns: []fixtureTurn{simpleTurn("合成验收数据：检查待发送内容。", "下方三条待发送内容尚未执行。可编辑、重排、删除或取回输入框；发送仍需你明确操作。")}}, -3)
	if err != nil {
		return nil, err
	}
	queue.Extras = &fixtureExtras{Queue: &account.CloudPendingQueue{ConversationID: queue.Conversation.ID, Items: []account.CloudPendingItem{}}}
	texts := []string{"合成验收数据：请将工作方案压缩为三点摘要。", "合成验收数据：请核对交付表格中的里程碑。", "合成验收数据：请根据当前站点制作更新说明。"}
	mem := account.NewMemoryStore()
	ctx := context.Background()
	_ = mem.PutCloudConversation(ctx, &queue.Conversation)
	for index, text := range texts {
		parts := []any{map[string]string{"type": "text", "text": text}}
		if index == 0 {
			parts = append(parts, doc)
		}
		if index == 1 {
			parts = append(parts, sheet)
		}
		if index == 2 {
			a := x.Artifacts[3].Artifact
			parts = append(parts, map[string]any{"type": "artifact_reference", "version_id": a.ID, "name": a.Name, "mime": a.MIME, "size": a.Size})
		}
		item := account.CloudPendingItem{ClientItemID: stableID(user, fmt.Sprintf("complete-pending-v1:item:%d", index)), Content: encoded(parts), Model: "gpt-6.1-sol", ReasoningEffort: "high", Composer: fixtureComposer(text), Presentation: "work"}
		q, e := mem.MutateCloudPendingQueue(ctx, user, queue.Conversation.ID, account.CloudPendingMutation{Kind: "enqueue", ExpectedVersion: queue.Extras.Queue.Version, Item: &item})
		if e != nil {
			return nil, e
		}
		queue.Extras.Queue = q
	}
	for i := range queue.Extras.Queue.Items {
		queue.Extras.Queue.Items[i].CreatedAt = queue.Conversation.CreatedAt
		queue.Extras.Queue.Items[i].UpdatedAt = queue.Conversation.CreatedAt
	}
	queue.Fingerprint = ""
	queue.Fingerprint = digest(encoded(queue))

	draft, err := buildFixture(user, fixture{Key: "complete-saved-draft-v1", Title: "合成验收数据 · 服务端草稿恢复", Turns: []fixtureTurn{simpleTurn("合成验收数据：检查刷新后的输入恢复。", "此会话有尚未发送的工作模式草稿，含文档与成果引用。刷新后恢复，编辑后按正常草稿机制保存。")}}, -2)
	if err != nil {
		return nil, err
	}
	file := account.CloudFile{ID: doc.FileID, ConversationID: "", Name: doc.Name, MIME: doc.MIME, Size: doc.Size, SHA256: doc.SHA256, State: "ready", Version: 1, CreatedAt: draft.Conversation.CreatedAt, UpdatedAt: draft.Conversation.CreatedAt, WorkspaceLoadable: true}
	draft.Extras = &fixtureExtras{Draft: encoded(map[string]any{"version": 1, "draft": map[string]any{"composer": fixtureComposer("合成验收数据：请结合附带方案和表格，为下一次项目例会起草一份简报。\n保留这个未发送的草稿，用于验证刷新和切换会话。"), "files": []account.CloudFile{file}, "artifacts": []account.CloudArtifactVersion{x.Artifacts[1].Artifact}, "presentation": "work", "researchEnabled": false}, "modelSelection": map[string]any{"model": "gpt-6.1-sol", "reasoningEffort": "high", "modelParameters": map[string]any{}}})}
	_ = mem.PutCloudConversation(ctx, &draft.Conversation)
	if _, err = mem.WriteCloudPrivateDraft(ctx, user, draft.Conversation.ID, account.CloudPrivateDraftInput{ExpectedVersion: "0", ClientOperationID: stableID(user, draft.Key+":draft"), Draft: draft.Extras.Draft}, false); err != nil {
		return nil, err
	}
	draft.Fingerprint = ""
	draft.Fingerprint = digest(encoded(draft))
	return []fixturePlan{plan, queue, draft}, nil
}

func openFixtureObjects() (*cloudbackup.S3, error) {
	cfg, err := objectstore.ConfigFromEnv(os.Getenv)
	if err != nil {
		return nil, errors.New("invalid local object storage configuration")
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Host == "" || net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback() {
		return nil, errors.New("complete apply requires a literal loopback SeaweedFS/S3 endpoint")
	}
	store, err := cloudbackup.NewS3(cfg)
	if err != nil {
		return nil, errors.New("cannot initialize local object storage client")
	}
	return store, nil
}

func fixtureObjectMetadata(a account.CloudArtifactVersion) map[string]string {
	return map[string]string{
		"fixture":          "synthetic-cloudchat-v1",
		"artifact-version": a.ID,
		"artifact-family":  a.FamilyID,
		"owner-scope":      "account-" + digest([]byte(strconv.FormatInt(a.UserID, 10)))[:32],
	}
}

func verifyFixtureObject(ctx context.Context, store fixtureObjectStore, a fixtureArtifact) error {
	o, err := store.Get(ctx, a.Artifact.ObjectKey)
	if err != nil {
		return err
	}
	defer o.Body.Close()
	if o.Size != a.Artifact.Size || o.SHA256 != a.Artifact.SHA256 {
		return errors.New("stored fixture integrity metadata does not match")
	}
	for key, value := range fixtureObjectMetadata(a.Artifact) {
		if o.Metadata[key] != value {
			return errors.New("stored fixture ownership metadata does not match")
		}
	}
	b, err := io.ReadAll(io.LimitReader(o.Body, account.CloudArtifactMaxBytes+1))
	if err != nil || int64(len(b)) != a.Artifact.Size || digest(b) != a.Artifact.SHA256 || o.ContentType != a.Artifact.MIME {
		return errors.New("stored fixture bytes do not match immutable metadata")
	}
	return nil
}
func ensureFixtureObject(ctx context.Context, store fixtureObjectStore, a fixtureArtifact) error {
	if store == nil {
		return errors.New("local object storage is required")
	}
	if int64(len(a.Data)) != a.Artifact.Size || digest(a.Data) != a.Artifact.SHA256 {
		return errors.New("fixture payload mismatch")
	}
	err := verifyFixtureObject(ctx, store, a)
	if err == nil {
		return nil
	}
	if !errors.Is(err, objectstore.ErrNotFound) {
		return errors.New("existing object could not be verified; it was not overwritten")
	}
	err = store.PutIfAbsent(ctx, a.Artifact.ObjectKey, bytes.NewReader(a.Data), a.Artifact.Size, objectstore.PutOptions{ContentType: a.Artifact.MIME, SHA256: a.Artifact.SHA256, Metadata: fixtureObjectMetadata(a.Artifact)})
	// An unknown conditional PUT is reconciled only by reading the same key.
	// Existing different bytes never get a second unconditional write.
	if check := verifyFixtureObject(ctx, store, a); check != nil {
		if err != nil {
			return errors.New("conditional fixture upload unconfirmed; rerun the same plan")
		}
		return check
	}
	return nil
}

func checkFixtureQuota(ctx context.Context, tx *sql.Tx, user int64, x *fixtureExtras) error {
	var added int64
	for _, a := range x.Artifacts {
		added += a.Artifact.Size
	}
	if added == 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_space_quota:'||$1::text,0))`, user); err != nil {
		return err
	}
	var totalLimit, artifactLimit, total, artifactUsed int64
	var maxVersions, versions int
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(l.limit_bytes,$2),COALESCE(l.artifact_limit_bytes,$3),COALESCE(l.max_artifact_versions,$4) FROM (SELECT 1) singleton LEFT JOIN zeroagent_cloud_space_limits l ON l.user_id=$1`, user, account.CloudSpaceDefaultBytes, account.CloudArtifactMaxAccountBytes, account.CloudArtifactMaxAccountVersions).Scan(&totalLimit, &artifactLimit, &maxVersions)
	if err != nil {
		return err
	}
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(size),0),count(*) FROM zeroagent_cloud_artifact_versions WHERE user_id=$1 AND state<>'deleted'`, user).Scan(&artifactUsed, &versions)
	if err != nil {
		return err
	}
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(size),0) FROM zeroagent_cloud_files WHERE user_id=$1 AND state<>'deleted'`, user).Scan(&total)
	if err != nil {
		return err
	}
	if added > totalLimit-total-artifactUsed || added > artifactLimit-artifactUsed || versions+len(x.Artifacts) > maxVersions {
		return errors.New("local fixture exceeds this account's existing storage quota")
	}
	return nil
}

func insertFixtureExtras(ctx context.Context, tx *sql.Tx, user int64, plan fixturePlan, objects fixtureObjectStore) error {
	x := plan.Extras
	c := plan.Conversation
	if x == nil {
		return nil
	}
	if err := checkFixtureQuota(ctx, tx, user, x); err != nil {
		return err
	}
	if x.Run != nil {
		r := x.Run
		if !r.Terminal() || r.Attempt != 0 || r.LeaseOwner != "" || !r.LeaseUntil.IsZero() || r.UserID != user || r.ConversationID != c.ID {
			return errors.New("fixture run must be inert and account scoped")
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_runs(id,conversation_id,user_id,session_ref,client_request_id,request_hash,model,reasoning_effort,request_content,user_message_id,assistant_message_id,state,output,error_code,last_seq,created_at,updated_at,presentation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`, r.ID, c.ID, user, r.SessionRef, r.ClientRequestID, r.RequestHash, r.Model, r.ReasoningEffort, string(r.RequestContent), r.UserMessageID, r.AssistantMessageID, r.State, r.Output, r.ErrorCode, r.LastSeq, r.CreatedAt, r.UpdatedAt, string(r.Presentation))
		if err != nil {
			return errors.New("synthetic terminal lineage insert failed")
		}
		for _, op := range x.Tools {
			if op.State != "succeeded" || op.UserID != user || op.RunID != r.ID || op.ConversationID != c.ID {
				return errors.New("invalid synthetic tool lineage")
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_tool_operations(id,user_id,conversation_id,run_id,call_key,name,request_hash,input,state,result,execution_attempt,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'succeeded',$9::jsonb,0,1,$10,$11)`, op.ID, user, c.ID, r.ID, op.CallKey, op.Name, op.RequestHash, string(op.Input), string(op.Result), op.CreatedAt, op.UpdatedAt)
			if err != nil {
				return errors.New("synthetic terminal tool insert failed")
			}
		}
		for _, item := range x.Artifacts {
			a := item.Artifact
			if a.UserID != user || a.ConversationID != c.ID || a.SourceRunID != r.ID || a.State != "ready" || a.Size > account.CloudArtifactMaxBytes {
				return errors.New("invalid artifact fixture lineage")
			}
			// A collision, including an orphaned family from a deleted conversation,
			// is never adopted as this fixture's identity.
			if a.Number == 1 {
				_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_artifact_families(id,user_id,conversation_id,created_at) VALUES($1,$2,$3,$4)`, a.FamilyID, user, c.ID, a.CreatedAt)
				if err != nil {
					return errors.New("artifact fixture family already exists or is unavailable")
				}
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_artifact_versions(id,family_id,user_id,conversation_id,source_run_id,tool_operation_id,request_hash,number,object_key,name,mime,size,sha256,state,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ready',1,$14,$15)`, a.ID, a.FamilyID, user, c.ID, r.ID, a.ToolOperationID, a.RequestHash, a.Number, a.ObjectKey, a.Name, a.MIME, a.Size, a.SHA256, a.CreatedAt, a.UpdatedAt)
			if err != nil {
				return errors.New("artifact fixture version insert failed")
			}
			if item.Site != nil {
				checked, e := cloudsite.Inspect(bytes.NewReader(item.Data), a.Size, "index.html")
				if e != nil || !bytes.Equal(encoded(checked), encoded(item.Site)) {
					return errors.New("site fixture manifest mismatch")
				}
				_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_site_releases(id,site_id,user_id,sha256,manifest,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, a.ID, a.FamilyID, user, a.SHA256, string(encoded(item.Site)), a.CreatedAt)
				if err != nil {
					return errors.New("site fixture release insert failed")
				}
			}
			if err = ensureFixtureObject(ctx, objects, item); err != nil {
				return err
			}
		}
		if x.Source != nil {
			if err = insertFixtureSource(ctx, tx, user, *x.Source); err != nil {
				return err
			}
		}
		var presentation account.CloudPresentation
		if json.Unmarshal(r.Presentation, &presentation) != nil {
			return errors.New("invalid fixture projection")
		}
		seq := int64(0)
		for _, block := range presentation.Blocks {
			if block.Type != "tool" {
				continue
			}
			seq++
			payload := map[string]any{"block_id": block.ID, "round": block.Round, "tool_id": block.ToolID, "name": block.Name, "state": block.State, "status": block.Status, "started_at": block.StartedAt, "completed_at": block.CompletedAt, "resources": block.Resources}
			if err = insertFixtureEvent(ctx, tx, user, r.ID, seq, "tool.completed", payload, *block.CompletedAt); err != nil {
				return err
			}
		}
		if err = insertFixtureEvent(ctx, tx, user, r.ID, seq+1, "run."+r.State, map[string]any{"state": r.State, "started_at": r.CreatedAt, "completed_at": r.UpdatedAt, "error_code": "synthetic_fixture"}, r.UpdatedAt); err != nil {
			return err
		}
	}
	if x.Queue != nil {
		q := x.Queue
		if q.ConversationID != c.ID || len(q.Items) > account.CloudPendingMaxItems || len(encoded(q.Items)) > account.CloudPendingMaxQueueBytes {
			return errors.New("invalid fixture pending queue")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_pending_queues(conversation_id,user_id,version,items) VALUES($1,$2,$3,$4::jsonb)`, c.ID, user, q.Version, string(encoded(q.Items))); err != nil {
			return errors.New("pending fixture insert failed")
		}
	}
	if len(x.Draft) > 0 {
		return insertFixtureDraft(ctx, tx, user, plan)
	}
	return nil
}

func insertFixtureSource(ctx context.Context, tx *sql.Tx, user int64, s account.CloudResearchSource) error {
	// Canonical source budgets and mutex, without a fake search reservation.
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_research_sources:'||$1::text,0))`, user); err != nil {
		return err
	}
	var count, total int64
	if err := tx.QueryRowContext(ctx, `SELECT count(*),COALESCE(sum(octet_length(snippet)+octet_length(body)),0) FROM zeroagent_cloud_research_sources WHERE user_id=$1 AND deleted_at IS NULL`, user).Scan(&count, &total); err != nil {
		return err
	}
	if count >= account.CloudResearchSourceMaxCount || total+int64(len(s.Snippet)+len(s.Text)) > account.CloudResearchSourceMaxAccountBytes {
		return errors.New("source fixture exceeds account quota")
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_research_sources(id,user_id,run_id,conversation_id,tool_operation_id,ordinal,kind,url,final_url,title,snippet,body,sha256,body_sha256,observed_at,truncated,text_bytes,line_count,version,created_at) VALUES($1,$2,$3,$4,$5,0,'page',$6,$7,$8,$9,$10,$11,$12,$13,FALSE,$14,$15,1,$16)`, s.ID, user, s.RunID, s.ConversationID, s.ToolOperationID, s.URL, s.FinalURL, s.Title, s.Snippet, s.Text, s.SHA256, s.BodySHA256, s.ObservedAt, s.TextBytes, s.LineCount, s.CreatedAt)
	if err != nil {
		return err
	}
	input := account.CloudResearchSourceInput{Kind: s.Kind, URL: s.URL, FinalURL: s.FinalURL, Title: s.Title, Snippet: s.Snippet, Text: s.Text, SHA256: s.SHA256, BodySHA256: s.BodySHA256, ObservedAt: s.ObservedAt}
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_research_publications(operation_id,user_id,run_id,request_hash,source_ids,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, s.ToolOperationID, user, s.RunID, digest(encoded([]account.CloudResearchSourceInput{input})), string(encoded([]string{s.ID})), s.CreatedAt)
	return err
}
func insertFixtureEvent(ctx context.Context, tx *sql.Tx, user int64, run string, seq int64, kind string, payload any, at time.Time) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_run_events(id,run_id,user_id,seq,type,payload,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, stableID(user, fmt.Sprintf("%s:event:%d", run, seq)), run, user, seq, kind, string(encoded(payload)), at)
	return err
}
func insertFixtureDraft(ctx context.Context, tx *sql.Tx, user int64, plan fixturePlan) error {
	data := plan.Extras.Draft
	scope := plan.Conversation.ID
	if len(data) > account.CloudPrivateDraftMaxBytes {
		return errors.New("fixture draft exceeds per-scope quota")
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_draft_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING`, user); err != nil {
		return err
	}
	var revision, count, total int64
	if err := tx.QueryRowContext(ctx, `SELECT version FROM zeroagent_cloud_draft_accounts WHERE user_id=$1 FOR UPDATE`, user).Scan(&revision); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, `SELECT count(*),COALESCE(sum(size_bytes),0) FROM zeroagent_cloud_private_drafts WHERE user_id=$1 AND draft IS NOT NULL`, user).Scan(&count, &total); err != nil {
		return err
	}
	if revision >= 9223372036854775807 || count >= account.CloudPrivateDraftMaxCount || total+int64(len(data)) > account.CloudPrivateDraftAccountBytes {
		return errors.New("fixture draft exceeds account quota")
	}
	op := stableID(user, plan.Key+":draft")
	hash := digest(encoded(struct {
		Scope   string
		Version int64
		Remove  bool
		Draft   json.RawMessage
	}{scope, 0, false, data}))
	// scope is TEXT while conversation_id is UUID. Separate bindings keep
	// PostgreSQL from inferring incompatible types for the same parameter.
	if _, err := tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_private_drafts(user_id,scope,conversation_id,version,draft,size_bytes,last_operation_id,updated_at) VALUES($1,$2,$3::uuid,$4,$5::jsonb,$6,$7,$8)`, user, scope, scope, revision+1, string(data), len(data), op, plan.Conversation.UpdatedAt); err != nil {
		return errors.New("fixture draft scope already exists or is unavailable")
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_draft_operations(user_id,client_operation_id,request_hash,result_version) VALUES($1,$2,$3,$4)`, user, op, hash, revision+1); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE zeroagent_cloud_draft_accounts SET version=$2 WHERE user_id=$1 AND version=$3`, user, revision+1, revision)
	return err
}
