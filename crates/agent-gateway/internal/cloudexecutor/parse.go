package cloudexecutor

import (
	"context"
	"encoding/json"
)

const MaxParsedOutputBytes = 2 * 1024 * 1024

type ParseSpec struct {
	Scope
	OperationID  string
	SandboxID    string
	Path         string
	OutputPath   string
	Format       string
	SourceSHA256 string
}

type ParseResult struct {
	SandboxID    string `json:"sandbox_id"`
	OutputPath   string `json:"output_path"`
	Bytes        int64  `json:"bytes"`
	SHA256       string `json:"sha256"`
	SegmentCount int    `json:"segment_count"`
	Truncated    bool   `json:"truncated"`
	ScopeHash    string `json:"scope"`
}

// Parse runs the fixed document extractor inside the already-owned E2B VM. Its
// bounded, scope-bound JSON result stays a VM file until Download retrieves it.
// No untrusted document parser runs in the Gateway process.
func (c *Client) Parse(ctx context.Context, spec ParseSpec) (ParseResult, Receipt, error) {
	if !validScope(spec.Scope) || !identifierPattern.MatchString(spec.OperationID) || !identifierPattern.MatchString(spec.SandboxID) ||
		!validTransferPath(spec.Path) || !validTransferPath(spec.OutputPath) || spec.Path == spec.OutputPath || !digestPattern.MatchString(spec.SourceSHA256) {
		return ParseResult{}, Receipt{}, &APIError{Code: "invalid_request"}
	}
	switch spec.Format {
	case "pdf", "docx", "xlsx", "pptx":
	default:
		return ParseResult{}, Receipt{}, &APIError{Code: "unsupported_format"}
	}
	operation := Operation{OperationID: spec.OperationID, OwnerScope: spec.OwnerScope, WorkspaceRef: spec.WorkspaceRef, SandboxID: spec.SandboxID, Action: "file.parse",
		Input: map[string]any{"path": spec.Path, "output_path": spec.OutputPath, "format": spec.Format, "source_sha256": spec.SourceSHA256}}
	receipt, err := c.transferStep(ctx, operation)
	if err != nil {
		return ParseResult{}, receipt, err
	}
	var result ParseResult
	if json.Unmarshal(receipt.Result, &result) != nil || result.OutputPath != spec.OutputPath || result.SandboxID != spec.SandboxID ||
		result.Bytes < 0 || result.Bytes > MaxParsedOutputBytes || !digestPattern.MatchString(result.SHA256) || !digestPattern.MatchString(result.ScopeHash) || result.SegmentCount < 0 || result.SegmentCount > 5000 {
		return ParseResult{}, receipt, &APIError{Code: "invalid_receipt", MayHaveExecuted: true}
	}
	return result, receipt, nil
}
