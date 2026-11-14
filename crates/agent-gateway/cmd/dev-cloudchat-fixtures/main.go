// dev-cloudchat-fixtures is an explicit, loopback-only development data command.
// It has no HTTP route, never creates runnable work and never invokes a model.
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
	"github.com/liveagent/agent-gateway/internal/account"
)

//go:embed fixtures.json
var definitions []byte

const namespace = "zeroagent-dev-cloudchat-conversations-v1"

type fixtureBlock struct {
	Type    string `json:"type"`
	Round   int    `json:"round"`
	Seconds int    `json:"seconds"`
	Text    string `json:"text"`
	Repeat  int    `json:"repeat"`
	Name    string `json:"name"`
	State   string `json:"state"`
	Status  string `json:"status"`
}
type fixtureTurn struct {
	User       string          `json:"user"`
	State      string          `json:"state"`
	Blocks     []fixtureBlock  `json:"blocks"`
	References []fileReference `json:"-"`
}
type fixture struct {
	Key      string        `json:"key"`
	Title    string        `json:"title"`
	Turns    []fixtureTurn `json:"turns"`
	Pinned   bool          `json:"pinned"`
	Archived bool          `json:"archived"`
}
type fileReference struct {
	Type   string `json:"type"`
	FileID string `json:"file_id"`
	Name   string `json:"name"`
	MIME   string `json:"mime"`
	Size   int64  `json:"size"`
	SHA256 string `json:"-"`
}
type fixturePlan struct {
	ProjectID    string                    `json:"project_id,omitempty"`
	Key          string                    `json:"key"`
	Conversation account.CloudConversation `json:"conversation"`
	Messages     []account.CloudMessage    `json:"messages"`
	Branch       *account.CloudBranch      `json:"branch,omitempty"`
	Fingerprint  string                    `json:"fingerprint"`
	Extras       *fixtureExtras            `json:"extras,omitempty"`
}
type receiptEntry struct {
	ProjectID      string               `json:"project_id,omitempty"`
	Key            string               `json:"key"`
	ConversationID string               `json:"conversation_id"`
	Title          string               `json:"title"`
	MessageCount   int                  `json:"message_count"`
	FirstMessageID string               `json:"first_message_id"`
	LastMessageID  string               `json:"last_message_id"`
	Fingerprint    string               `json:"fingerprint"`
	Status         string               `json:"status"`
	URL            string               `json:"url"`
	Resources      *fixtureExtraReceipt `json:"resources,omitempty"`
}
type receipt struct {
	Format         string         `json:"format"`
	UserID         int64          `json:"user_id"`
	Applied        bool           `json:"applied"`
	ManifestSHA256 string         `json:"manifest_sha256"`
	Entries        []receiptEntry `json:"entries"`
}

func digest(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
func encoded(value any) json.RawMessage {
	result, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return result
}
func stableID(user int64, key string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(namespace+":"+strconv.FormatInt(user, 10)+":"+key)).String()
}
func pointer(value time.Time) *time.Time { return &value }
func terminal(state string) bool {
	return state == "completed" || state == "failed" || state == "cancelled" || state == "interrupted"
}

func buildFixture(user int64, item fixture, index int) (fixturePlan, error) {
	if user <= 0 || item.Key == "" || !strings.Contains(item.Title, "合成验收数据") {
		return fixturePlan{}, errors.New("invalid fixture identity")
	}
	base := time.Date(2026, 10, 31, 11, 0, 0, 0, time.UTC).Add(-time.Duration(index) * time.Hour)
	conversation := account.CloudConversation{ID: stableID(user, item.Key), UserID: user, Title: item.Title, Model: "gpt-6.1-sol", CreatedAt: base, UpdatedAt: base, Pinned: item.Pinned, Archived: item.Archived}
	plan := fixturePlan{Key: item.Key, Conversation: conversation, Messages: []account.CloudMessage{}}
	at := base
	for turnIndex, turn := range item.Turns {
		if !terminal(turn.State) || len(turn.Blocks) > 512 {
			return plan, errors.New("only bounded terminal fixtures are allowed")
		}
		content := []any{map[string]any{"type": "text", "text": turn.User}}
		for _, ref := range turn.References {
			content = append(content, ref)
		}
		plan.Messages = append(plan.Messages, account.CloudMessage{ID: stableID(user, fmt.Sprintf("%s:user:%d", item.Key, turnIndex)), ConversationID: conversation.ID, UserID: user, Role: "user", Content: encoded(content), CreatedAt: at})
		at = at.Add(time.Second)
		started := at
		presentation := account.CloudPresentation{Version: 1, Model: conversation.Model, ReasoningEffort: "high", State: turn.State, StartedAt: started, Blocks: []account.CloudPresentationBlock{}}
		body := []string{}
		seen := map[string]bool{}
		segments := map[string]int{}
		reasoningBytes := map[int]int{}
		rounds := map[int]int{}
		for blockIndex, block := range turn.Blocks {
			if block.Seconds < 1 || block.Seconds > 3600 || block.Round < 0 || block.Round > 1024 {
				return plan, errors.New("invalid fixture timing")
			}
			end := at.Add(time.Duration(block.Seconds) * time.Second)
			part := account.CloudPresentationBlock{Type: block.Type, Round: block.Round, StartedAt: at, CompletedAt: pointer(end)}
			if block.Type == "tool" {
				if block.Name != "read_file" && block.Name != "execute_code" && block.Name != "publish_site" && block.Name != "publish_artifact" && block.Name != "fetch_page" {
					return plan, errors.New("invalid synthetic tool")
				}
				if block.State != "succeeded" && block.State != "failed" && block.State != "cancelled" && block.State != "unknown" {
					return plan, errors.New("synthetic tool must be terminal")
				}
				part.ToolID = stableID(user, fmt.Sprintf("%s:tool:%d:%d", item.Key, turnIndex, blockIndex))
				part.ID = "tool:" + part.ToolID
				part.Name, part.State, part.Status = block.Name, block.State, block.Status
			} else {
				if block.Type != "text" && block.Type != "reasoning" {
					return plan, errors.New("invalid fixture block")
				}
				repeat := block.Repeat
				if repeat == 0 {
					repeat = 1
				}
				if repeat < 1 || repeat > 20000 {
					return plan, errors.New("invalid repetition")
				}
				part.ID = fmt.Sprintf("%s:%d", block.Type, block.Round)
				segments[part.ID]++
				if segments[part.ID] > 1 {
					part.ID += fmt.Sprintf(":%d", segments[part.ID])
				}
				part.Text = strings.Repeat(block.Text, repeat)
				if block.Type == "reasoning" {
					reasoningBytes[block.Round] += len(part.Text)
				}
				if reasoningBytes[block.Round] > 1<<20 {
					return plan, errors.New("reasoning fixture exceeds one MiB")
				}
				if block.Type == "text" {
					body = append(body, part.Text)
				}
				if roundIndex, ok := rounds[block.Round]; ok {
					presentation.Rounds[roundIndex].CompletedAt = pointer(end)
				} else {
					rounds[block.Round] = len(presentation.Rounds)
					presentation.Rounds = append(presentation.Rounds, account.CloudPresentationRound{Round: block.Round, Model: conversation.Model, StartedAt: at, CompletedAt: pointer(end), Usage: encoded(map[string]int{"prompt_tokens": 120, "completion_tokens": 80, "total_tokens": 200})})
				}
			}
			if seen[part.ID] {
				return plan, errors.New("duplicate synthetic block")
			}
			seen[part.ID] = true
			presentation.Blocks = append(presentation.Blocks, part)
			at = end
		}
		presentation.CompletedAt = pointer(at)
		presentation.Usage = encoded(map[string]int{"prompt_tokens": 120 * len(rounds), "completion_tokens": 80 * len(rounds), "total_tokens": 200 * len(rounds)})
		projection := encoded(presentation)
		if len(projection) > 16<<20 || len(strings.Join(body, "\n\n")) > 8<<20 {
			return plan, errors.New("fixture exceeds conversation limits")
		}
		plan.Messages = append(plan.Messages, account.CloudMessage{ID: stableID(user, fmt.Sprintf("%s:assistant:%d", item.Key, turnIndex)), ConversationID: conversation.ID, UserID: user, Role: "assistant", Content: encoded([]any{map[string]any{"type": "text", "text": strings.Join(body, "\n\n")}}), Presentation: projection, Usage: presentation.Usage, CreatedAt: started})
		at = at.Add(time.Second)
	}
	plan.Conversation.UpdatedAt = at
	plan.Fingerprint = digest(encoded(plan))
	return plan, nil
}

func simpleTurn(user, answer string) fixtureTurn {
	return fixtureTurn{User: user, State: "completed", Blocks: []fixtureBlock{{Type: "text", Text: answer, Seconds: 2}}}
}

func buildPlans(user int64, refs []fileReference) ([]fixturePlan, error) {
	var source struct {
		Version  int       `json:"version"`
		Fixtures []fixture `json:"fixtures"`
	}
	if json.Unmarshal(definitions, &source) != nil || source.Version != 1 {
		return nil, errors.New("invalid fixture manifest")
	}
	for index := 0; index < 60; index++ {
		marker := ""
		if index == 59 {
			marker = " 后页星河计划：这个匹配位于目录后页。"
		}
		source.Fixtures = append(source.Fixtures, fixture{Key: fmt.Sprintf("catalog-%02d", index), Title: fmt.Sprintf("合成验收数据 · 分页样例 %02d", index+1), Pinned: index == 0 || index == 1, Archived: index == 2 || index == 3, Turns: []fixtureTurn{simpleTurn("合成验收数据：第"+strconv.Itoa(index+1)+"份分页记录。"+marker, "这是用于目录分页、置顶和归档的合成回复。")}})
	}
	longHistory := fixture{Key: "long-history", Title: "合成验收数据 · 72 条消息与定位"}
	for index := 0; index < 36; index++ {
		marker := ""
		if index == 0 {
			marker = " 旧页蓝鲸锚点：应直接跳转到首条消息，不能只检索当前已加载的 50 条。"
		}
		longHistory.Turns = append(longHistory.Turns, simpleTurn(fmt.Sprintf("合成验收数据：第 %02d 轮，核对这一条记录。%s", index+1, marker), fmt.Sprintf("第 %02d 轮已整理。\n\n合成验收数据：历史分页不改变现有消息顺序或草稿。", index+1)))
	}
	source.Fixtures = append(source.Fixtures, longHistory)
	paragraph := "合成验收数据：这是一段长文阅读样例，用于验证正文省略、完整读取和滚动恢复。所有叙述都只是界面验收素材，不构成真实业务结论。\n\n"
	longText := simpleTurn("合成验收数据：请展示长文按需加载。", "# 长文阅读\n\n"+strings.Repeat(paragraph, 16000)+"\n长文尾部灯塔标记：全文已经读到最后。")
	source.Fixtures = append(source.Fixtures, fixture{Key: "long-answer", Title: "合成验收数据 · 长文完整阅读", Turns: []fixtureTurn{longText}})
	for index := 0; index < len(refs); index += 5 {
		end := min(index+5, len(refs))
		turn := simpleTurn("合成验收数据：这些引用连接本账号已有的资料验收原件，可点击预览。这里只演示引用，不会触发模型或解析任务。", "合成验收数据：已引用资料原件。可检查文件卡片、预览、返回对话和手机布局。")
		turn.References = refs[index:end]
		source.Fixtures = append(source.Fixtures, fixture{Key: fmt.Sprintf("resource-references-%d", index/5), Title: fmt.Sprintf("合成验收数据 · 资料引用 %d", index/5+1), Turns: []fixtureTurn{turn}})
	}
	plans := make([]fixturePlan, 0, len(source.Fixtures)+3)
	for index, item := range source.Fixtures {
		plan, err := buildFixture(user, item, index)
		if err != nil {
			return nil, fmt.Errorf("fixture %s: %w", item.Key, err)
		}
		plans = append(plans, plan)
	}
	for index, action := range []string{"fork", "edit", "regenerate"} {
		item := fixture{Key: "branch-" + action, Title: "合成验收数据 · " + action + " 分支", Turns: []fixtureTurn{simpleTurn("合成验收数据：原会话保留，从来源消息继续探索另一种表达。", "这是一份独立的合成分支，使用分支入口可以返回来源对话。")}}
		plan, err := buildFixture(user, item, -index-1)
		if err != nil {
			return nil, err
		}
		sourceMessage := plans[0].Messages[1].ID
		if action == "edit" {
			sourceMessage = plans[0].Messages[2].ID
		}
		if action != "regenerate" {
			prefix := make([]account.CloudMessage, 2)
			for offset, original := range plans[0].Messages[:2] {
				prefix[offset] = original
				prefix[offset].ID = stableID(user, fmt.Sprintf("%s:prefix:%d", item.Key, offset))
				prefix[offset].ConversationID = plan.Conversation.ID
			}
			plan.Messages = append(prefix, plan.Messages...)
		}
		plan.Branch = &account.CloudBranch{Conversation: &plan.Conversation, SourceConversationID: plans[0].Conversation.ID, SourceMessageID: sourceMessage, Action: action}
		plan.Fingerprint = ""
		plan.Fingerprint = digest(encoded(plan))
		plans = append(plans, plan)
	}
	return plans, nil
}

func loadReferences(path string, user int64) ([]fileReference, error) {
	if path == "" {
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("cannot read resource receipt")
	}
	defer func() { _ = file.Close() }()
	raw, err := io.ReadAll(io.LimitReader(file, 2<<20+1))
	if err != nil || len(raw) > 2<<20 {
		return nil, errors.New("resource receipt exceeds limit")
	}
	var receipt struct {
		UserID  int64 `json:"user_id"`
		Entries []struct {
			ID, Kind, Name, MIME, SHA256, Phase string
			Size                                int64
		}
	}
	if json.Unmarshal(raw, &receipt) != nil || receipt.UserID != user {
		return nil, errors.New("resource receipt belongs to another account")
	}
	refs := []fileReference{}
	seen := map[string]bool{}
	for _, entry := range receipt.Entries {
		if entry.Kind != "file" || entry.Phase != "complete" {
			continue
		}
		parsed, err := uuid.Parse(entry.ID)
		if err != nil || seen[parsed.String()] || len(entry.SHA256) != 64 || len(entry.Name) > 255 || entry.Size < 0 {
			return nil, errors.New("invalid resource receipt entry")
		}
		seen[parsed.String()] = true
		refs = append(refs, fileReference{Type: "file_reference", FileID: parsed.String(), Name: entry.Name, MIME: entry.MIME, Size: entry.Size, SHA256: entry.SHA256})
	}
	if len(refs) > 100 {
		return nil, errors.New("too many reference fixtures")
	}
	return refs, nil
}

// Only URL DSNs are accepted; libpq parameter overrides cannot redirect this command.
func loopbackDSN(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Host == "" || u.Fragment != "" || u.Path == "" {
		return "", errors.New("a loopback PostgreSQL URL is required")
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	if strings.EqualFold(host, "localhost") {
		host = "127.0.0.1"
	} else if ip == nil || !ip.IsLoopback() {
		return "", errors.New("only a literal loopback database host is allowed")
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return "", errors.New("invalid PostgreSQL parameters")
	}
	for key, values := range query {
		if (key != "sslmode" && key != "connect_timeout") || len(values) != 1 {
			return "", errors.New("PostgreSQL connection overrides are not allowed")
		}
	}
	port := u.Port()
	if port == "" {
		port = "5432"
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", errors.New("invalid PostgreSQL port")
	}
	u.Host = net.JoinHostPort(host, port)
	query.Set("connect_timeout", "5")
	u.RawQuery = query.Encode()
	return u.String(), nil
}

type localDialer struct{ net.Dialer }

func (d localDialer) Dial(network, address string) (net.Conn, error) {
	return d.DialTimeout(network, address, 5*time.Second)
}
func (d localDialer) DialTimeout(network, address string, timeout time.Duration) (net.Conn, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return nil, errors.New("database dial blocked")
	}
	return (&net.Dialer{Timeout: timeout}).Dial(network, address)
}

func jsonValue(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return string(raw)
}

func applyPlans(ctx context.Context, dsn string, user int64, plans []fixturePlan, refs []fileReference, previous map[string]bool, objects fixtureObjectStore) ([]string, error) {
	safe, err := loopbackDSN(dsn)
	if err != nil {
		return nil, err
	}
	connector, err := pq.NewConnector(safe)
	if err != nil {
		return nil, errors.New("invalid local database configuration")
	}
	connector.Dialer(localDialer{})
	db := sql.OpenDB(connector)
	defer func() { _ = db.Close() }()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return nil, errors.New("cannot open local database transaction")
	}
	defer func() { _ = tx.Rollback() }()
	// Same ordering as canonical artifact reservations; no user content is updated.
	if objects != nil {
		if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_space_write:'||$1::text,0))`, user); err != nil {
			return nil, err
		}
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(0x5a434346)); err != nil {
		return nil, errors.New("cannot lock development fixture namespace")
	}
	var columns int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='zerobox_cloud_conversations' AND column_name IN ('pinned','archived','management_version')) OR (table_name='zerobox_cloud_messages' AND column_name='presentation'))`).Scan(&columns); err != nil || columns != 4 {
		return nil, errors.New("start the updated development Gateway to initialize the schema first")
	}
	for _, ref := range refs {
		var exists bool
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_files WHERE user_id=$1 AND id=$2 AND name=$3 AND mime=$4 AND size=$5 AND sha256=$6 AND deleted_at IS NULL AND state NOT IN ('deleting','deleted'))`, user, ref.FileID, ref.Name, ref.MIME, ref.Size, ref.SHA256).Scan(&exists)
		if err != nil || !exists {
			return nil, errors.New("resource reference no longer matches this account; no fixture was written")
		}
	}
	projectPresent, err := prepareReaderProject(ctx, tx, user, plans, previous)
	if err != nil {
		return nil, err
	}
	statuses := make([]string, len(plans))
	if !projectPresent {
		for i := range statuses {
			statuses[i] = "preserved_deleted_project"
		}
		return statuses, nil
	}
	for index, plan := range plans {
		c := plan.Conversation
		var owner int64
		err = tx.QueryRowContext(ctx, `SELECT user_id FROM zerobox_cloud_conversations WHERE id=$1`, c.ID).Scan(&owner)
		if err == nil {
			if owner != user {
				return nil, errors.New("fixture ID collides with another account")
			}
			if plan.Extras != nil {
				// Queue/draft edits and individual resource deletion are intentional.
				// Never repair a partially changed bundle by replaying fixture input.
				statuses[index] = "preserved_existing_bundle"
				continue
			}
			matches, checkErr := matchesExisting(ctx, tx, plan)
			if checkErr != nil {
				return nil, checkErr
			}
			statuses[index] = "preserved_user_changes"
			if matches {
				statuses[index] = "already_present"
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, errors.New("cannot inspect existing fixtures")
		}
		if previous[c.ID] {
			statuses[index] = "preserved_deleted"
			continue
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO zerobox_cloud_conversations(id,user_id,title,model,created_at,updated_at,pinned,archived,management_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, c.ID, user, c.Title, c.Model, c.CreatedAt, c.UpdatedAt, c.Pinned, c.Archived, c.ManagementVersion); err != nil {
			return nil, errors.New("conversation fixture insert failed; transaction rolled back")
		}
		if plan.ProjectID != "" {
			if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_project_conversations(conversation_id,user_id,project_id,version) VALUES($1,$2,$3,1)`, c.ID, user, plan.ProjectID); err != nil {
				return nil, err
			}
		}
		for _, m := range plan.Messages {
			if _, err = tx.ExecContext(ctx, `INSERT INTO zerobox_cloud_messages(id,conversation_id,user_id,role,content,usage,created_at,presentation) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb)`, m.ID, c.ID, user, m.Role, string(m.Content), jsonValue(m.Usage), m.CreatedAt, jsonValue(m.Presentation)); err != nil {
				return nil, errors.New("message fixture insert failed; transaction rolled back")
			}
		}
		if plan.Branch != nil {
			if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_branches(user_id,client_request_id,request_hash,destination_conversation_id,result,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, user, namespace+":"+plan.Key, plan.Fingerprint, c.ID, string(encoded(plan.Branch)), c.CreatedAt); err != nil {
				return nil, errors.New("branch fixture insert failed; transaction rolled back")
			}
		}
		if plan.Extras != nil {
			if err = insertFixtureExtras(ctx, tx, user, plan, objects); err != nil {
				return nil, err
			}
		}
		statuses[index] = "created"
	}
	if err = tx.Commit(); err != nil {
		return nil, errors.New("local fixture commit is unconfirmed; rerun the same command to reconcile")
	}
	return statuses, nil
}

func matchesExisting(ctx context.Context, tx *sql.Tx, plan fixturePlan) (bool, error) {
	c := plan.Conversation
	var matches bool
	err := tx.QueryRowContext(ctx, `SELECT title=$3 AND model=$4 AND created_at=$5 AND updated_at=$6 AND pinned=$7 AND archived=$8 AND management_version=$9 FROM zerobox_cloud_conversations WHERE user_id=$1 AND id=$2`, c.UserID, c.ID, c.Title, c.Model, c.CreatedAt, c.UpdatedAt, c.Pinned, c.Archived, c.ManagementVersion).Scan(&matches)
	if err != nil {
		return false, errors.New("cannot compare existing fixture")
	}
	if !matches {
		return false, nil
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM zerobox_cloud_messages WHERE user_id=$1 AND conversation_id=$2`, c.UserID, c.ID).Scan(&count); err != nil {
		return false, errors.New("cannot compare fixture messages")
	}
	if count != len(plan.Messages) {
		return false, nil
	}
	for _, m := range plan.Messages {
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zerobox_cloud_messages WHERE user_id=$1 AND conversation_id=$2 AND id=$3 AND role=$4 AND content=$5::jsonb AND usage IS NOT DISTINCT FROM $6::jsonb AND created_at=$7 AND presentation IS NOT DISTINCT FROM $8::jsonb)`, c.UserID, c.ID, m.ID, m.Role, string(m.Content), jsonValue(m.Usage), m.CreatedAt, jsonValue(m.Presentation)).Scan(&matches)
		if err != nil {
			return false, errors.New("cannot compare fixture message content")
		}
		if !matches {
			return false, nil
		}
	}
	if plan.Branch != nil {
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_branches WHERE user_id=$1 AND client_request_id=$2 AND destination_conversation_id=$3 AND request_hash=$4 AND result=$5::jsonb)`, c.UserID, namespace+":"+plan.Key, c.ID, plan.Fingerprint, string(encoded(plan.Branch))).Scan(&matches)
		if err != nil {
			return false, errors.New("cannot compare branch fixture")
		}
	}
	return matches, nil
}

func execute(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("dev-cloudchat-fixtures", flag.ContinueOnError)
	user := flags.Int64("user-id", 0, "required existing development account ID")
	apply := flags.Bool("apply", false, "explicitly insert into loopback PostgreSQL; default only prints a plan")
	resourceReceipt := flags.String("space-receipt", "", "optional receipt for existing account-owned resource files")
	receiptPath := flags.String("receipt", "", "required with --apply; durable local receipt preserves later user deletions")
	baseURL := flags.String("base-url", "http://127.0.0.1:52386/", "local Web URL used only in the output receipt")
	profile := flags.String("profile", "core", "core, complete, or reader; reader creates a dedicated acceptance project")
	samplesDir := flags.String("samples-dir", "", "complete profile: directory containing receipt-matched original samples")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *user <= 0 {
		return errors.New("--user-id is required; --apply is opt-in")
	}
	u, err := url.Parse(*baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return errors.New("invalid local Web URL")
	}
	host := u.Hostname()
	if host != "localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback()) {
		return errors.New("web receipt URLs must use loopback")
	}
	refs, err := loadReferences(*resourceReceipt, *user)
	if err != nil {
		return err
	}
	plans, err := buildPlans(*user, refs)
	if err != nil {
		return err
	}
	if *profile != "core" && *profile != "complete" && *profile != "reader" {
		return errors.New("profile must be core, complete or reader")
	}
	if *profile == "complete" {
		extra, buildErr := buildCompleteFixtures(*user, refs, *samplesDir)
		if buildErr != nil {
			return buildErr
		}
		plans = append(plans, extra...)
	}
	if *profile == "reader" {
		plans, refs, err = buildReaderFixtures(*user, refs, *samplesDir)
		if err != nil {
			return err
		}
	}
	statuses := make([]string, len(plans))
	for index := range statuses {
		statuses[index] = "planned"
	}
	if *apply {
		if *receiptPath == "" {
			return errors.New("--apply requires --receipt to preserve future user deletions")
		}
		previous := map[string]bool{}
		if raw, readErr := os.ReadFile(*receiptPath); readErr == nil {
			var saved receipt
			if len(raw) > 2<<20 || json.Unmarshal(raw, &saved) != nil || saved.Format != namespace || saved.UserID != *user || !saved.Applied || saved.ManifestSHA256 != digest(encoded(plans)) {
				return errors.New("existing receipt does not match this fixture plan")
			}
			for _, entry := range saved.Entries {
				previous[entry.ConversationID] = true
			}
		} else if !errors.Is(readErr, os.ErrNotExist) {
			return errors.New("cannot read fixture receipt")
		}
		dsn := os.Getenv("ZEROAGENT_POSTGRES_DSN")
		if dsn == "" {
			dsn = os.Getenv("DATABASE_URL")
		}
		var objects fixtureObjectStore
		if *profile == "complete" || *profile == "reader" {
			store, openErr := openFixtureObjects()
			if openErr != nil {
				return openErr
			}
			defer store.Close()
			objects = store
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		statuses, err = applyPlans(ctx, dsn, *user, plans, refs, previous, objects)
		if err != nil {
			return err
		}
	}
	result := receipt{Format: namespace, UserID: *user, Applied: *apply, ManifestSHA256: digest(encoded(plans)), Entries: []receiptEntry{}}
	for index, plan := range plans {
		link := *u
		query := link.Query()
		query.Set("conversation", plan.Conversation.ID)
		link.RawQuery = query.Encode()
		result.Entries = append(result.Entries, receiptEntry{ProjectID: plan.ProjectID, Key: plan.Key, ConversationID: plan.Conversation.ID, Title: plan.Conversation.Title, MessageCount: len(plan.Messages), FirstMessageID: plan.Messages[0].ID, LastMessageID: plan.Messages[len(plan.Messages)-1].ID, Fingerprint: plan.Fingerprint, Status: statuses[index], URL: link.String(), Resources: extraReceipt(plan)})
	}
	encoder := json.NewEncoder(output)
	if *apply {
		if err = os.WriteFile(*receiptPath, encoded(result), 0600); err != nil {
			return errors.New("fixtures committed but receipt write failed; keep the same plan when reconciling")
		}
	}
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}

func main() {
	if err := execute(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "dev_cloudchat_fixtures:", err)
		os.Exit(1)
	}
}
