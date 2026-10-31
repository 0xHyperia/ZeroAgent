package cloudexecutor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
	"unicode"
)

type SiteBundleSpec struct {
	Scope
	OperationID, SandboxID, Path, OutputPath string
}
type SiteBundleResult struct {
	SandboxID     string `json:"sandbox_id"`
	SourcePath    string `json:"source_path"`
	Path          string `json:"path"`
	EntryPoint    string `json:"entry_point"`
	Size          int64  `json:"size"`
	SHA256        string `json:"sha256"`
	FileCount     int    `json:"file_count"`
	ExpandedBytes int64  `json:"expanded_bytes"`
}

var siteBundleOutputPattern = regexp.MustCompile(`^site-bundles/[a-f0-9]{64}\.zip$`)

func SiteBundlePath(operationID string) string {
	digest := sha256.Sum256([]byte("site-bundle-v1:" + operationID))
	return "site-bundles/" + hex.EncodeToString(digest[:]) + ".zip"
}
func ValidSiteSourcePath(path string) bool {
	if !validArchivePath(path) || strings.Split(path, "/")[0] == "site-bundles" || strings.ContainsAny(path, "%?#") {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if strings.HasPrefix(part, ".") || strings.EqualFold(part, "node_modules") || strings.EqualFold(part, "credentials.json") || strings.EqualFold(part, "id_rsa") || strings.EqualFold(part, "id_ed25519") {
			return false
		}
	}
	for _, r := range path {
		if unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// Only a prepared stable operation may invoke this. The normal operation runner
// persists and reconciles the receipt; an unknown result never repacks a tree.
func (c *Client) BundleSite(ctx context.Context, spec SiteBundleSpec) (SiteBundleResult, Receipt, error) {
	if !validScope(spec.Scope) || !identifierPattern.MatchString(spec.OperationID) || !identifierPattern.MatchString(spec.SandboxID) || !ValidSiteSourcePath(spec.Path) || !siteBundleOutputPattern.MatchString(spec.OutputPath) {
		return SiteBundleResult{}, Receipt{}, &APIError{Code: "invalid_request"}
	}
	receipt, err := c.transferStep(ctx, Operation{OperationID: spec.OperationID, OwnerScope: spec.OwnerScope, WorkspaceRef: spec.WorkspaceRef, SandboxID: spec.SandboxID, Action: "site.bundle", Input: map[string]any{"path": spec.Path, "output_path": spec.OutputPath}})
	if err != nil {
		return SiteBundleResult{}, receipt, err
	}
	var result SiteBundleResult
	if json.Unmarshal(receipt.Result, &result) != nil || result.SandboxID != spec.SandboxID || result.SourcePath != spec.Path || result.Path != spec.OutputPath || result.EntryPoint != "index.html" || result.Size < 1 || result.Size > MaxTransferBytes || !digestPattern.MatchString(result.SHA256) || result.FileCount < 1 || result.FileCount > 2000 || result.ExpandedBytes < 1 || result.ExpandedBytes > 64<<20 {
		return SiteBundleResult{}, receipt, &APIError{Code: "invalid_receipt", MayHaveExecuted: true}
	}
	return result, receipt, nil
}
