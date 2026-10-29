package cloudexecutor

import (
	"context"
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	MaxArchiveEntries             = 128
	MaxArchiveFileBytes     int64 = 8 * 1024 * 1024
	MaxArchiveExpandedBytes int64 = 32 * 1024 * 1024
	MaxArchivePathBytes           = 64 * 1024
)

type ArchiveExtractSpec struct {
	Scope
	OperationID  string
	SandboxID    string
	Path         string
	Destination  string
	SourceSHA256 string
}

type ArchiveFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type ArchiveExtractResult struct {
	SandboxID    string        `json:"sandbox_id"`
	SourceSHA256 string        `json:"source_sha256"`
	Destination  string        `json:"destination"`
	Files        []ArchiveFile `json:"files"`
	FileCount    int           `json:"file_count"`
	TotalBytes   int64         `json:"total_bytes"`
}

func validArchivePath(path string) bool {
	if !validTransferPath(path) || !utf8.ValidString(path) || strings.Contains(path, ":") || strings.HasPrefix(strings.Split(path, "/")[0], ".zeroagent-") || len(strings.Split(path, "/")) > 32 {
		return false
	}
	for _, value := range path {
		if unicode.IsControl(value) {
			return false
		}
	}
	return true
}

// ExtractArchive verifies source SHA and extracts only bounded regular files in
// a fresh guest directory. It never parses ZIP bytes on the Gateway host. The
// caller must persist OperationID before invoking; unknown effects are queried
// by that same ID, never retried under a new ID. WithOperationRunner is honored.
func (c *Client) ExtractArchive(ctx context.Context, spec ArchiveExtractSpec) (ArchiveExtractResult, Receipt, error) {
	if !validScope(spec.Scope) || !identifierPattern.MatchString(spec.OperationID) || !identifierPattern.MatchString(spec.SandboxID) || !validArchivePath(spec.Path) || !validArchivePath(spec.Destination) || !digestPattern.MatchString(spec.SourceSHA256) {
		return ArchiveExtractResult{}, Receipt{}, &APIError{Code: "invalid_request"}
	}
	receipt, err := c.transferStep(ctx, Operation{OperationID: spec.OperationID, OwnerScope: spec.OwnerScope, WorkspaceRef: spec.WorkspaceRef, SandboxID: spec.SandboxID, Action: "archive.extract", Input: map[string]any{"path": spec.Path, "destination": spec.Destination, "source_sha256": spec.SourceSHA256}})
	if err != nil {
		return ArchiveExtractResult{}, receipt, err
	}
	var result ArchiveExtractResult
	invalid := func() (ArchiveExtractResult, Receipt, error) {
		return ArchiveExtractResult{}, receipt, &APIError{Code: "invalid_receipt", MayHaveExecuted: true}
	}
	if json.Unmarshal(receipt.Result, &result) != nil || result.SandboxID != spec.SandboxID || result.SourceSHA256 != spec.SourceSHA256 || result.Destination != spec.Destination || result.Files == nil || len(result.Files) > MaxArchiveEntries || result.FileCount != len(result.Files) || result.TotalBytes < 0 || result.TotalBytes > MaxArchiveExpandedBytes {
		return invalid()
	}
	var total int64
	pathBytes, previous := 0, ""
	for _, file := range result.Files {
		if !validArchivePath(file.Path) || !strings.HasPrefix(file.Path, spec.Destination+"/") || file.Path <= previous || file.Size < 0 || file.Size > MaxArchiveFileBytes || !digestPattern.MatchString(file.SHA256) {
			return invalid()
		}
		total += file.Size
		pathBytes += len(file.Path)
		previous = file.Path
	}
	if total != result.TotalBytes || pathBytes > MaxArchivePathBytes {
		return invalid()
	}
	return result, receipt, nil
}
