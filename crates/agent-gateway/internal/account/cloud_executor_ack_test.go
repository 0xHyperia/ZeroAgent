package account

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

type cloudParserRejectTerminalCheckpoint struct {
	CloudFileStore
	CloudAllocationStore
}

func (s cloudParserRejectTerminalCheckpoint) UpdateCloudFile(ctx context.Context, userID int64, id string, version int64, update CloudFileUpdate) (*CloudFile, error) {
	if update.ParseTask != nil {
		for _, operation := range update.ParseTask.Operations {
			if operation.Receipt.Action == "file.upload.chunk" && operation.Receipt.State == cloudexecutor.StateSucceeded {
				return nil, ErrCloudFileBusy
			}
		}
	}
	return s.CloudFileStore.UpdateCloudFile(ctx, userID, id, version, update)
}

func TestCloudFileParserNeverAcknowledgesUncommittedTerminalReceipt(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	file := f.upload(t, "checkpoint.pdf", []byte("%PDF-1.7\nsynthetic"))
	p, stub := parserForFixture(t, f, "success")
	p.provider = &cloudFileService{metadata: cloudParserRejectTerminalCheckpoint{CloudFileStore: f.store, CloudAllocationStore: f.store}, objects: f.objects}
	if err := p.process(context.Background(), 1, file.ID); err == nil {
		t.Fatal("rejected checkpoint was ignored")
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	for id, receipt := range stub.ops {
		if receipt.Action == "file.upload.chunk" && stub.acked[id] {
			t.Fatal("remote result retired before local terminal fact was durable")
		}
	}
}

func TestCloudArtifactAcknowledgementFollowsDurableStatAndStepFacts(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	pub, sdk := artifactPublicationFixture(t, f)
	sdk.ackCheck = func(id string) {
		version, err := f.store.GetCloudArtifactByOperation(context.Background(), 1, pub.ToolOperationID)
		if err != nil || version.Size <= 0 || version.SHA256 == "" {
			t.Error("artifact ACK preceded durable source size/SHA")
			return
		}
		if id == parserOperationID(pub.ToolOperationID, "artifact-stat") {
			return
		}
		var journal cloudArtifactJournal
		if json.Unmarshal(version.Journal, &journal) != nil {
			t.Error("invalid durable artifact journal")
			return
		}
		fact, exists := journal.Operations[id]
		if !exists || fact.State != cloudexecutor.StateSucceeded || strings.Contains(string(fact.Result), "data_base64") {
			t.Error("artifact ACK preceded durable terminal metadata or retained file bytes")
		}
	}
	if _, err := f.service.PublishCloudArtifact(context.Background(), 1, pub); err != nil {
		t.Fatal(err)
	}
	sdk.mu.Lock()
	defer sdk.mu.Unlock()
	if sdk.acked != 2 {
		t.Fatalf("expected stat+single download ACK, got %d", sdk.acked)
	}
}
