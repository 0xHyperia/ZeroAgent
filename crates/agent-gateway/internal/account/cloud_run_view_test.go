package account

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func runCloudRunViewContract(t *testing.T, fixture cloudRunTestFixture) {
	t.Helper()
	ctx := context.Background()
	store := fixture.store.(cloudRunViewStore)
	input := cloudRunTestInput(t, fixture, 81, "", "view-large-request", strings.Repeat("x", 2<<20))
	run, _, err := fixture.runs.CreateCloudRun(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	fixture.setOutput(run.ID, strings.Repeat("y", 1<<20))
	head, err := store.GetCloudRunHead(ctx, 81, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Output != "" || len(head.RequestContent) != 0 || head.SessionRef != "" || head.RequestHash != "" || head.LeaseOwner != "" {
		t.Fatal("poll head loaded private or accumulated bodies")
	}
	view, err := store.GetCloudRunView(ctx, 81, run.ID)
	if err != nil || len(view.Output) != (1<<20) || len(view.RequestContent) != 0 {
		t.Fatal("attach view lost public output or loaded private input")
	}
	original, err := fixture.runs.GetCloudRun(ctx, 81, run.ID)
	if err != nil || len(original.RequestContent) < 2<<20 {
		t.Fatal("projection changed stored request")
	}
	list, err := store.ListCloudRunViews(ctx, 81, run.ConversationID, false, "")
	if err != nil || len(list) != 1 || list[0].Output != "" || len(list[0].RequestContent) != 0 {
		t.Fatal("history listing loaded bodies")
	}
	matched, err := store.ListCloudRunViews(ctx, 81, run.ConversationID, false, run.ClientRequestID)
	if err != nil || len(matched) != 1 || len(matched[0].Output) != (1<<20) {
		t.Fatal("request lookup did not return authoritative matching snapshot")
	}
	if _, err = store.GetCloudRunHead(ctx, 82, run.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign poll head accepted")
	}
	claimed, err := fixture.runs.ClaimCloudRun(ctx, "viewer-contract", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	tools := fixture.store.(CloudToolStore)
	op, _, err := tools.PrepareCloudTool(ctx, 81, run.ID, "viewer-contract", claimed.Attempt, &CloudToolOperation{CallKey: "round:0:0", Name: "execute_code", Input: cloudJSON(map[string]any{"code": "private-source-not-public"})})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = tools.PrepareCloudTool(ctx, 81, run.ID, "viewer-contract", claimed.Attempt, &CloudToolOperation{CallKey: "internal:create", Name: "sandbox.create", Input: cloudJSON(map[string]any{})}); err != nil {
		t.Fatal(err)
	}
	active, err := store.ListCloudRunActiveTools(ctx, 81, run.ID)
	if err != nil || len(active) != 1 || active[0].ID != op.ID || active[0].Name != "execute_code" || active[0].Status == "" {
		t.Fatal("active tool projection lost progress or exposed internal operation")
	}
	encoded := string(cloudJSON(active))
	if strings.Contains(encoded, "private-source-not-public") || strings.Contains(encoded, "sandbox.create") {
		t.Fatal("active progress exposed private tool data")
	}
}

func TestCloudRunViewMemoryContract(t *testing.T) {
	runCloudRunViewContract(t, cloudRunMemoryFixture(t))
}
func TestCloudRunViewPostgresContract(t *testing.T) {
	fixture := cloudRunPostgresFixture(t)
	if _, err := fixture.store.(*PersistentStore).db.Exec(CloudToolSchema); err != nil {
		t.Fatal(err)
	}
	runCloudRunViewContract(t, fixture)
}
