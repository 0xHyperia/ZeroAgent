package cloudchat_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudbackup"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

// A real, explicitly requested local service. No ordinary test starts Docker,
// reads credentials, contacts R2 or changes an existing application bucket.
func TestSeaweedFSStorageContract(t *testing.T) {
	privatePath := os.Getenv("ZEROAGENT_SEAWEEDFS_TEST_CONFIG_FILE")
	if privatePath == "" {
		t.Skip("explicit disposable SeaweedFS not requested")
	}
	private, err := os.ReadFile(privatePath)
	if err != nil || len(private) > 16<<10 {
		t.Fatal("read private local storage fixture")
	}
	var cfg s3AcceptanceConfig
	if json.Unmarshal(private, &cfg) != nil {
		t.Fatal("invalid local storage fixture")
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.Scheme != "http" || u.User != nil || net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback() || !regexp.MustCompile(`^[a-f0-9]{16}$`).MatchString(cfg.TaskID) || cfg.Bucket != "za-seaweed-test-"+cfg.TaskID {
		t.Fatal("fixture must target its isolated numeric loopback bucket")
	}
	phase := os.Getenv("ZEROAGENT_SEAWEEDFS_TEST_PHASE")
	if phase != "prepare" && phase != "verify" {
		t.Fatal("fixture phase must be prepare or verify")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	options := objectstore.Config{Endpoint: cfg.Endpoint, Bucket: cfg.Bucket, Region: cfg.Region, AccessKeyID: cfg.AccessKeyID, SecretAccessKey: cfg.SecretAccessKey, AllowLoopbackHTTP: true, MaxObjectBytes: 32 << 20, TempDir: t.TempDir()}
	store, err := objectstore.New(options)
	if err != nil || !store.Status().Enabled {
		t.Fatal("construct bounded S3 adapter")
	}
	defer store.Close()
	if phase == "prepare" {
		if err = store.InitializeBucket(ctx); err != nil {
			t.Fatal("create isolated fixture bucket")
		}
	}
	if err = store.Ready(ctx); err != nil {
		t.Fatal("signed bucket readiness")
	}
	if err = store.InitializeBucket(ctx); err != nil {
		t.Fatal("explicit bucket initialization is not idempotent")
	}
	foreignConfig := options
	foreignConfig.Bucket = "outside-" + cfg.TaskID
	foreign, err := objectstore.New(foreignConfig)
	if err != nil {
		t.Fatal("construct foreign-bucket fixture")
	}
	defer foreign.Close()
	if !errors.Is(foreign.InitializeBucket(ctx), objectstore.ErrAccessDenied) {
		t.Fatal("bucket-scoped identity could initialize an unrelated bucket")
	}
	body := make([]byte, 32<<20)
	for i := range body {
		body[i] = byte((i*31 + 17) % 251)
	}
	key := "accounts/" + cfg.TaskID + "/acceptance/original"
	digest := acceptanceDigest(body)
	evidence := s3AcceptanceEvidence{Phase: phase, Passed: []string{"signed_bucket_readiness", "idempotent_explicit_initialization", "unrelated_bucket_denied"}, ObjectBytes: len(body), ObjectSHA256: digest}
	if phase == "prepare" {
		if _, err = store.Put(ctx, key, bytes.NewReader(body), int64(len(body)), objectstore.PutOptions{ContentType: "application/octet-stream", SHA256: digest, Metadata: map[string]string{"owner-scope": cfg.TaskID}}); err != nil {
			t.Fatal("signed 32 MiB original upload")
		}
		wrong := options
		wrong.SecretAccessKey = strings.Repeat("0", 64)
		bad, createErr := objectstore.New(wrong)
		if createErr != nil {
			t.Fatal("construct invalid-signature client")
		}
		_, signatureErr := bad.Head(ctx, key)
		bad.Close()
		if !errors.Is(signatureErr, objectstore.ErrAccessDenied) {
			t.Fatal("storage accepted an incorrect signature")
		}
		evidence.Passed = append(evidence.Passed, "signed_put_32mib", "invalid_signature_rejected")
	}
	info, err := store.Head(ctx, key)
	if err != nil || info.Size != int64(len(body)) || info.SHA256 != digest || info.Metadata["owner-scope"] != cfg.TaskID {
		t.Fatal("original metadata and digest")
	}
	object, err := store.Get(ctx, key)
	if err != nil {
		t.Fatal("get persisted original")
	}
	got, readErr := io.ReadAll(io.LimitReader(object.Body, int64(len(body)+1)))
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(got, body) {
		t.Fatal("persisted original differs")
	}
	evidence.Passed = append(evidence.Passed, "head_metadata", "get_complete_digest")
	conditional, err := cloudbackup.NewS3(options)
	if err != nil {
		t.Fatal("construct conditional backup adapter")
	}
	defer conditional.Close()
	if err = conditional.CheckRestoreWriteSemantics(ctx); err != nil {
		t.Fatal("real conditional-write gate rejected local storage")
	}
	conditionalKey := key + "-conditional-" + phase
	var wg sync.WaitGroup
	outcomes := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			payload := []byte{byte(i), 31, 47, 79}
			outcomes <- conditional.PutIfAbsent(ctx, conditionalKey, bytes.NewReader(payload), int64(len(payload)), objectstore.PutOptions{ContentType: "application/octet-stream", SHA256: acceptanceDigest(payload)})
		}(i)
	}
	wg.Wait()
	close(outcomes)
	winners := 0
	for outcome := range outcomes {
		if outcome == nil {
			winners++
		} else if !errors.Is(outcome, cloudbackup.ErrTargetNotEmpty) {
			t.Fatal("conditional race produced an unknown or invalid outcome")
		}
	}
	if winners != 1 {
		t.Fatal("conditional race did not preserve exactly one writer")
	}
	winningObject, err := store.Get(ctx, conditionalKey)
	if err != nil {
		t.Fatal("read conditional winner")
	}
	winningBytes, readErr := io.ReadAll(io.LimitReader(winningObject.Body, 5))
	closeErr = winningObject.Body.Close()
	if readErr != nil || closeErr != nil || len(winningBytes) != 4 || winningBytes[0] > 7 || winningBytes[1] != 31 || winningBytes[2] != 47 || winningBytes[3] != 79 {
		t.Fatal("conditional winner corrupted")
	}
	if err = store.Delete(ctx, conditionalKey); err != nil {
		t.Fatal("delete conditional fixture")
	}
	evidence.Passed = append(evidence.Passed, "conditional_probe", "concurrent_exactly_one_writer")
	if phase == "verify" {
		evidence.Passed = append(evidence.Passed, "same_original_after_container_restart")
		cloudFileHTTPStorageContract(t, store, cfg, &evidence)
		if err = store.Delete(ctx, key); err != nil {
			t.Fatal("delete owned original")
		}
		if _, err = store.Head(ctx, key); !errors.Is(err, objectstore.ErrNotFound) {
			t.Fatal("deleted original still present")
		}
		evidence.Passed = append(evidence.Passed, "delete_and_not_found")
	}
	output := os.Getenv("ZEROAGENT_SEAWEEDFS_TEST_EVIDENCE_FILE")
	encoded, err := json.MarshalIndent(evidence, "", "  ")
	if output == "" || err != nil || strings.Contains(string(encoded), cfg.SecretAccessKey) || strings.Contains(string(encoded), cfg.AccessKeyID) || os.WriteFile(output, append(encoded, '\n'), 0600) != nil {
		t.Fatal("write safe local storage evidence")
	}
	t.Logf("SeaweedFS phase=%s verified_bytes=%d", phase, len(body))
}
