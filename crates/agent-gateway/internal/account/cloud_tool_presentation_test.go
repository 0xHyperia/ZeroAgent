package account

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestCloudToolPresentationMemoryContract(t *testing.T) {
	runCloudToolPresentationContract(t, memoryCloudToolFixture)
}
func TestCloudToolPresentationPostgresContract(t *testing.T) {
	runCloudToolPresentationContract(t, postgresCloudToolFixture)
}

func runCloudToolPresentationContract(t *testing.T, factory func(*testing.T) cloudToolFixture) {
	t.Run("publication receipt gap retains real site without inventing execution success", func(t *testing.T) {
		f := factory(t)
		ctx := context.Background()
		run := toolRunningRun(t, f, 7, "")
		op := researchOperation(t, f, run, "publish_site", "round:0:call:0", true)
		artifacts := f.store.(CloudArtifactStore)
		input := artifactContractVersion(run)
		input.ToolOperationID = op.ID
		artifact, _, err := artifacts.ReserveCloudArtifact(ctx, run.UserID, run.LeaseOwner, run.Attempt, input)
		if err != nil {
			t.Fatal(err)
		}
		artifact, err = artifacts.UpdateCloudArtifact(ctx, run.UserID, artifact.ID, artifact.Version, run.LeaseOwner, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
		if err != nil {
			t.Fatal(err)
		}
		_, manifest := siteTestZIP(t, "output gap")
		if _, err = f.store.(CloudSiteStore).PutCloudSiteRelease(ctx, run.UserID, artifact.ID, manifest); err != nil {
			t.Fatal(err)
		}
		// No CommitCloudTool or explicit progress event: simulate a crash after
		// ready publication. Reconciliation must use canonical owned facts.
		f.expire(run.ID)
		if _, err = f.runs.InterruptExpiredCloudRuns(ctx); err != nil {
			t.Fatal(err)
		}
		messages, err := f.store.ListCloudMessages(ctx, run.UserID, run.ConversationID)
		if err != nil || len(messages) != 2 {
			t.Fatal("published output lost at recovery")
		}
		var presentation CloudPresentation
		if json.Unmarshal(messages[1].Presentation, &presentation) != nil || len(presentation.Blocks) != 1 {
			t.Fatal("missing recovered tool")
		}
		block := presentation.Blocks[0]
		if block.State != CloudToolUnknown || len(block.Resources) != 1 || block.Resources[0].Kind != "site" || block.Resources[0].ID != artifact.ID {
			t.Fatal("recovery lost actual output or invented success")
		}
		events, err := f.runs.ListCloudRunEvents(ctx, run.UserID, run.ID, 0, 100)
		if err != nil {
			t.Fatal(err)
		}
		var recovered struct {
			State string `json:"state"`
		}
		if len(events) < 2 || json.Unmarshal(events[len(events)-2].Payload, &recovered) != nil || events[len(events)-2].Type != "tool.unknown" || recovered.State != CloudToolUnknown || events[len(events)-1].Type != "run.interrupted" {
			t.Fatal("live recovery cannot match canonical history")
		}
	})
	t.Run("durable result without final model citation survives interrupt and fork", func(t *testing.T) {
		f := factory(t)
		ctx := context.Background()
		run := toolRunningRun(t, f, 7, "")
		op := researchOperation(t, f, run, "publish_artifact", "round:0:call:0", true)
		artifacts := f.store.(CloudArtifactStore)
		input := artifactContractVersion(run)
		input.ToolOperationID = op.ID
		artifact, _, err := artifacts.ReserveCloudArtifact(ctx, run.UserID, run.LeaseOwner, run.Attempt, input)
		if err != nil {
			t.Fatal(err)
		}
		artifact, err = artifacts.UpdateCloudArtifact(ctx, run.UserID, artifact.ID, artifact.Version, run.LeaseOwner, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
		if err != nil {
			t.Fatal(err)
		}
		// Raw private result deliberately supplies a different identity and URL.
		// Public identity must instead come from the committed artifact operation.
		private := cloudJSON(map[string]any{"artifact": map[string]any{"id": uuid.NewString(), "name": "forged-result-name", "download_url": "https://private-result.invalid/raw"}, "stdout": "private-stdout"})
		if _, err = f.tools.CommitCloudTool(ctx, run.UserID, op.ID, run.LeaseOwner, run.Attempt, CloudToolSucceeded, private, ""); err != nil {
			t.Fatal(err)
		}
		current, err := f.runs.GetCloudRun(ctx, run.UserID, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		var presentation CloudPresentation
		if json.Unmarshal(current.Presentation, &presentation) != nil || len(presentation.Blocks) != 1 {
			t.Fatal("tool result not atomically projected")
		}
		block := presentation.Blocks[0]
		if block.State != CloudToolSucceeded || block.CompletedAt == nil || len(block.Resources) != 1 || block.Resources[0].ID != artifact.ID || block.Resources[0].FamilyID != artifact.FamilyID || block.Resources[0].Version != 1 || block.Resources[0].Name != "report.csv" || block.Resources[0].Role != "output" {
			t.Fatalf("invalid output facts: %+v", block)
		}
		events, err := f.runs.ListCloudRunEvents(ctx, run.UserID, run.ID, 0, 100)
		if err != nil || events[len(events)-1].Type != "tool.completed" || !strings.Contains(string(events[len(events)-1].Payload), artifact.ID) {
			t.Fatal("terminal tool result is not replayable")
		}
		for _, privateValue := range []string{"forged-result-name", "private-result.invalid", "private-stdout", "download_url"} {
			if strings.Contains(string(current.Presentation)+string(cloudJSON(events)), privateValue) {
				t.Fatal("raw result entered public projection")
			}
		}
		if _, err = f.tools.CommitCloudTool(ctx, run.UserID, op.ID, run.LeaseOwner, run.Attempt, CloudToolSucceeded, private, ""); err != nil {
			t.Fatal(err)
		}
		replayed, _ := f.runs.GetCloudRun(ctx, run.UserID, run.ID)
		if replayed.LastSeq != current.LastSeq {
			t.Fatal("uncertain tool commit appended twice")
		}
		f.expire(run.ID)
		if _, err = f.runs.InterruptExpiredCloudRuns(ctx); err != nil {
			t.Fatal(err)
		}
		messages, err := f.store.ListCloudMessages(ctx, run.UserID, run.ConversationID)
		if err != nil || len(messages) != 2 || !strings.Contains(string(messages[1].Presentation), artifact.ID) || string(messages[1].Content) != `""` {
			t.Fatal("tool-only partial lost durable result")
		}
		if persistent, ok := f.store.(*PersistentStore); ok {
			if _, err = persistent.db.Exec(CloudProjectSchema + CloudBranchSchema); err != nil {
				t.Fatal(err)
			}
		}
		branch, _, err := f.store.(CloudBranchStore).CreateCloudBranch(ctx, run.UserID, run.ConversationID, CloudBranchInput{ClientRequestID: "resource-fork", MessageID: run.AssistantMessageID, Action: "fork"})
		if err != nil {
			t.Fatal(err)
		}
		clones, err := f.store.ListCloudMessages(ctx, run.UserID, branch.Conversation.ID)
		if err != nil || len(clones) != 2 || string(clones[1].Presentation) != string(messages[1].Presentation) {
			t.Fatal("fork changed immutable resource references")
		}
		var markdown strings.Builder
		writeCloudPresentationMarkdown(&markdown, messages[1].Presentation)
		if !strings.Contains(markdown.String(), artifact.ID) || !strings.Contains(markdown.String(), "report.csv") {
			t.Fatal("export lost resource identities")
		}
	})
	t.Run("unknown resolution preserves success while cancellation is pending", func(t *testing.T) {
		f := factory(t)
		ctx := context.Background()
		run := toolRunningRun(t, f, 7, "")
		op := researchOperation(t, f, run, "execute_code", "round:1:call:0", true)
		if _, err := f.tools.CommitCloudTool(ctx, run.UserID, op.ID, run.LeaseOwner, run.Attempt, CloudToolUnknown, nil, "outcome_unknown"); err != nil {
			t.Fatal(err)
		}
		if _, err := f.runs.CancelCloudRun(ctx, run.UserID, run.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := f.tools.CommitCloudTool(ctx, run.UserID, op.ID, run.LeaseOwner, run.Attempt, CloudToolSucceeded, json.RawMessage(`{"stdout":"private"}`), ""); err != nil {
			t.Fatal(err)
		}
		if _, err := f.runs.CommitCloudRun(ctx, run.UserID, run.ID, run.LeaseOwner, run.Attempt, CloudRunCommit{OperationID: "cancelled", State: CloudRunCancelled}); err != nil {
			t.Fatal(err)
		}
		final, _ := f.runs.GetCloudRun(ctx, run.UserID, run.ID)
		var presentation CloudPresentation
		if json.Unmarshal(final.Presentation, &presentation) != nil || presentation.Blocks[0].State != CloudToolSucceeded || presentation.State != CloudRunCancelled {
			t.Fatal("cancel request rewrote external success")
		}
	})
}

func TestCloudToolPresentationRejectsForgedReferences(t *testing.T) {
	run := &CloudRun{Model: "synthetic"}
	commit := CloudRunCommit{EventType: "tool.completed", Payload: cloudJSON(map[string]any{"round": 0, "name": "publish_site", "tool_id": uuid.NewString(), "resources": []CloudPresentationResource{{Kind: "site", ID: uuid.NewString(), Name: "forged", Role: "output"}}})}
	if err := applyCloudPresentation(run, &commit, run.CreatedAt); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(run.Presentation)+string(commit.Payload), "forged") {
		t.Fatal("event JSON forged canonical resource authority")
	}
	store := NewMemoryStore()
	op := &CloudToolOperation{UserID: 1, RunID: uuid.NewString(), ID: uuid.NewString(), Name: "publish_artifact", State: CloudToolSucceeded}
	foreign := CloudArtifactVersion{ID: uuid.NewString(), ToolOperationID: op.ID, UserID: 2, SourceRunID: op.RunID, State: CloudArtifactReady}
	store.artifactState().versions[foreign.ID] = foreign
	store.artifactState().operations[op.ID] = foreign.ID
	if len(store.cloudToolResourcesLocked(op)) != 0 {
		t.Fatal("foreign owner became public reference")
	}
	foreign.UserID, foreign.SourceRunID = 1, uuid.NewString()
	store.artifactState().versions[foreign.ID] = foreign
	if len(store.cloudToolResourcesLocked(op)) != 0 {
		t.Fatal("foreign run became output reference")
	}
}
