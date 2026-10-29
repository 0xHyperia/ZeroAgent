package cloudexecutor

import (
	"context"
	"encoding/base64"
	"encoding/json"
)

type FileInfo struct {
	Size   int64
	SHA256 string
}

// InspectFile derives size and a whole-file digest inside the owned VM without
// trusting model-supplied size/hash or downloading more than one content byte.
func (c *Client) InspectFile(ctx context.Context, operationID string, scope Scope, sandboxID, path string) (FileInfo, Receipt, error) {
	if !validTransferPath(path) || !validScope(scope) || !identifierPattern.MatchString(operationID) || !identifierPattern.MatchString(sandboxID) {
		return FileInfo{}, Receipt{}, &APIError{Code: "invalid_request"}
	}
	receipt, err := c.transferStep(ctx, Operation{OperationID: operationID, OwnerScope: scope.OwnerScope, WorkspaceRef: scope.WorkspaceRef, SandboxID: sandboxID, Action: "file.download.chunk", Input: map[string]any{"path": path, "offset": 0, "max_bytes": 1}})
	if err != nil {
		return FileInfo{}, receipt, err
	}
	var result struct {
		Offset     int64  `json:"offset"`
		TotalBytes int64  `json:"total_bytes"`
		SHA256     string `json:"sha256"`
		Data       string `json:"data_base64"`
		Bytes      int    `json:"bytes"`
	}
	if json.Unmarshal(receipt.Result, &result) != nil || result.Offset != 0 || result.TotalBytes < 0 || result.TotalBytes > MaxTransferBytes || !digestPattern.MatchString(result.SHA256) {
		return FileInfo{}, receipt, &APIError{Code: "invalid_receipt"}
	}
	data, err := base64.StdEncoding.Strict().DecodeString(result.Data)
	if err != nil || len(data) > 1 || len(data) != result.Bytes {
		return FileInfo{}, receipt, &APIError{Code: "invalid_receipt"}
	}
	return FileInfo{Size: result.TotalBytes, SHA256: result.SHA256}, receipt, nil
}
