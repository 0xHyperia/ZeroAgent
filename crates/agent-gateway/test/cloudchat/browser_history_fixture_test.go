package cloudchat_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/account"
)

const browserHistoryConversationID = "82000000-0000-4000-8000-000000000001"
const browserHistoryBegin = "BEGIN_CLOUDCHAT_SYNTHETIC_LARGE_HISTORY"
const browserHistoryEnd = "END_CLOUDCHAT_SYNTHETIC_LARGE_HISTORY"

type browserHistorySeed struct {
	ConversationID     string `json:"conversation_id"`
	MessageCount       int    `json:"message_count"`
	LargeMessageID     string `json:"large_message_id"`
	LargeContentBytes  int    `json:"large_content_bytes"`
	LargeContentSHA256 string `json:"large_content_sha256"`
}

// This helper is called only from the explicitly enabled test fixture. Every
// record uses the public production store interface; no production route or
// alternate history format exists for seeded data.
func seedBrowserHistory(ctx context.Context, store account.Store, uid int64) (browserHistorySeed, error) {
	seed := browserHistorySeed{ConversationID: browserHistoryConversationID, MessageCount: 132}
	now := time.Now()
	conversation := &account.CloudConversation{ID: seed.ConversationID, UserID: uid, Title: "长历史验收", Model: "gpt-5.1", CreatedAt: now, UpdatedAt: now}
	if err := store.PutCloudConversation(ctx, conversation); err != nil {
		return seed, err
	}
	for index := range seed.MessageCount {
		role := "user"
		if index%2 != 0 {
			role = "assistant"
		}
		text := fmt.Sprintf("合成长历史第 %03d 条。仅用于分页、草稿和滚动位置验收。", index+1)
		// Position 101 belongs to the latest 50-message page, making its honest
		// omitted-body placeholder visible immediately after selecting the chat.
		if index == 100 {
			text = browserHistoryBegin + "\n" + strings.Repeat("0123456789ABCDEFGHIJ\n", 110000) + browserHistoryEnd
		}
		content, err := json.Marshal(text)
		if err != nil {
			return seed, err
		}
		message := &account.CloudMessage{ID: uuid.NewString(), ConversationID: seed.ConversationID, UserID: uid, Role: role, Content: content}
		if err := store.AddCloudMessage(ctx, message); err != nil {
			return seed, err
		}
		if index == 100 {
			digest := sha256.Sum256(content)
			seed.LargeMessageID, seed.LargeContentBytes, seed.LargeContentSHA256 = message.ID, len(content), hex.EncodeToString(digest[:])
		}
	}
	return seed, nil
}

type browserRunPreferencesEvidence struct {
	RunID           string `json:"run_id"`
	ConversationID  string `json:"conversation_id"`
	PublicResearch  bool   `json:"public_research_enabled"`
	ModelParameters struct {
		TimeZone string `json:"time_zone"`
		Locale   string `json:"locale"`
	} `json:"model_parameters"`
}

func browserRunPreferences(ctx context.Context, store *account.MemoryStore, uid int64) ([]browserRunPreferencesEvidence, error) {
	conversations, err := store.ListCloudConversations(ctx, uid)
	if err != nil {
		return nil, err
	}
	result := []browserRunPreferencesEvidence{}
	for _, conversation := range conversations[:min(10, len(conversations))] {
		runs, err := store.ListCloudRunViews(ctx, uid, conversation.ID, false, "")
		if err != nil {
			return nil, err
		}
		for _, run := range runs[:min(5, len(runs))] {
			item := browserRunPreferencesEvidence{RunID: run.ID, ConversationID: conversation.ID, PublicResearch: run.PublicResearch != nil}
			item.ModelParameters.TimeZone, item.ModelParameters.Locale = run.ModelParameters.TimeZone, run.ModelParameters.Locale
			result = append(result, item)
		}
	}
	return result, nil
}

func TestBrowserSyntheticHistorySeed(t *testing.T) {
	ctx := context.Background()
	store := account.NewMemoryStore()
	seed, err := seedBrowserHistory(ctx, store, 700127)
	if err != nil {
		t.Fatal(err)
	}
	service := account.NewService(store, nil, time.Hour, time.Hour)
	conversation, err := store.GetCloudConversation(ctx, 700127, seed.ConversationID)
	if err != nil || conversation.Title != "长历史验收" || seed.LargeContentBytes <= 2<<20 {
		t.Fatal("history seed is not an owned canonical large conversation")
	}
	seen := map[string]bool{}
	before, pages := "", 0
	for {
		page, err := service.CloudHistoryPage(ctx, 700127, seed.ConversationID, before, 50)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		var previous time.Time
		for _, message := range page.Messages {
			if seen[message.ID] || !previous.IsZero() && !message.CreatedAt.After(previous) {
				t.Fatal("history paging duplicated or reordered stable messages")
			}
			seen[message.ID], previous = true, message.CreatedAt
			if message.ID == seed.LargeMessageID {
				if pages != 1 || !message.ContentOmitted || len(message.Content) != 0 || message.ContentBytes != int64(seed.LargeContentBytes) || message.ContentSHA256 != seed.LargeContentSHA256 {
					t.Fatal("large message was cropped or presented as a complete body")
				}
			}
		}
		if !page.HasMore {
			break
		}
		if page.NextBeforeID == "" || page.NextBeforeID == before || pages > 3 {
			t.Fatal("history cursor did not progress")
		}
		before = page.NextBeforeID
	}
	if len(seen) != 132 || pages != 3 {
		t.Fatal("history seed did not cover three genuine pages")
	}
	message, err := service.CloudHistoryMessage(ctx, 700127, seed.ConversationID, seed.LargeMessageID)
	if err != nil || message.ContentOmitted || len(message.Content) != seed.LargeContentBytes {
		t.Fatal("explicit large body read was incomplete")
	}
	var text string
	if json.Unmarshal(message.Content, &text) != nil || !strings.HasPrefix(text, browserHistoryBegin+"\n") || !strings.HasSuffix(text, browserHistoryEnd) {
		t.Fatal("large body BEGIN/END markers were lost")
	}
	if _, err := service.CloudHistoryMessage(ctx, 700128, seed.ConversationID, seed.LargeMessageID); !errors.Is(err, account.ErrNotFound) {
		t.Fatal("large message leaked across fixture accounts")
	}
	preferences, err := browserRunPreferences(ctx, store, 700127)
	if err != nil || len(preferences) != 0 {
		t.Fatal("unexpected initial run preferences")
	}
	status := string(browserJSON(map[string]any{"history": seed, "run_preferences": preferences}))
	for _, denied := range []string{browserHistoryBegin, browserHistoryEnd, "长历史验收", "0123456789ABCDEFGHIJ", "content\"", "cookie", "fixture-app-access-only"} {
		if strings.Contains(status, denied) {
			t.Fatal("fixture status exposed message content or credentials")
		}
	}
}

func TestBrowserRunPreferencesStatusIsOwnedProjection(t *testing.T) {
	ctx := context.Background()
	store := account.NewMemoryStore()
	ids := map[int64]string{}
	for _, uid := range []int64{700127, 700128} {
		conversation := &account.CloudConversation{ID: uuid.NewString(), UserID: uid, Title: "private synthetic title", Model: "gpt-5.1"}
		if err := store.PutCloudConversation(ctx, conversation); err != nil {
			t.Fatal(err)
		}
		run, _, err := store.CreateCloudRun(ctx, &account.CloudRun{ConversationID: conversation.ID, UserID: uid, ClientRequestID: uuid.NewString(), SessionRef: strings.Repeat("a", 64), RequestHash: strings.Repeat("b", 64), Model: "gpt-5.1", RequestContent: browserJSON("private synthetic request content"), ModelParameters: account.CloudRunModelParameters{TimeZone: "Asia/Hong_Kong", Locale: "zh-HK"}})
		if err != nil {
			t.Fatal(err)
		}
		ids[uid] = run.ID
	}
	preferences, err := browserRunPreferences(ctx, store, 700127)
	if err != nil || len(preferences) != 1 || preferences[0].RunID != ids[700127] || preferences[0].ModelParameters.TimeZone != "Asia/Hong_Kong" || preferences[0].ModelParameters.Locale != "zh-HK" {
		t.Fatal("fixture run preferences did not match owned canonical metadata")
	}
	status := string(browserJSON(preferences))
	for _, denied := range []string{ids[700128], "private synthetic", strings.Repeat("a", 64), strings.Repeat("b", 64), "request_content", "session_ref", "provider_key_id"} {
		if strings.Contains(status, denied) {
			t.Fatal("fixture preference evidence exposed private or foreign fields")
		}
	}
}
