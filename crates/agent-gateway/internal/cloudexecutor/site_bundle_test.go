package cloudexecutor

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func siteBundleSpec() SiteBundleSpec {
	return SiteBundleSpec{Scope: testOperation().Scope(), OperationID: "bundle-one", SandboxID: "sandbox-one", Path: "project/dist", OutputPath: SiteBundlePath("parent-one")}
}

func TestBundleSiteStrictScopedReceipt(t *testing.T) {
	for _, variant := range []string{"valid", "foreign-sandbox", "wrong-source", "wrong-output", "wrong-entry", "empty", "oversized", "bad-hash", "too-many", "empty-tree", "expanded-limit"} {
		t.Run(variant, func(t *testing.T) {
			spec := siteBundleSpec()
			client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
				var op Operation
				if json.NewDecoder(r.Body).Decode(&op) != nil || op.Action != "site.bundle" || op.OperationID != spec.OperationID || op.Scope() != spec.Scope || op.SandboxID != spec.SandboxID || len(op.Input) != 2 || op.Input["path"] != spec.Path || op.Input["output_path"] != spec.OutputPath {
					t.Error("site bundle request lost its scope or stable identity")
				}
				result := SiteBundleResult{SandboxID: spec.SandboxID, SourcePath: spec.Path, Path: spec.OutputPath, EntryPoint: "index.html", Size: 100, SHA256: strings.Repeat("b", 64), FileCount: 2, ExpandedBytes: 150}
				switch variant {
				case "foreign-sandbox":
					result.SandboxID = "other"
				case "wrong-source":
					result.SourcePath = "other/dist"
				case "wrong-output":
					result.Path = SiteBundlePath("other-parent")
				case "wrong-entry":
					result.EntryPoint = "other.html"
				case "empty":
					result.Size = 0
				case "oversized":
					result.Size = MaxTransferBytes + 1
				case "bad-hash":
					result.SHA256 = strings.Repeat("B", 64)
				case "too-many":
					result.FileCount = 2001
				case "empty-tree":
					result.FileCount = 0
				case "expanded-limit":
					result.ExpandedBytes = 64<<20 + 1
				}
				transferResponse(t, w, op, result)
			})
			result, receipt, err := client.BundleSite(context.Background(), spec)
			if variant == "valid" {
				if err != nil || result.SourcePath != spec.Path || receipt.State != StateSucceeded {
					t.Fatalf("bundle result=%+v err=%v", result, err)
				}
				return
			}
			var api *APIError
			if !errors.As(err, &api) || api.Code != "invalid_receipt" || !api.MayHaveExecuted {
				t.Fatalf("unbound bundle receipt accepted: %v", err)
			}
		})
	}
}

func TestBundleSiteRejectsUnsafePathsAndKeepsUnknownIdentity(t *testing.T) {
	calls := 0
	client := clientFor(t, func(http.ResponseWriter, *http.Request) { calls++; t.Error("unsafe bundle reached executor") })
	for _, path := range []string{".", "../dist", "/dist", "C:/dist", "a\\b", "x\ny", ".git", "project/.env", "a/node_modules/dist", "site-bundles", "x%2fy", "x?y", "x#y", "x\u202ey", "credentials.json", "id_ed25519"} {
		spec := siteBundleSpec()
		spec.Path = path
		if _, _, err := client.BundleSite(context.Background(), spec); err == nil {
			t.Fatalf("unsafe source accepted: %q", path)
		}
	}
	for _, path := range []string{"output.zip", "site-bundles/a.zip", "/site-bundles/" + strings.Repeat("a", 64) + ".zip"} {
		spec := siteBundleSpec()
		spec.OutputPath = path
		if _, _, err := client.BundleSite(context.Background(), spec); err == nil {
			t.Fatal("unsafe output accepted")
		}
	}
	unknown := &UnknownOutcomeError{Receipt: Receipt{OperationID: "bundle-one", Action: "site.bundle", State: StateUnknown}}
	view := client.WithOperationRunner(func(_ context.Context, op Operation) (Receipt, error) {
		calls++
		if op.OperationID != "bundle-one" || op.Input["output_path"] != SiteBundlePath("parent-one") {
			t.Error("uncertain bundle identity changed")
		}
		return unknown.Receipt, unknown
	})
	_, receipt, err := view.BundleSite(context.Background(), siteBundleSpec())
	if !errors.Is(err, unknown) || receipt.State != StateUnknown || calls != 1 {
		t.Fatalf("uncertain bundle retried: calls=%d err=%v", calls, err)
	}
}
