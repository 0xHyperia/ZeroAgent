package account

import (
	"context"
	"strings"
	"testing"
)

func TestCloudRunContextUsesExplicitFreshMemoryAndProjectSources(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	ctx := context.Background()
	project, err := f.store.CreateCloudProject(ctx, &CloudProject{UserID: 1, Name: "财务分析", Instructions: "金额使用人民币，区分事实与假设"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.SetCloudConversationProject(ctx, 1, f.conversation.ID, project.ID, 0); err != nil {
		t.Fatal(err)
	}
	file := f.upload(t, "项目账本.csv", []byte("项目,收入,成本\nA,10,6\nB,20,8"))
	if _, err = f.store.SetCloudProjectFile(ctx, 1, project.ID, file.ID, project.Version, true); err != nil {
		t.Fatal(err)
	}
	memory, err := f.store.CreateCloudMemory(ctx, &CloudMemory{UserID: 1, Content: "回答先给结论再列依据", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	messages := []CloudMessage{{ConversationID: f.conversation.ID, Role: "user", Content: cloudJSON("计算毛利")}}
	model, provenance, code := f.service.prepareCloudContext(ctx, 1, f.conversation.ID, messages)
	encoded := string(cloudJSON(model))
	if code != "" || !strings.Contains(encoded, "区分事实与假设") || !strings.Contains(encoded, "L2: A,10,6") {
		t.Fatalf("project context code=%s", code)
	}
	if strings.Contains(encoded, memory.Content) || len(provenance.Memories) != 0 {
		t.Fatal("default-disabled memory entered model context")
	}
	if provenance.Project == nil || provenance.Project.Version != 2 || len(provenance.Files) != 1 || !provenance.Files[0].Included || provenance.Files[0].SHA256 != file.SHA256 {
		t.Fatal("context provenance does not match sources")
	}
	if _, err = f.store.SetCloudMemorySettings(ctx, 1, 0, true); err != nil {
		t.Fatal(err)
	}
	model, provenance, code = f.service.prepareCloudContext(ctx, 1, f.conversation.ID, messages)
	if code != "" || !strings.Contains(string(cloudJSON(model)), memory.Content) || len(provenance.Memories) != 1 || provenance.Memories[0].ID != memory.ID {
		t.Fatal("explicit enabled memory missing")
	}
	if err = f.store.DeleteCloudMemory(ctx, 1, memory.ID, memory.Version); err != nil {
		t.Fatal(err)
	}
	model, provenance, code = f.service.prepareCloudContext(ctx, 1, f.conversation.ID, messages)
	if code != "" || strings.Contains(string(cloudJSON(model)), memory.Content) || len(provenance.Memories) != 0 {
		t.Fatal("deleted memory survived in a new invocation")
	}
	if _, _, code = f.service.prepareCloudContext(ctx, 2, f.conversation.ID, messages); code != "project_context_unavailable" {
		t.Fatal("foreign project context accepted")
	}
	original, _ := f.store.ListCloudMessages(ctx, 1, f.conversation.ID)
	if len(original) != 0 {
		t.Fatal("synthetic context mutated canonical conversation")
	}
}
