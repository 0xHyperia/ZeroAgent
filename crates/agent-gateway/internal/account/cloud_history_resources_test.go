package account

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCloudHistoryResourcesMemoryContract(t *testing.T)   { testCloudHistoryResources(t, false) }
func TestCloudHistoryResourcesPostgresContract(t *testing.T) { testCloudHistoryResources(t, true) }

func testCloudHistoryResources(t *testing.T, postgres bool) {
	f := researchFixture(t, postgres)
	if persistent, ok := f.store.(*PersistentStore); ok {
		if _, err := persistent.db.Exec(CloudMemorySchema); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	run := toolRunningRun(t, f, 7, "")
	op := researchOperation(t, f, run, "publish_artifact", "round:0:call:0", true)
	artifacts := f.store.(CloudArtifactStore)
	input := artifactContractVersion(run)
	input.ToolOperationID = op.ID
	artifact, _, err := artifacts.ReserveCloudArtifact(ctx, 7, run.LeaseOwner, run.Attempt, input)
	if err != nil {
		t.Fatal(err)
	}
	artifact, err = artifacts.UpdateCloudArtifact(ctx, 7, artifact.ID, artifact.Version, run.LeaseOwner, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.tools.CommitCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt, CloudToolSucceeded, cloudJSON(map[string]string{"private": "private-tool-output"}), ""); err != nil {
		t.Fatal(err)
	}
	sourceOp := researchOperation(t, f, run, "fetch_page", "round:1:call:0", true)
	sources := f.store.(CloudResearchSourceStore)
	published, err := sources.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, sourceOp.ID, []CloudResearchSourceInput{researchPage()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.tools.CommitCloudTool(ctx, 7, sourceOp.ID, run.LeaseOwner, run.Attempt, CloudToolSucceeded, cloudJSON(map[string]string{"private": "private-source-output"}), ""); err != nil {
		t.Fatal(err)
	}
	if _, err = f.runs.CommitCloudRun(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, CloudRunCommit{OperationID: "private-display", EventType: "reasoning.delta", Payload: cloudJSON(map[string]any{"round": 2, "delta": "private-display-reasoning"})}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.runs.CommitCloudRun(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, CloudRunCommit{OperationID: "done-without-citation", State: CloudRunInterrupted}); err != nil {
		t.Fatal(err)
	}
	next := toolRunningRun(t, f, 7, run.ConversationID)
	service := NewService(f.store, nil, time.Hour, time.Hour)
	messages, _, err := service.cloudModelHistory(ctx, next, CloudRunModelParameters{})
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range messages {
		if len(message.Presentation) > 0 {
			t.Fatal("display data entered model history")
		}
	}
	model, provenance, code := service.prepareCloudContext(ctx, 7, next.ConversationID, messages)
	encoded := string(cloudJSON(model))
	if code != "" || !strings.Contains(encoded, artifact.ID) || !strings.Contains(encoded, artifact.FamilyID) || !strings.Contains(encoded, published[0].ID) {
		t.Fatalf("tool-only historical resources missing: %s", code)
	}
	for _, secret := range []string{"private-display-reasoning", "private-tool-output", "private-source-output", published[0].URL, published[0].FinalURL, published[0].Text} {
		if strings.Contains(encoded, secret) {
			t.Fatal("historical resource metadata exposed body/reasoning/raw tool result/URL")
		}
	}
	resourceStore := f.store.(cloudHistoryResourceStore)
	if _, err = resourceStore.GetCloudHistoryResources(ctx, 8, run.ConversationID, []string{run.AssistantMessageID}); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign resource context accepted")
	}
	other := historyConversation(t, f.cloudRunTestFixture, 7)
	if _, err = resourceStore.GetCloudHistoryResources(ctx, 7, other, []string{run.AssistantMessageID}); !errors.Is(err, ErrNotFound) {
		t.Fatal("resource selection crossed conversation")
	}
	// The resource-only projection survives body page omission without copying
	// any of the omitted presentation into the model context.
	bounded, err := f.store.(CloudHistoryStore).GetCloudHistoryMessages(ctx, 7, run.ConversationID, []string{run.AssistantMessageID}, 2)
	if err != nil || len(bounded) != 1 || !bounded[0].PresentationOmitted {
		t.Fatal("fixture did not omit display projection")
	}
	rows, err := resourceStore.GetCloudHistoryResources(ctx, 7, run.ConversationID, []string{run.AssistantMessageID})
	if err != nil || len(rows.Items) != 1 || len(rows.Items[0].Resources) != 2 {
		t.Fatal("bounded history lost canonical result identities")
	}
	execution := &cloudRunToolExecution{runtime: &cloudRunRuntime{service: service, store: f.runs}, run: next}
	if execution.historySourceAllowed(ctx, published[0].ID) {
		t.Fatal("guessed historical ID was permitted before selection")
	}
	execution.rememberHistoryResources(provenance.historyResources)
	if !execution.historySourceAllowed(ctx, published[0].ID) {
		t.Fatal("selected same-conversation source cannot be reread")
	}
	// A receipt is reprojected from current rows, never trusted as retained
	// access. The index path deliberately does not acquire source permissions.
	index := map[string]any{"history": []any{map[string]any{"message_id": run.AssistantMessageID, "body_provided": false, "resources": []any{"stale"}}}}
	if err = execution.refreshHistoryResources(ctx, index); err != nil || strings.Contains(string(cloudJSON(index)), "resources") {
		t.Fatal("metadata-only index leaked resource data")
	}
	row := map[string]any{"message_id": run.AssistantMessageID, "body_provided": true}
	read := map[string]any{"history": []any{row}}
	if err = execution.refreshHistoryResources(ctx, read); err != nil || !strings.Contains(string(cloudJSON(read)), artifact.ID) {
		t.Fatal("read_history body selection lost results")
	}
	if _, err = artifacts.DeleteCloudArtifactFamily(ctx, 7, artifact.FamilyID); err != nil {
		t.Fatal(err)
	}
	if err = sources.DeleteCloudResearchSource(ctx, 7, published[0].ID, published[0].Version); err != nil {
		t.Fatal(err)
	}
	if err = execution.refreshHistoryResources(ctx, read); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(cloudJSON(read)), artifact.ID) || strings.Contains(string(cloudJSON(read)), published[0].ID) || execution.historySourceAllowed(ctx, published[0].ID) {
		t.Fatal("deleted resources revived from an old receipt")
	}
}

func TestCloudHistoryResourcesTotalBudget(t *testing.T) {
	items := []cloudHistoryResourceCandidate{}
	for range cloudHistoryResourceCandidates {
		items = append(items, cloudHistoryResourceCandidate{uuid.NewString(), "artifact", uuid.NewString()})
	}
	result, err := collectCloudHistoryResources(items, false, func(c cloudHistoryResourceCandidate) (*CloudPresentationResource, error) {
		value := cloudCanonicalResource("artifact", c.id, strings.Repeat("文", 240), "text/plain", uuid.NewString(), 1, "output")
		return &value, nil
	})
	if err != nil || !result.Truncated || len(result.Items) > cloudHistoryResourceCount || len(cloudJSON(result)) > cloudHistoryResourceBytes {
		t.Fatal("historical resource context is not bounded")
	}
}

func TestCloudHistoricalSourceReadRequiresSelectedPrivatePrefix(t *testing.T) {
	f, peer, e := newCloudResearchScopeFixture(t, &CloudRunPublicResearch{Topic: "public topic only"})
	ctx := context.Background()
	// Terminal historical fixtures are inert, and neither test path requests a
	// model or research network operation.
	source := CloudResearchSource{ID: uuid.NewString(), UserID: 1, RunID: uuid.NewString(), ConversationID: e.run.ConversationID, Kind: CloudResearchPage, Title: "历史来源", Text: "historical evidence", LineCount: 1, Version: 1}
	message := CloudMessage{ID: uuid.NewString(), UserID: 1, ConversationID: e.run.ConversationID, Role: "assistant", Content: cloudJSON(""), CreatedAt: e.run.CreatedAt.Add(-time.Hour), Presentation: cloudJSON(CloudPresentation{Version: 1, Blocks: []CloudPresentationBlock{{ID: "tool:" + uuid.NewString(), Type: "tool", Resources: []CloudPresentationResource{cloudCanonicalResource("source", source.ID, source.Title, "text/plain", "", 1, "source")}}}})}
	f.store.mu.Lock()
	f.store.cloudResearchSourceStateLocked().sources[source.ID] = source
	f.store.cloudMessages[e.run.ConversationID] = append(f.store.cloudMessages[e.run.ConversationID], message)
	f.store.mu.Unlock()
	selection, err := f.store.GetCloudHistoryResources(ctx, 1, e.run.ConversationID, []string{message.ID})
	if err != nil {
		t.Fatal(err)
	}
	e.rememberHistoryResources(selection)
	public, err := e.beginPublicResearch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.executeResearch(public, 0, cloudModelToolCall{Index: 0, ID: "denied-old", Name: "read_source", Arguments: string(cloudJSON(map[string]string{"source_id": source.ID}))}); err == nil {
		t.Fatal("public research read a selected private historical source")
	}
	e.endPublicResearch()
	result, err := e.executeResearch(ctx, 1, cloudModelToolCall{Index: 0, ID: "read-old", Name: "read_source", Arguments: string(cloudJSON(map[string]string{"source_id": source.ID}))})
	if err != nil || !strings.Contains(string(result), source.Text) {
		t.Fatal("private synthesis cannot read its selected historical source")
	}
	if peer.searches.Load() != 0 || peer.pages.Load() != 0 {
		t.Fatal("local historical read performed a network request")
	}
	// Unselecting the owning canonical message invalidates even cached source
	// outputs before the next model round.
	f.store.mu.Lock()
	kept := []CloudMessage{}
	for _, m := range f.store.cloudMessages[e.run.ConversationID] {
		if m.ID != message.ID {
			kept = append(kept, m)
		}
	}
	f.store.cloudMessages[e.run.ConversationID] = kept
	f.store.mu.Unlock()
	prior, err := e.pruneResearchPrior(ctx, []map[string]any{{"role": "tool", "content": string(result)}})
	if err != nil || strings.Contains(string(cloudJSON(prior)), source.Text) || e.historySourceAllowed(ctx, source.ID) {
		t.Fatal("removed canonical selection retained source access")
	}
	var decoded any
	if json.Unmarshal(result, &decoded) != nil {
		t.Fatal("invalid source result")
	}
}
