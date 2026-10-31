package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestFixturePlanIsDeterministicAccountScopedAndTerminal(t *testing.T) {
	first, err := buildPlans(1, nil)
	if err != nil {
		t.Fatal(err)
	}
	again, err := buildPlans(1, nil)
	if err != nil {
		t.Fatal(err)
	}
	other, err := buildPlans(2, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) <= 50 || digest(encoded(first)) != digest(encoded(again)) || first[0].Conversation.ID == other[0].Conversation.ID {
		t.Fatal("plan must be repeatable and account scoped")
	}
	seen := map[string]bool{}
	states := map[string]bool{}
	longHistory, longAnswer, longProcess, branch, pinned, archived := false, false, false, false, false, false
	for _, plan := range first {
		if !strings.Contains(plan.Conversation.Title, "合成验收数据") || plan.Fingerprint == "" || seen[plan.Conversation.ID] {
			t.Fatal("fixture identity is missing or duplicated")
		}
		seen[plan.Conversation.ID] = true
		longHistory = longHistory || len(plan.Messages) > 50
		branch = branch || plan.Branch != nil
		pinned = pinned || plan.Conversation.Pinned
		archived = archived || plan.Conversation.Archived
		for _, message := range plan.Messages {
			if message.UserID != 1 || message.ConversationID != plan.Conversation.ID || seen[message.ID] {
				t.Fatal("message scope or identity mismatch")
			}
			seen[message.ID] = true
			longAnswer = longAnswer || len(message.Content) > 2<<20
			if message.Role != "assistant" {
				continue
			}
			var p struct {
				State  string `json:"state"`
				Blocks []struct{ Type, Text string }
			}
			if json.Unmarshal(message.Presentation, &p) != nil || !terminal(p.State) {
				t.Fatal("fixture is not terminal")
			}
			states[p.State] = true
			longProcess = longProcess || len(message.Presentation) > 2<<20
			for _, block := range p.Blocks {
				if block.Type == "reasoning" && len(block.Text) > 1<<20 {
					t.Fatal("reasoning exceeds limit")
				}
			}
		}
	}
	if len(states) != 4 || !longHistory || !longAnswer || !longProcess || !branch || !pinned || !archived {
		t.Fatal("acceptance coverage is incomplete")
	}
}

func TestDevelopmentDSNRejectsRemoteOrOverrideAddresses(t *testing.T) {
	for _, raw := range []string{"postgres://u:p@127.0.0.1:5433/dev?sslmode=disable", "postgresql://u:p@[::1]:5433/dev", "postgres://u:p@localhost/dev"} {
		if _, err := loopbackDSN(raw); err != nil {
			t.Errorf("local URL rejected: %v", err)
		}
	}
	for _, raw := range []string{"", "host=127.0.0.1 dbname=dev", "postgres://u:p@172.16.0.121/dev", "postgres://u:p@localhost.example/dev", "postgres://u:p@127.0.0.1/dev?host=remote", "postgres://u:p@127.0.0.1/dev?hostaddr=1.2.3.4", "postgres://u:p@127.0.0.1/dev?service=prod", "postgres://u:p@127.0.0.1/dev?options=-csearch_path%3Dother", "postgres://u:p@127.0.0.1/dev?sslmode=disable&sslmode=require"} {
		if _, err := loopbackDSN(raw); err == nil {
			t.Fatal("unsafe database target accepted")
		}
	}
}

func TestDefaultCommandOnlyPrintsPlanWithoutDatabase(t *testing.T) {
	t.Setenv("ZEROAGENT_POSTGRES_DSN", "not-a-database")
	t.Setenv("DATABASE_URL", "not-a-database")
	var output bytes.Buffer
	if err := execute([]string{"--user-id", "1"}, &output); err != nil {
		t.Fatal(err)
	}
	var r receipt
	if json.Unmarshal(output.Bytes(), &r) != nil || r.Applied || len(r.Entries) <= 50 {
		t.Fatal("default command must only produce a manifest")
	}
	for _, entry := range r.Entries {
		if entry.Status != "planned" {
			t.Fatal("non-plan mutation in default command")
		}
	}
	if err := execute([]string{"--user-id", "1", "--apply"}, &bytes.Buffer{}); err == nil {
		t.Fatal("apply without a durable receipt must be rejected")
	}
}
