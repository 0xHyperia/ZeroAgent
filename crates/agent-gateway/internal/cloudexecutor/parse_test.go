package cloudexecutor

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestParseIsScopedRemoteOperationAndBoundsDerivedOutput(t *testing.T) {
	for _, invalid := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid", true: "oversized"}[invalid], func(t *testing.T) {
			client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
				var operation Operation
				_ = json.NewDecoder(r.Body).Decode(&operation)
				if operation.Action != "file.parse" || operation.OwnerScope != "account-one" || operation.WorkspaceRef != "workspace-one" || operation.Input["path"] != "documents/test.pdf" {
					t.Error("parse scope lost")
				}
				result := ParseResult{SandboxID: "sandbox-one", OutputPath: "derived/test.json", Bytes: 100, SHA256: strings.Repeat("a", 64), ScopeHash: strings.Repeat("b", 64), SegmentCount: 1}
				if invalid {
					result.Bytes = MaxParsedOutputBytes + 1
				}
				transferResponse(t, w, operation, result)
			})
			result, receipt, err := client.Parse(context.Background(), ParseSpec{Scope: testOperation().Scope(), OperationID: "parse-one", SandboxID: "sandbox-one", Path: "documents/test.pdf", OutputPath: "derived/test.json", Format: "pdf", SourceSHA256: strings.Repeat("c", 64)})
			if invalid {
				if err == nil {
					t.Fatal("oversized parsed output accepted")
				}
				return
			}
			if err != nil || result.Bytes != 100 || receipt.State != StateSucceeded {
				t.Fatalf("result=%+v err=%v", result, err)
			}
		})
	}
}
