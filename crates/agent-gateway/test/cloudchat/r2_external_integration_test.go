package cloudchat_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptrace"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudbackup"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

type r2ExternalConfig struct {
	Endpoint        string `json:"s3_endpoint"`
	Bucket          string `json:"s3_bucket"`
	Region          string `json:"s3_region"`
	AccessKeyID     string `json:"s3_access_key_id"`
	SecretAccessKey string `json:"s3_secret_access_key"`
	Allowance       struct {
		S3MaxBytes int64 `json:"s3_max_bytes"`
	} `json:"allowance"`
}
type r2OwnedObject struct {
	Key              string            `json:"key"`
	SHA256           string            `json:"sha256"`
	Size             int64             `json:"size"`
	ContentType      string            `json:"content_type"`
	Metadata         map[string]string `json:"metadata"`
	WriteAttempted   bool              `json:"write_attempted"`
	CleanupConfirmed bool              `json:"cleanup_confirmed"`
	CleanupCode      string            `json:"cleanup_code"`
}
type r2PrivateReceipts struct {
	Version      int                                `json:"version"`
	Purpose      string                             `json:"purpose"`
	Nonce        string                             `json:"nonce"`
	Prefix       string                             `json:"prefix"`
	CreatedAt    time.Time                          `json:"created_at"`
	Objects      []*r2OwnedObject                   `json:"objects"`
	RestoreProbe *cloudbackup.ConditionalWriteProbe `json:"restore_probe,omitempty"`
}
type r2ExternalStep struct {
	Name         string `json:"name"`
	Milliseconds int64  `json:"milliseconds"`
}
type r2ExternalReport struct {
	Scope                      string           `json:"scope"`
	StartedAt                  time.Time        `json:"started_at"`
	FinishedAt                 time.Time        `json:"finished_at"`
	Passed                     []string         `json:"passed"`
	Steps                      []r2ExternalStep `json:"steps"`
	Success                    bool             `json:"success"`
	CleanupConfirmed           bool             `json:"cleanup_confirmed"`
	CleanupPending             int              `json:"cleanup_pending"`
	MaxAdditionalBytes         int64            `json:"max_additional_bytes"`
	ApplicationPutPayloadBytes int64            `json:"application_put_payload_bytes"`
	VerifiedGetBytes           int64            `json:"verified_get_bytes"`
	RequestsSent               int64            `json:"requests_sent"`
	ConditionalHeadersObserved int64            `json:"conditional_headers_observed"`
	ConditionalGate            string           `json:"conditional_gate"`
	KeyHashes                  []string         `json:"key_hashes"`
	FailureCode                string           `json:"failure_code,omitempty"`
}

func r2TestDigest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
func r2SaveJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0600)
}

// Explicit opt-in only. No ordinary test reads credentials or contacts R2.
// It uses a fresh 256-bit prefix, never lists the bucket, never restores a DB,
// and keeps exact cleanup responsibilities in the private configuration folder.
func TestR2ExternalObjectAndConditionalRestoreContract(t *testing.T) {
	privatePath := os.Getenv("ZEROAGENT_R2_TEST_CONFIG_FILE")
	if privatePath == "" {
		t.Skip("explicit authorized external R2 acceptance not requested")
	}
	evidenceDir := os.Getenv("ZEROAGENT_R2_TEST_EVIDENCE_DIR")
	if evidenceDir == "" {
		t.Fatal("explicit R2 evidence directory required")
	}
	private, err := os.ReadFile(privatePath)
	if err != nil || len(private) > 64<<10 {
		t.Fatal("read private R2 test configuration")
	}
	var cfg r2ExternalConfig
	if json.Unmarshal(bytes.TrimPrefix(private, []byte{0xef, 0xbb, 0xbf}), &cfg) != nil {
		t.Fatal("invalid private R2 configuration")
	}
	endpoint, err := url.Parse(cfg.Endpoint)
	if err != nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || cfg.Allowance.S3MaxBytes < 64<<20 {
		t.Fatal("external R2 acceptance requires explicit HTTPS configuration and allowance")
	}
	if err = os.MkdirAll(evidenceDir, 0700); err != nil {
		t.Fatal("create R2 evidence directory")
	}
	nonceBytes := make([]byte, 32)
	if _, err = rand.Read(nonceBytes); err != nil {
		t.Fatal("create R2 test nonce")
	}
	nonce := hex.EncodeToString(nonceBytes)
	prefix := "zeroagent-external-tests/r2/v1/" + nonce + "/"
	ledger := r2PrivateReceipts{Version: 1, Purpose: "authorized-r2-storage-and-conditional-write-test-only", Nonce: nonce, Prefix: prefix, CreatedAt: time.Now().UTC(), Objects: []*r2OwnedObject{}}
	ledgerPath := filepath.Join(filepath.Dir(privatePath), "r2-receipts-"+nonce+".private.json")
	if err = r2SaveJSON(ledgerPath, &ledger); err != nil {
		t.Fatal("create private R2 cleanup receipts before remote mutation")
	}
	options := objectstore.Config{Endpoint: cfg.Endpoint, Bucket: cfg.Bucket, Region: cfg.Region, AccessKeyID: cfg.AccessKeyID, SecretAccessKey: cfg.SecretAccessKey, MaxObjectBytes: 32 << 20, RequestTimeout: 90 * time.Second, TempDir: t.TempDir()}
	store, err := objectstore.New(options)
	if err != nil || !store.Status().Enabled {
		t.Fatal("construct explicit R2 object adapter")
	}
	defer store.Close()
	conditional, err := cloudbackup.NewS3(options)
	if err != nil {
		t.Fatal("construct explicit R2 conditional adapter")
	}
	defer conditional.Close()
	report := r2ExternalReport{Scope: "real authorized R2 object integrity and conditional restore capability; no DB/auth restore, no model/E2B/search requests", StartedAt: time.Now().UTC(), MaxAdditionalBytes: 64 << 20, Passed: []string{}, Steps: []r2ExternalStep{}, KeyHashes: []string{}}
	var requests, conditionHeaders atomic.Int64
	trace := &httptrace.ClientTrace{WroteHeaders: func() { requests.Add(1) }, WroteHeaderField: func(key string, values []string) {
		if strings.EqualFold(key, "If-None-Match") {
			for _, value := range values {
				if value == "*" {
					conditionHeaders.Add(1)
				}
			}
		}
	}}
	ctx, cancel := context.WithTimeout(httptrace.WithClientTrace(context.Background(), trace), 5*time.Minute)
	defer cancel()
	fail := func(code string) { report.FailureCode = code; t.Fatal(code) }
	save := func() {
		if err := r2SaveJSON(ledgerPath, &ledger); err != nil {
			fail("private_r2_receipt_write_failed")
		}
	}
	verify := func(ctx context.Context, record *r2OwnedObject) error {
		info, err := store.Head(ctx, record.Key)
		if err != nil {
			return err
		}
		if info.Size != record.Size || info.SHA256 != record.SHA256 || info.ContentType != record.ContentType || info.Metadata["test-nonce"] != nonce || info.Metadata["test-purpose"] != "cloudchat-r2-acceptance" {
			return objectstore.ErrIntegrity
		}
		for key, value := range record.Metadata {
			if info.Metadata[key] != value {
				return objectstore.ErrIntegrity
			}
		}
		object, err := store.Get(ctx, record.Key)
		if err != nil {
			return err
		}
		hash := sha256.New()
		count, readErr := io.Copy(hash, object.Body)
		closeErr := object.Body.Close()
		if readErr != nil {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		if count != record.Size || hex.EncodeToString(hash.Sum(nil)) != record.SHA256 {
			return objectstore.ErrIntegrity
		}
		report.VerifiedGetBytes += count
		return nil
	}
	// Register before the first mutation; cleanup is independently bounded and
	// requires the exact nonce, canonical metadata, length and full object SHA.
	t.Cleanup(func() {
		cleanupCtx, stop := context.WithTimeout(httptrace.WithClientTrace(context.Background(), trace), 90*time.Second)
		defer stop()
		pending := 0
		for index := len(ledger.Objects) - 1; index >= 0; index-- {
			record := ledger.Objects[index]
			if !record.WriteAttempted {
				record.CleanupConfirmed = true
				record.CleanupCode = "not_written"
				continue
			}
			if index == 0 && pending > 0 {
				record.CleanupCode = "retained_marker_for_pending_objects"
				pending++
				continue
			}
			if _, err := store.Head(cleanupCtx, record.Key); errors.Is(err, objectstore.ErrNotFound) {
				record.CleanupConfirmed = true
				record.CleanupCode = "confirmed_absent"
				continue
			}
			if !strings.HasPrefix(record.Key, prefix) || verify(cleanupCtx, record) != nil {
				record.CleanupCode = "ownership_or_bytes_unconfirmed"
				pending++
				continue
			}
			deleteErr := store.Delete(cleanupCtx, record.Key)
			if _, err := store.Head(cleanupCtx, record.Key); errors.Is(err, objectstore.ErrNotFound) {
				record.CleanupConfirmed = true
				record.CleanupCode = "deleted_and_absent"
			} else {
				record.CleanupCode = "delete_not_confirmed"
				if deleteErr != nil {
					record.CleanupCode = "delete_outcome_unknown"
				}
				pending++
			}
		}
		if ledger.RestoreProbe != nil && ledger.RestoreProbe.CleanupRequired && !ledger.RestoreProbe.CleanupConfirmed {
			pending++
		}
		report.CleanupPending = pending
		report.CleanupConfirmed = pending == 0
		report.RequestsSent = requests.Load()
		report.ConditionalHeadersObserved = conditionHeaders.Load()
		report.FinishedAt = time.Now().UTC()
		if err := r2SaveJSON(ledgerPath, &ledger); err != nil {
			report.FailureCode = "private_r2_cleanup_receipt_write_failed"
			t.Error(report.FailureCode)
		}
		if pending > 0 {
			report.FailureCode = "r2_cleanup_requires_private_receipt_review"
			t.Error(report.FailureCode)
		}
		report.Success = !t.Failed() && report.CleanupConfirmed
		if err := r2SaveJSON(filepath.Join(evidenceDir, "result.json"), &report); err != nil {
			t.Error("write safe R2 evidence")
		}
		t.Logf("R2 objects=%d application_payload_bytes=%d verified_get_bytes=%d requests=%d cleanup_pending=%d gate=%s", len(ledger.Objects), report.ApplicationPutPayloadBytes, report.VerifiedGetBytes, report.RequestsSent, pending, report.ConditionalGate)
	})
	step := func(name string, start time.Time) {
		report.Steps = append(report.Steps, r2ExternalStep{Name: name, Milliseconds: time.Since(start).Milliseconds()})
		report.Passed = append(report.Passed, name)
	}
	start := time.Now()
	if err = store.Ready(ctx); err != nil {
		fail("r2_signed_bucket_readiness_failed")
	}
	step("signed_bucket_readiness", start)
	newRecord := func(suffix string, data []byte, contentType string) *r2OwnedObject {
		record := &r2OwnedObject{Key: prefix + suffix, SHA256: r2TestDigest(data), Size: int64(len(data)), ContentType: contentType, Metadata: map[string]string{"test-nonce": nonce, "test-purpose": "cloudchat-r2-acceptance"}, CleanupCode: "not_written"}
		ledger.Objects = append(ledger.Objects, record)
		report.KeyHashes = append(report.KeyHashes, r2TestDigest([]byte(record.Key)))
		save()
		return record
	}
	put := func(record *r2OwnedObject, data []byte) {
		if _, err := store.Head(ctx, record.Key); !errors.Is(err, objectstore.ErrNotFound) {
			fail("r2_fresh_key_absence_not_proven")
		}
		record.WriteAttempted = true
		save()
		report.ApplicationPutPayloadBytes += int64(len(data))
		if _, err := store.Put(ctx, record.Key, bytes.NewReader(data), int64(len(data)), objectstore.PutOptions{ContentType: record.ContentType, SHA256: record.SHA256, Metadata: record.Metadata}); err != nil {
			fail("r2_owned_put_failed")
		}
		if err := verify(ctx, record); err != nil {
			fail("r2_owned_put_full_read_verification_failed")
		}
	}
	markerData, _ := json.Marshal(map[string]any{"purpose": ledger.Purpose, "nonce": nonce, "prefix": prefix, "created_at": ledger.CreatedAt})
	marker := newRecord("marker.json", markerData, "application/json")
	start = time.Now()
	put(marker, markerData)
	step("fresh_owned_marker_round_trip", start)
	large := make([]byte, 32<<20)
	if _, err = rand.Read(large); err != nil {
		fail("r2_synthetic_payload_generation_failed")
	}
	big := newRecord("original-32mib.bin", large, "application/octet-stream")
	big.Metadata["display-name-utf8-base64"] = base64.StdEncoding.EncodeToString([]byte("中文资料-真实R2验收.bin"))
	save()
	start = time.Now()
	put(big, large)
	step("put_head_get_full_sha_32mib_and_unicode_metadata", start)
	start = time.Now()
	err = conditional.CheckRestoreWriteSemantics(ctx)
	if err != nil {
		var proof *cloudbackup.ConditionalWriteError
		if errors.As(err, &proof) {
			copy := proof.Probe
			ledger.RestoreProbe = &copy
			save()
		}
		report.ConditionalGate = "unconfirmed"
		if errors.Is(err, cloudbackup.ErrConditionalWritesUnsupported) {
			report.ConditionalGate = "unsupported"
		}
		fail("r2_restore_conditional_gate_" + report.ConditionalGate)
	}
	report.ConditionalGate = "supported_and_probe_cleanup_confirmed"
	step("real_restore_conditional_gate_and_probe_cleanup", start)
	before := requests.Load()
	if err = conditional.CheckRestoreWriteSemantics(ctx); err != nil || requests.Load() != before {
		fail("r2_probe_cache_repeated_or_changed")
	}
	report.Passed = append(report.Passed, "same_client_gate_has_no_second_probe")
	original := bytes.Repeat([]byte("synthetic immutable owned conditional payload\n"), 96)
	replacement := bytes.Repeat([]byte("different replacement must never overwrite\n"), 96)
	immutable := newRecord("conditional-original.bin", original, "application/octet-stream")
	if _, err = store.Head(ctx, immutable.Key); !errors.Is(err, objectstore.ErrNotFound) {
		fail("r2_fresh_conditional_key_absence_not_proven")
	}
	immutable.WriteAttempted = true
	save()
	report.ApplicationPutPayloadBytes += int64(len(original))
	start = time.Now()
	if err = conditional.PutIfAbsent(ctx, immutable.Key, bytes.NewReader(original), int64(len(original)), objectstore.PutOptions{ContentType: immutable.ContentType, SHA256: immutable.SHA256, Metadata: immutable.Metadata}); err != nil {
		fail("r2_first_conditional_put_failed")
	}
	if err = verify(ctx, immutable); err != nil {
		fail("r2_first_conditional_value_unverified")
	}
	step("first_conditional_put_and_full_read", start)
	start = time.Now()
	report.ApplicationPutPayloadBytes += int64(len(replacement))
	err = conditional.PutIfAbsent(ctx, immutable.Key, bytes.NewReader(replacement), int64(len(replacement)), objectstore.PutOptions{ContentType: immutable.ContentType, SHA256: r2TestDigest(replacement), Metadata: immutable.Metadata})
	if !errors.Is(err, cloudbackup.ErrTargetNotEmpty) {
		fail("r2_conditional_conflict_did_not_reject")
	}
	if err = verify(ctx, immutable); err != nil {
		fail("r2_conditional_rejection_changed_original")
	}
	step("conflicting_conditional_put_rejected_original_unchanged", start)
	if report.ApplicationPutPayloadBytes+1024 > report.MaxAdditionalBytes {
		fail("r2_payload_budget_exceeded")
	}
}
