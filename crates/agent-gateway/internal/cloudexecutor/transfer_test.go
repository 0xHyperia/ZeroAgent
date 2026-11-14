package cloudexecutor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func transferSpec(data []byte) TransferSpec {
	hash := sha256.Sum256(data)
	return TransferSpec{Scope: testOperation().Scope(), SandboxID: "sandbox-one", TransferID: strings.Repeat("a", 32), Path: "documents/source.bin", TotalBytes: int64(len(data)), SHA256: hex.EncodeToString(hash[:])}
}

func transferResponse(t *testing.T, w http.ResponseWriter, operation Operation, result any) {
	t.Helper()
	data, _ := json.Marshal(result)
	receipt := Receipt{OperationID: operation.OperationID, Action: operation.Action, State: StateSucceeded, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(), Result: data}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(receipt); err != nil {
		t.Error(err)
	}
}

func TestTransfer32MiBUsesBoundedFramesAndStableOperationIDs(t *testing.T) {
	data := bytes.Repeat([]byte("0123456789abcdef"), int(MaxTransferBytes)/16)
	spec := transferSpec(data)
	var uploaded bytes.Buffer
	operations := map[string]Operation{}
	duplicate := false
	client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		var operation Operation
		if err := json.NewDecoder(r.Body).Decode(&operation); err != nil {
			t.Error(err)
		}
		if previous, ok := operations[operation.OperationID]; ok {
			before, _ := json.Marshal(previous)
			after, _ := json.Marshal(operation)
			if !bytes.Equal(before, after) {
				t.Error("retry changed request fingerprint")
			}
		}
		operations[operation.OperationID] = operation
		switch operation.Action {
		case "file.upload.begin":
			transferResponse(t, w, operation, map[string]any{"received_bytes": 0})
		case "file.upload.chunk":
			chunk, err := base64.StdEncoding.DecodeString(operation.Input["data_base64"].(string))
			if err != nil || len(chunk) > TransferFrameBytes {
				t.Error("frame exceeds limit")
			}
			offset := int(operation.Input["offset"].(float64))
			if !bytes.Equal(chunk, data[offset:offset+len(chunk)]) {
				t.Error("data changed")
			}
			if !duplicate {
				_, _ = uploaded.Write(chunk)
			}
			transferResponse(t, w, operation, map[string]any{"received_bytes": offset + len(chunk)})
		case "file.upload.finalize":
			transferResponse(t, w, operation, map[string]any{"finalized": true, "total_bytes": spec.TotalBytes, "sha256": spec.SHA256})
		case "file.download.chunk":
			offset := int(operation.Input["offset"].(float64))
			end := offset + TransferFrameBytes
			if end > len(data) {
				end = len(data)
			}
			transferResponse(t, w, operation, map[string]any{"offset": offset, "total_bytes": spec.TotalBytes, "sha256": spec.SHA256,
				"bytes": end - offset, "data_base64": base64.StdEncoding.EncodeToString(data[offset:end]), "eof": end == len(data)})
		default:
			t.Error("unexpected transfer action")
		}
	}, func(config *Config) {
		// The race detector instruments JSON and base64 work on each 1 MiB frame.
		config.RequestTimeout = 10 * time.Second
		config.MaxWait = 15 * time.Second
	})
	if _, err := client.Upload(context.Background(), spec, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(uploaded.Bytes(), data) || len(operations) != 34 {
		t.Fatal("upload incomplete")
	}
	// Caller-explicit retry uses identical per-frame operation IDs, so adapter
	// receipts deduplicate rather than appending the bytes again.
	duplicate = true
	if _, err := client.Upload(context.Background(), spec, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if len(operations) != 34 || uploaded.Len() != len(data) {
		t.Fatal("duplicate append")
	}
	var downloaded bytes.Buffer
	result, err := client.Download(context.Background(), spec, &downloaded)
	if err != nil || result.TotalBytes != MaxTransferBytes || !bytes.Equal(downloaded.Bytes(), data) {
		t.Fatalf("download incomplete: %v", err)
	}
}

func TestTransferLimitsDigestAndUnknownStopImmediately(t *testing.T) {
	requests := 0
	client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		var operation Operation
		_ = json.NewDecoder(r.Body).Decode(&operation)
		if operation.Action == "file.upload.begin" {
			transferResponse(t, w, operation, map[string]any{"received_bytes": 0})
			return
		}
		if operation.Action == "file.upload.chunk" {
			w.Header().Set("Content-Type", "application/json")
			receipt := Receipt{OperationID: operation.OperationID, Action: operation.Action, State: StateUnknown, CreatedAt: time.Now(), UpdatedAt: time.Now()}
			_ = json.NewEncoder(w).Encode(receipt)
			return
		}
		t.Error("unknown frame should not advance/finalize")
	})
	data := []byte("data")
	spec := transferSpec(data)
	tooLarge := spec
	tooLarge.TotalBytes = MaxTransferBytes + 1
	if _, err := client.Upload(context.Background(), tooLarge, bytes.NewReader(data)); err == nil || requests != 0 {
		t.Fatal("accepted oversized file")
	}
	if _, err := client.Upload(context.Background(), spec, bytes.NewReader([]byte("evil"))); err == nil || requests != 0 {
		t.Fatal("accepted bad source digest")
	}
	receipt, err := client.Upload(context.Background(), spec, bytes.NewReader(data))
	if err == nil || receipt.State != StateUnknown || requests != 2 {
		t.Fatalf("unknown was retried: %v requests=%d", err, requests)
	}
}

func TestDownloadRejectsCorruptFramesAndFinalDigest(t *testing.T) {
	for _, scenario := range []string{"offset", "oversized", "digest"} {
		t.Run(scenario, func(t *testing.T) {
			spec := transferSpec([]byte("good"))
			client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
				var operation Operation
				_ = json.NewDecoder(r.Body).Decode(&operation)
				payload := map[string]any{"offset": 0, "total_bytes": 4, "sha256": spec.SHA256, "data_base64": base64.StdEncoding.EncodeToString([]byte("evil")), "bytes": 4, "eof": true}
				if scenario == "offset" {
					payload["offset"] = 1
				}
				if scenario == "oversized" {
					payload["bytes"] = TransferFrameBytes + 1
				}
				transferResponse(t, w, operation, payload)
			})
			var destination bytes.Buffer
			if _, err := client.Download(context.Background(), spec, &destination); err == nil {
				t.Fatal("corrupted download accepted")
			}
		})
	}
}
