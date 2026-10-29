package cloudexecutor

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func archiveSpec() ArchiveExtractSpec {
	return ArchiveExtractSpec{Scope: testOperation().Scope(), OperationID: "extract-one", SandboxID: "sandbox-one", Path: "uploads/code-task.zip", Destination: "source", SourceSHA256: strings.Repeat("a", 64)}
}

func archiveResult() ArchiveExtractResult {
	return ArchiveExtractResult{SandboxID: "sandbox-one", SourceSHA256: strings.Repeat("a", 64), Destination: "source", Files: []ArchiveFile{{Path: "source/main.py", Size: 10, SHA256: strings.Repeat("b", 64)}}, FileCount: 1, TotalBytes: 10}
}

func TestExtractArchiveStrictScopedProtocolAndManifest(t *testing.T) {
	for _, variant := range []string{"valid", "foreign-sandbox", "wrong-sha", "escape", "duplicate", "oversized-file", "wrong-total", "nil-files", "too-many"} {
		t.Run(variant, func(t *testing.T) {
			client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
				var operation Operation
				if json.NewDecoder(r.Body).Decode(&operation) != nil || operation.Action != "archive.extract" || operation.OperationID != "extract-one" || operation.OwnerScope != "account-one" || operation.WorkspaceRef != "workspace-one" || operation.SandboxID != "sandbox-one" || len(operation.Input) != 3 || operation.Input["path"] != "uploads/code-task.zip" || operation.Input["source_sha256"] != strings.Repeat("a", 64) {
					t.Error("archive scope/request lost")
				}
				result := archiveResult()
				switch variant {
				case "foreign-sandbox":
					result.SandboxID = "foreign"
				case "wrong-sha":
					result.SourceSHA256 = strings.Repeat("c", 64)
				case "escape":
					result.Files[0].Path = "source/../outside"
				case "duplicate":
					result.Files = append(result.Files, result.Files[0])
					result.FileCount = 2
					result.TotalBytes = 20
				case "oversized-file":
					result.Files[0].Size = MaxArchiveFileBytes + 1
					result.TotalBytes = result.Files[0].Size
				case "wrong-total":
					result.TotalBytes = 11
				case "nil-files":
					result.Files = nil
					result.FileCount = 0
					result.TotalBytes = 0
				case "too-many":
					result.Files = make([]ArchiveFile, MaxArchiveEntries+1)
					result.FileCount = len(result.Files)
				}
				transferResponse(t, w, operation, result)
			})
			result, receipt, err := client.ExtractArchive(context.Background(), archiveSpec())
			if variant == "valid" {
				if err != nil || result.FileCount != 1 || receipt.State != StateSucceeded {
					t.Fatalf("result=%+v err=%v", result, err)
				}
				return
			}
			var api *APIError
			if !errors.As(err, &api) || api.Code != "invalid_receipt" || !api.MayHaveExecuted {
				t.Fatalf("invalid result accepted: %v", err)
			}
		})
	}
}

func TestExtractArchiveRejectsInvalidBeforeTransportAndPreservesUnknownID(t *testing.T) {
	calls := 0
	client := clientFor(t, func(http.ResponseWriter, *http.Request) { calls++; t.Error("invalid request reached transport") })
	for _, path := range []string{"../escape", "/absolute", "C:/drive", "a\\b", "a\nb", ".zeroagent-archive-a/x"} {
		spec := archiveSpec()
		spec.Destination = path
		if _, _, err := client.ExtractArchive(context.Background(), spec); err == nil {
			t.Fatal("unsafe path accepted")
		}
	}
	unknown := &UnknownOutcomeError{Receipt: Receipt{OperationID: "extract-one", Action: "archive.extract", State: StateUnknown}}
	view := client.WithOperationRunner(func(_ context.Context, operation Operation) (Receipt, error) {
		calls++
		if operation.OperationID != "extract-one" {
			t.Error("ID changed")
		}
		return unknown.Receipt, unknown
	})
	_, receipt, err := view.ExtractArchive(context.Background(), archiveSpec())
	if !errors.Is(err, unknown) || receipt.State != StateUnknown || calls != 1 {
		t.Fatalf("unknown replayed: calls=%d err=%v", calls, err)
	}
}
