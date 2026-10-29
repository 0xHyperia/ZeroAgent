package cloudbackup

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

type S3 struct {
	*objectstore.S3Store
	conditional *s3.Client
	bucket      string
	transport   *http.Transport
	probeStore  *objectstore.S3Store
	probeMu     sync.Mutex
	probeDone   chan struct{}
	probeErr    error
}

// NewS3 retains the application's explicit credential/endpoint validation and
// adds a conditional restore write gated by an actual provider capability probe.
func NewS3(cfg objectstore.Config) (*S3, error) {
	store, err := objectstore.New(cfg)
	if err != nil {
		return nil, err
	}
	if !store.Status().Enabled {
		store.Close()
		return nil, ErrInvalid
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.MaxResponseHeaderBytes = 32 << 10
	transport.ResponseHeaderTimeout = 20 * time.Second
	transport.MaxConnsPerHost = 4
	client := &http.Client{Transport: transport, Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	conditional := s3.New(s3.Options{BaseEndpoint: aws.String(cfg.Endpoint), Region: cfg.Region, Credentials: credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, ""), HTTPClient: client, UsePathStyle: true, Retryer: retry.NewStandard(func(options *retry.StandardOptions) { options.MaxAttempts = 1 })})
	return &S3{S3Store: store, probeStore: store, conditional: conditional, bucket: cfg.Bucket, transport: transport}, nil
}
func (s *S3) Close() { s.S3Store.Close(); s.transport.CloseIdleConnections() }
func (s *S3) PutIfAbsent(ctx context.Context, key string, input io.ReadSeeker, size int64, options objectstore.PutOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	checksum, err := hex.DecodeString(options.SHA256)
	if err != nil || len(checksum) != 32 || size < 0 || size > 32<<20 || input == nil || !validRestoreWriteKey(key) || strings.HasPrefix(key, restoreWriteProbePrefix) {
		return ErrInvalid
	}
	if err = s.CheckRestoreWriteSemantics(ctx); err != nil {
		return err
	}
	return s.rawConditionalPut(ctx, key, input, size, options)
}

// rawConditionalPut is private: only the capability probe may bypass the gate.
func (s *S3) rawConditionalPut(ctx context.Context, key string, input io.ReadSeeker, size int64, options objectstore.PutOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	checksum, err := hex.DecodeString(options.SHA256)
	if err != nil || len(checksum) != 32 {
		return ErrInvalid
	}
	metadata := make(map[string]string, len(options.Metadata)+1)
	for key, value := range options.Metadata {
		metadata[key] = value
	}
	metadata["sha256"] = options.SHA256
	_, err = s.conditional.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key), Body: input, ContentLength: aws.Int64(size), ContentType: aws.String(options.ContentType), Metadata: metadata, ChecksumSHA256: aws.String(base64.StdEncoding.EncodeToString(checksum)), IfNoneMatch: aws.String("*")})
	if err != nil {
		var response *smithyhttp.ResponseError
		if errors.As(err, &response) && (response.HTTPStatusCode() == 412 || response.HTTPStatusCode() == 409) {
			return ErrTargetNotEmpty
		}
		return ErrWriteUnknown
	}
	return nil
}

const restoreWriteProbePrefix = "zeroagent-restore-write-probes/v1/"

var restoreWriteKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)

func validRestoreWriteKey(key string) bool {
	if len(key) > 1024 || !restoreWriteKeyPattern.MatchString(key) || strings.HasSuffix(key, "/") {
		return false
	}
	for _, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// CheckRestoreWriteSemantics attempts one context-bounded singleflight probe per
// client. A sticky unknown is not relabelled unsupported and is never retried
// with a fresh nonce by a later waiter. A new client is an explicit new attempt.
func (s *S3) CheckRestoreWriteSemantics(ctx context.Context) (result error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.probeMu.Lock()
	if s.probeDone != nil {
		done := s.probeDone
		s.probeMu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			s.probeMu.Lock()
			result = s.probeErr
			s.probeMu.Unlock()
			return result
		}
	}
	s.probeDone = make(chan struct{})
	s.probeMu.Unlock()
	// Keep waiters fail-closed even if an unexpected panic unwinds this leader.
	result = &ConditionalWriteError{Probe: ConditionalWriteProbe{Code: "conditional_writes_unconfirmed", CleanupCode: "probe_not_started"}, classification: ErrConditionalWritesUnconfirmed}
	defer func() { s.probeMu.Lock(); s.probeErr = result; close(s.probeDone); s.probeMu.Unlock() }()
	result = s.checkRestoreWriteSemantics(ctx)
	return result
}

type restoreWriteCanary struct {
	data    []byte
	options objectstore.PutOptions
}

func writeCanary(nonce, payload string) restoreWriteCanary {
	data := []byte("ZeroAgent restore write capability " + payload + "\n")
	digest := sha256.Sum256(data)
	return restoreWriteCanary{data: data, options: objectstore.PutOptions{ContentType: "application/octet-stream", SHA256: hex.EncodeToString(digest[:]), Metadata: map[string]string{"zeroagent-restore-probe": nonce, "probe-payload": payload}}}
}

func matchesCanary(info objectstore.ObjectInfo, canary restoreWriteCanary) bool {
	if info.Size != int64(len(canary.data)) || info.SHA256 != canary.options.SHA256 || info.ContentType != canary.options.ContentType || len(info.Metadata) != len(canary.options.Metadata)+1 || info.Metadata["sha256"] != canary.options.SHA256 {
		return false
	}
	for key, value := range canary.options.Metadata {
		if info.Metadata[key] != value {
			return false
		}
	}
	return true
}

func (s *S3) verifyCanary(ctx context.Context, key string, canary restoreWriteCanary) error {
	object, err := s.probeStore.Get(ctx, key)
	if err != nil {
		return err
	}
	data, readErr := io.ReadAll(io.LimitReader(object.Body, int64(len(canary.data))+1))
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || !matchesCanary(object.ObjectInfo, canary) || !bytes.Equal(data, canary.data) {
		return ErrIntegrity
	}
	return nil
}

// Cleanup is intentionally not described as atomic compare-and-delete. The
// reserved 256-bit key, nonce metadata and full known payload restrict deletion
// to this fresh canary. An unexpected competing object is retained, not erased.
func (s *S3) cleanupCanary(ctx context.Context, key string, original, replacement restoreWriteCanary, proof *ConditionalWriteProbe) {
	info, err := s.probeStore.Head(ctx, key)
	if missingObject(err) {
		proof.CleanupConfirmed = true
		proof.CleanupCode = "probe_confirmed_absent"
		proof.ObservedPayload = "absent"
		return
	}
	if err != nil {
		proof.CleanupCode = "probe_head_unconfirmed"
		return
	}
	var candidate *restoreWriteCanary
	if matchesCanary(info, original) {
		candidate = &original
		proof.ObservedPayload = "original"
	} else if matchesCanary(info, replacement) {
		candidate = &replacement
		proof.ObservedPayload = "replacement"
	}
	if candidate == nil || s.verifyCanary(ctx, key, *candidate) != nil {
		proof.CleanupCode = "probe_ownership_or_bytes_unconfirmed"
		return
	}
	if s.probeStore.Delete(ctx, key) != nil {
		proof.CleanupCode = "probe_delete_unconfirmed"
		return
	}
	if _, err = s.probeStore.Head(ctx, key); !missingObject(err) {
		proof.CleanupCode = "probe_delete_not_confirmed"
		return
	}
	proof.CleanupConfirmed = true
	proof.CleanupCode = "probe_deleted_and_absent"
}

func (s *S3) checkRestoreWriteSemantics(ctx context.Context) (result error) {
	checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	proof := ConditionalWriteProbe{Code: "conditional_writes_unconfirmed", CleanupCode: "probe_not_written"}
	nonceBytes := make([]byte, 32)
	if _, err := rand.Read(nonceBytes); err != nil {
		return &ConditionalWriteError{Probe: proof, classification: ErrConditionalWritesUnconfirmed}
	}
	nonce := hex.EncodeToString(nonceBytes)
	proof.ProbeKey = restoreWriteProbePrefix + nonce
	original, replacement := writeCanary(nonce, "original"), writeCanary(nonce, "replacement")
	classification := ErrConditionalWritesUnconfirmed
	defer func() {
		if proof.CleanupRequired {
			cleanupCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			s.cleanupCanary(cleanupCtx, proof.ProbeKey, original, replacement, &proof)
			stop()
		}
		if result == nil && proof.CleanupConfirmed {
			return
		}
		if result == nil {
			classification = ErrConditionalWritesUnconfirmed
			proof.Code = "conditional_writes_unconfirmed"
		}
		result = &ConditionalWriteError{Probe: proof, classification: classification}
	}()
	if _, err := s.probeStore.Head(checkCtx, proof.ProbeKey); !missingObject(err) {
		return ErrConditionalWritesUnconfirmed
	}
	proof.CleanupRequired = true
	if err := s.rawConditionalPut(checkCtx, proof.ProbeKey, bytes.NewReader(original.data), int64(len(original.data)), original.options); err != nil {
		return ErrConditionalWritesUnconfirmed
	}
	if err := s.verifyCanary(checkCtx, proof.ProbeKey, original); err != nil {
		return ErrConditionalWritesUnconfirmed
	}
	err := s.rawConditionalPut(checkCtx, proof.ProbeKey, bytes.NewReader(replacement.data), int64(len(replacement.data)), replacement.options)
	if err == nil {
		classification = ErrConditionalWritesUnsupported
		proof.Code = "conditional_writes_unsupported"
		return ErrConditionalWritesUnsupported
	}
	if !errors.Is(err, ErrTargetNotEmpty) {
		return ErrConditionalWritesUnconfirmed
	}
	if err = s.verifyCanary(checkCtx, proof.ProbeKey, original); err != nil {
		return ErrConditionalWritesUnconfirmed
	}
	return nil
}
