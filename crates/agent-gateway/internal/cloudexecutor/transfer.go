package cloudexecutor

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

const MaxTransferBytes int64 = 32 * 1024 * 1024
const TransferFrameBytes = 1024 * 1024

type TransferSpec struct {
	Scope
	SandboxID  string
	TransferID string
	Path       string
	TotalBytes int64
	SHA256     string
}

type TransferResult struct {
	TotalBytes int64
	SHA256     string
}

// OutcomeError is a recorded failed/cancelled tool outcome, not an unknown
// transport result. The receipt remains available for audit/reconciliation.
type OutcomeError struct{ Receipt Receipt }

func (e *OutcomeError) Error() string { return "cloud executor transfer did not succeed" }

var transferIDPattern = regexp.MustCompile(`^[a-f0-9]{32,64}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// NewTransferID generates an opaque ID. Persist it before calling Upload so that
// subsequent reconciliation uses the same IDs instead of repeating an effect.
func NewTransferID() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", errors.New("transfer ID generation failed")
	}
	return hex.EncodeToString(data[:]), nil
}

func validTransferPath(path string) bool {
	if path == "" || len(path) > 1024 || strings.ContainsAny(path, "\\\x00") {
		return false
	}
	parts := strings.Split(path, "/")
	if parts[0] == ".zeroagent-transfers" {
		return false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func validateTransfer(spec TransferSpec) error {
	if !validScope(spec.Scope) || !identifierPattern.MatchString(spec.SandboxID) || !transferIDPattern.MatchString(spec.TransferID) ||
		!validTransferPath(spec.Path) || spec.TotalBytes < 0 || spec.TotalBytes > MaxTransferBytes || !digestPattern.MatchString(spec.SHA256) {
		return &APIError{Code: "invalid_transfer"}
	}
	return nil
}

func transferOperation(spec TransferSpec, action string, offset int64, input map[string]any) Operation {
	key, _ := json.Marshal([]any{spec.Scope, spec.SandboxID, spec.TransferID, spec.Path, spec.TotalBytes, spec.SHA256, action, offset})
	hash := sha256.Sum256(key)
	return Operation{OperationID: "transfer-" + hex.EncodeToString(hash[:]), OwnerScope: spec.OwnerScope, WorkspaceRef: spec.WorkspaceRef,
		Action: action, SandboxID: spec.SandboxID, Input: input}
}

func transferInput(spec TransferSpec) map[string]any {
	return map[string]any{"transfer_id": spec.TransferID, "total_bytes": spec.TotalBytes, "sha256": spec.SHA256}
}

func (c *Client) transferStep(ctx context.Context, operation Operation) (Receipt, error) {
	receipt, err := c.Execute(ctx, operation)
	if err != nil {
		return receipt, err
	}
	if receipt.State != StateSucceeded {
		return receipt, &OutcomeError{Receipt: receipt}
	}
	return receipt, nil
}

// Upload copies at most 32 MiB using <=1 MiB frames and stable per-frame IDs.
// The caller supplies a byte source, never an object-storage URL or credential.
// Unknown outcomes stop the transfer immediately; inspect the original receipt.
func (c *Client) Upload(ctx context.Context, spec TransferSpec, source io.ReaderAt) (Receipt, error) {
	if err := validateTransfer(spec); err != nil {
		return Receipt{}, err
	}
	if source == nil {
		return Receipt{}, &APIError{Code: "invalid_transfer"}
	}
	if err := ctx.Err(); err != nil {
		return Receipt{}, err
	}
	hash := sha256.New()
	read, err := io.Copy(hash, io.NewSectionReader(source, 0, spec.TotalBytes))
	if err != nil || read != spec.TotalBytes || hex.EncodeToString(hash.Sum(nil)) != spec.SHA256 {
		return Receipt{}, &APIError{Code: "digest_mismatch"}
	}
	input := transferInput(spec)
	input["path"] = spec.Path
	if receipt, err := c.transferStep(ctx, transferOperation(spec, "file.upload.begin", 0, input)); err != nil {
		return receipt, err
	}
	buffer := make([]byte, TransferFrameBytes)
	for offset := int64(0); offset < spec.TotalBytes; {
		if err := ctx.Err(); err != nil {
			return Receipt{}, err
		}
		count := int64(len(buffer))
		if remaining := spec.TotalBytes - offset; remaining < count {
			count = remaining
		}
		read, err := source.ReadAt(buffer[:count], offset)
		if int64(read) != count || (err != nil && !errors.Is(err, io.EOF)) {
			return Receipt{}, &APIError{Code: "source_changed"}
		}
		input := transferInput(spec)
		input["offset"] = offset
		input["data_base64"] = base64.StdEncoding.EncodeToString(buffer[:count])
		receipt, err := c.transferStep(ctx, transferOperation(spec, "file.upload.chunk", offset, input))
		if err != nil {
			return receipt, err
		}
		var progress struct {
			ReceivedBytes int64 `json:"received_bytes"`
		}
		if json.Unmarshal(receipt.Result, &progress) != nil || progress.ReceivedBytes < offset+count || progress.ReceivedBytes > spec.TotalBytes {
			return receipt, &APIError{Code: "invalid_receipt", MayHaveExecuted: true}
		}
		offset += count
	}
	input = transferInput(spec)
	input["path"] = spec.Path
	receipt, err := c.transferStep(ctx, transferOperation(spec, "file.upload.finalize", 0, input))
	if err != nil {
		return receipt, err
	}
	var final struct {
		Finalized  bool   `json:"finalized"`
		TotalBytes int64  `json:"total_bytes"`
		SHA256     string `json:"sha256"`
	}
	if json.Unmarshal(receipt.Result, &final) != nil || !final.Finalized || final.TotalBytes != spec.TotalBytes || final.SHA256 != spec.SHA256 {
		return receipt, &APIError{Code: "invalid_receipt", MayHaveExecuted: true}
	}
	return receipt, nil
}

// AbortUpload removes only an unfinished verified transfer. It never removes a
// completed destination file, and never runs automatically after unknown work.
func (c *Client) AbortUpload(ctx context.Context, spec TransferSpec) (Receipt, error) {
	if err := validateTransfer(spec); err != nil {
		return Receipt{}, err
	}
	return c.transferStep(ctx, transferOperation(spec, "file.upload.abort", 0, transferInput(spec)))
}

// Download verifies every frame and the final digest before reporting success.
// The destination may contain partial bytes on error; the caller must use its
// own temporary object and publish it only after this method succeeds.
func (c *Client) Download(ctx context.Context, spec TransferSpec, destination io.Writer) (TransferResult, error) {
	if err := validateTransfer(spec); err != nil {
		return TransferResult{}, err
	}
	if destination == nil {
		return TransferResult{}, &APIError{Code: "invalid_transfer"}
	}
	hash := sha256.New()
	writer := io.MultiWriter(destination, hash)
	for offset := int64(0); ; {
		input := map[string]any{"path": spec.Path, "offset": offset, "max_bytes": TransferFrameBytes, "expected_sha256": spec.SHA256}
		receipt, err := c.transferStep(ctx, transferOperation(spec, "file.download.chunk", offset, input))
		if err != nil {
			return TransferResult{}, err
		}
		var frame struct {
			Offset     int64  `json:"offset"`
			TotalBytes int64  `json:"total_bytes"`
			SHA256     string `json:"sha256"`
			Data       string `json:"data_base64"`
			Bytes      int    `json:"bytes"`
			EOF        bool   `json:"eof"`
		}
		if json.Unmarshal(receipt.Result, &frame) != nil || frame.Offset != offset || frame.TotalBytes != spec.TotalBytes || frame.SHA256 != spec.SHA256 {
			return TransferResult{}, &APIError{Code: "invalid_receipt"}
		}
		data, err := base64.StdEncoding.Strict().DecodeString(frame.Data)
		if err != nil || len(data) != frame.Bytes || len(data) > TransferFrameBytes || offset+int64(len(data)) > spec.TotalBytes || (len(data) == 0 && !frame.EOF) {
			return TransferResult{}, &APIError{Code: "invalid_receipt"}
		}
		if _, err := writer.Write(data); err != nil {
			return TransferResult{}, fmt.Errorf("transfer destination write failed")
		}
		offset += int64(len(data))
		if frame.EOF {
			if offset != spec.TotalBytes || hex.EncodeToString(hash.Sum(nil)) != spec.SHA256 {
				return TransferResult{}, &APIError{Code: "digest_mismatch"}
			}
			return TransferResult{TotalBytes: offset, SHA256: spec.SHA256}, nil
		}
	}
}
