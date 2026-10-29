package objectstore

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go/logging"
)

type PutOptions struct {
	ContentType string
	// SHA256, when supplied, is the expected lowercase or uppercase hex digest.
	// Put computes it independently; PresignUpload requires it and signs it.
	SHA256   string
	Metadata map[string]string
}

type ObjectInfo struct {
	Size        int64
	ContentType string
	ETag        string
	SHA256      string
	Metadata    map[string]string
}

type Object struct {
	ObjectInfo
	// Always close Body. Reading through EOF validates length and an available
	// SHA-256. A partial read is not an integrity proof.
	Body io.ReadCloser
}

type PresignedRequest struct {
	URL       string              `json:"url"`
	Method    string              `json:"method"`
	Headers   map[string][]string `json:"headers"`
	ExpiresAt time.Time           `json:"expires_at"`
	Size      int64               `json:"size,omitempty"`
}

func (PresignedRequest) String() string   { return "objectstore.PresignedRequest(redacted)" }
func (PresignedRequest) GoString() string { return "objectstore.PresignedRequest(redacted)" }

type Store interface {
	Put(context.Context, string, io.Reader, int64, PutOptions) (ObjectInfo, error)
	Get(context.Context, string) (*Object, error)
	Head(context.Context, string) (ObjectInfo, error)
	Delete(context.Context, string) error
	PresignUpload(context.Context, string, int64, PutOptions, time.Duration) (PresignedRequest, error)
	PresignDownload(context.Context, string, string, time.Duration) (PresignedRequest, error)
}

type S3Store struct {
	cfg       Config
	status    Status
	client    *s3.Client
	presigner *s3.PresignClient
	transport *http.Transport
	uploads   chan struct{}
}

var _ Store = (*S3Store)(nil)

// New never makes a network request and never loads ambient AWS credentials.
// Incomplete configuration creates a disabled store with a safe diagnostic.
func New(input Config) (*S3Store, error) {
	cfg, status, err := normalizedConfig(input)
	if err != nil {
		return nil, err
	}
	store := &S3Store{cfg: cfg, status: status, uploads: make(chan struct{}, 4)}
	if !status.Enabled {
		return store, nil
	}
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:      true,
		MaxIdleConns:           32,
		MaxIdleConnsPerHost:    16,
		MaxConnsPerHost:        32,
		IdleConnTimeout:        60 * time.Second,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  20 * time.Second,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: 32 << 10,
	}
	store.transport = transport
	store.client = s3.New(s3.Options{
		BaseEndpoint: aws.String(cfg.Endpoint),
		Region:       cfg.Region,
		Credentials: aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider(
			cfg.AccessKeyID, cfg.SecretAccessKey, "",
		)),
		HTTPClient: &http.Client{
			Transport: transport,
			Timeout:   cfg.RequestTimeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		UsePathStyle:                              true,
		DisableMultiRegionAccessPoints:            true,
		DisableS3ExpressSessionAuth:               aws.Bool(true),
		ContinueHeaderThresholdBytes:              -1,
		RequestChecksumCalculation:                aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation:                aws.ResponseChecksumValidationWhenRequired,
		DisableLogOutputChecksumValidationSkipped: true,
		Logger: logging.Nop{},
		Retryer: retry.NewStandard(func(options *retry.StandardOptions) {
			options.MaxAttempts = 2
			options.MaxBackoff = 200 * time.Millisecond
		}),
	})
	store.presigner = s3.NewPresignClient(store.client, func(options *s3.PresignOptions) {
		// Keep integrity/metadata constraints in signed headers. Hoisted checksum
		// query parameters have not been enforced uniformly by S3-compatible servers.
		options.Presigner = v4.NewSigner(func(signer *v4.SignerOptions) {
			signer.DisableHeaderHoisting = true
			signer.DisableURIPathEscaping = true
		})
	})
	return store, nil
}

func (s *S3Store) String() string   { return "objectstore.S3Store" }
func (s *S3Store) GoString() string { return "objectstore.S3Store" }

func (s *S3Store) Status() Status {
	if s == nil {
		return Status{Reason: "missing_configuration"}
	}
	status := s.status
	status.Missing = append([]string(nil), status.Missing...)
	return status
}

func (s *S3Store) Close() {
	if s != nil && s.transport != nil {
		s.transport.CloseIdleConnections()
	}
}

// Ready verifies the configured bucket using a signed HEAD. It never allocates
// an object or exports a capability URL. Deployment credentials need bucket
// metadata permission in addition to access to the application's object prefix.
func (s *S3Store) Ready(ctx context.Context) error {
	if s == nil || !s.status.Enabled {
		return ErrDisabled
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.cfg.Bucket)})
	return safeError(err)
}

func (s *S3Store) check(key string) error {
	if s == nil || !s.status.Enabled {
		return ErrDisabled
	}
	return validateKey(key)
}

func normalizeSHA(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if len(value) != sha256.Size*2 {
		return "", ErrIntegrity
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return "", ErrIntegrity
	}
	return strings.ToLower(value), nil
}

func uploadMetadata(options PutOptions, digest string) (string, map[string]string, error) {
	contentType := options.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if len(contentType) > 255 || strings.ContainsAny(contentType, "\r\n\x00") {
		return "", nil, ErrInvalidMetadata
	}
	if _, _, err := mime.ParseMediaType(contentType); err != nil {
		return "", nil, ErrInvalidMetadata
	}
	if len(options.Metadata) > 15 {
		return "", nil, ErrInvalidMetadata
	}
	metadata := make(map[string]string, len(options.Metadata)+1)
	size := 6 + len(digest)
	for key, value := range options.Metadata {
		if key != strings.ToLower(key) || !metaPattern.MatchString(key) || len(value) > 512 {
			return "", nil, ErrInvalidMetadata
		}
		for _, char := range value {
			if char < 32 || char > 126 {
				return "", nil, ErrInvalidMetadata
			}
		}
		if key == "sha256" && value != digest {
			return "", nil, ErrInvalidMetadata
		}
		size += len(key) + len(value)
		if size > 2048 {
			return "", nil, ErrInvalidMetadata
		}
		metadata[key] = value
	}
	metadata["sha256"] = digest
	return contentType, metadata, nil
}

func checksumBase64(hexDigest string) string {
	digest, _ := hex.DecodeString(hexDigest)
	return base64.StdEncoding.EncodeToString(digest)
}

func (s *S3Store) Put(ctx context.Context, key string, body io.Reader, size int64, options PutOptions) (ObjectInfo, error) {
	if err := s.check(key); err != nil {
		return ObjectInfo{}, err
	}
	if body == nil || size < 0 {
		return ObjectInfo{}, ErrInvalidInput
	}
	if size > s.cfg.MaxObjectBytes {
		return ObjectInfo{}, ErrTooLarge
	}
	expected, err := normalizeSHA(options.SHA256)
	if err != nil {
		return ObjectInfo{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, s.cfg.RequestTimeout)
	defer cancel()
	select {
	case s.uploads <- struct{}{}:
		defer func() { <-s.uploads }()
	case <-ctx.Done():
		return ObjectInfo{}, ctx.Err()
	}
	prepared, digest, cleanup, err := prepareUpload(ctx, body, size, s.cfg.TempDir)
	if err != nil {
		return ObjectInfo{}, err
	}
	defer cleanup()
	if expected != "" && expected != digest {
		return ObjectInfo{}, ErrIntegrity
	}
	contentType, metadata, err := uploadMetadata(options, digest)
	if err != nil {
		return ObjectInfo{}, err
	}
	output, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.cfg.Bucket), Key: aws.String(key), Body: prepared,
		ContentLength: aws.Int64(size), ContentType: aws.String(contentType), Metadata: metadata,
		ChecksumAlgorithm: types.ChecksumAlgorithmSha256, ChecksumSHA256: aws.String(checksumBase64(digest)),
	})
	if err != nil {
		return ObjectInfo{}, safeError(err)
	}
	if returned := aws.ToString(output.ChecksumSHA256); returned != "" && returned != checksumBase64(digest) {
		return ObjectInfo{}, ErrIntegrity
	}
	return ObjectInfo{Size: size, ContentType: contentType, SHA256: digest, Metadata: metadata, ETag: aws.ToString(output.ETag)}, nil
}

func (s *S3Store) Get(ctx context.Context, key string) (*Object, error) {
	if err := s.check(key); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, s.cfg.RequestTimeout)
	output, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.cfg.Bucket), Key: aws.String(key)})
	if err != nil {
		cancel()
		return nil, safeError(err)
	}
	info, err := s.objectInfo(output.ContentLength, output.ContentType, output.ETag, output.Metadata)
	if err != nil || output.Body == nil {
		if output.Body != nil {
			_ = output.Body.Close()
		}
		cancel()
		if err == nil {
			err = ErrUnavailable
		}
		return nil, err
	}
	return &Object{ObjectInfo: info, Body: newCheckedBody(ctx, output.Body, info.Size, info.SHA256, cancel)}, nil
}

func (s *S3Store) Head(ctx context.Context, key string) (ObjectInfo, error) {
	if err := s.check(key); err != nil {
		return ObjectInfo{}, err
	}
	output, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.cfg.Bucket), Key: aws.String(key)})
	if err != nil {
		return ObjectInfo{}, safeError(err)
	}
	return s.objectInfo(output.ContentLength, output.ContentType, output.ETag, output.Metadata)
}

func (s *S3Store) objectInfo(length *int64, contentType, etag *string, metadata map[string]string) (ObjectInfo, error) {
	if length == nil || *length < 0 {
		return ObjectInfo{}, ErrLengthMismatch
	}
	if *length > s.cfg.MaxObjectBytes {
		return ObjectInfo{}, ErrTooLarge
	}
	digest, err := normalizeSHA(metadata["sha256"])
	if err != nil {
		return ObjectInfo{}, err
	}
	// Bound and validate metadata even when it arrived through a presigned
	// upload. It remains descriptive data, never an account ownership proof.
	if _, _, err := uploadMetadata(PutOptions{ContentType: aws.ToString(contentType), Metadata: metadata}, digest); err != nil {
		return ObjectInfo{}, err
	}
	copy := make(map[string]string, len(metadata))
	for key, value := range metadata {
		copy[key] = value
	}
	return ObjectInfo{Size: *length, ContentType: aws.ToString(contentType), ETag: aws.ToString(etag), SHA256: digest, Metadata: copy}, nil
}

func (s *S3Store) Delete(ctx context.Context, key string) error {
	if err := s.check(key); err != nil {
		return err
	}
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.cfg.Bucket), Key: aws.String(key)})
	return safeError(err)
}

// Verify must finish before a directly uploaded object leaves quarantine.
// Its expected values come from the authenticated file record, not Head metadata.
func (s *S3Store) Verify(ctx context.Context, key string, size int64, expectedSHA256 string) (ObjectInfo, error) {
	digest, err := normalizeSHA(expectedSHA256)
	if err != nil || digest == "" || size < 0 {
		return ObjectInfo{}, ErrInvalidInput
	}
	object, err := s.Get(ctx, key)
	if err != nil {
		return ObjectInfo{}, err
	}
	defer object.Body.Close()
	if object.Size != size {
		return ObjectInfo{}, ErrLengthMismatch
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, object.Body); err != nil {
		return ObjectInfo{}, err
	}
	if hex.EncodeToString(hasher.Sum(nil)) != digest {
		return ObjectInfo{}, ErrIntegrity
	}
	object.SHA256 = digest
	return object.ObjectInfo, nil
}

func (s *S3Store) PresignUpload(ctx context.Context, key string, size int64, options PutOptions, ttl time.Duration) (PresignedRequest, error) {
	if err := s.check(key); err != nil {
		return PresignedRequest{}, err
	}
	if size <= 0 {
		return PresignedRequest{}, ErrInvalidInput
	}
	if size > s.cfg.MaxObjectBytes {
		return PresignedRequest{}, ErrTooLarge
	}
	ttl, err := presignTTL(ttl)
	if err != nil {
		return PresignedRequest{}, err
	}
	digest, err := normalizeSHA(options.SHA256)
	if err != nil || digest == "" {
		return PresignedRequest{}, ErrInvalidInput
	}
	contentType, metadata, err := uploadMetadata(options, digest)
	if err != nil {
		return PresignedRequest{}, err
	}
	signed, err := s.presigner.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.cfg.Bucket), Key: aws.String(key), ContentLength: aws.Int64(size),
		ContentType: aws.String(contentType), Metadata: metadata,
		ChecksumAlgorithm: types.ChecksumAlgorithmSha256, ChecksumSHA256: aws.String(checksumBase64(digest)),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return PresignedRequest{}, safeError(err)
	}
	parsed, err := url.Parse(signed.URL)
	if err != nil {
		return PresignedRequest{}, ErrUnavailable
	}
	constraints := ";" + parsed.Query().Get("X-Amz-SignedHeaders") + ";"
	for _, required := range []string{"content-length", "content-type", "x-amz-checksum-sha256", "x-amz-meta-sha256"} {
		if !strings.Contains(constraints, ";"+required+";") {
			return PresignedRequest{}, ErrUnavailable
		}
	}
	headers := signed.SignedHeader.Clone()
	// Browsers derive these two forbidden headers from the URL and Blob. Their
	// exact values remain signed; the caller must upload precisely Size bytes.
	headers.Del("Host")
	headers.Del("Content-Length")
	return PresignedRequest{URL: signed.URL, Method: signed.Method, Headers: headers, ExpiresAt: time.Now().UTC().Add(ttl), Size: size}, nil
}

func (s *S3Store) PresignDownload(ctx context.Context, key, fileName string, ttl time.Duration) (PresignedRequest, error) {
	if err := s.check(key); err != nil {
		return PresignedRequest{}, err
	}
	ttl, err := presignTTL(ttl)
	if err != nil {
		return PresignedRequest{}, err
	}
	if fileName == "" {
		fileName = "download"
	}
	if len(fileName) > 255 || strings.ContainsAny(fileName, "\r\n\x00/\\") {
		return PresignedRequest{}, ErrInvalidInput
	}
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": fileName})
	if disposition == "" {
		return PresignedRequest{}, ErrInvalidInput
	}
	signed, err := s.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.cfg.Bucket), Key: aws.String(key),
		ResponseContentDisposition: aws.String(disposition),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return PresignedRequest{}, safeError(err)
	}
	headers := signed.SignedHeader.Clone()
	headers.Del("Host")
	return PresignedRequest{URL: signed.URL, Method: signed.Method, Headers: headers, ExpiresAt: time.Now().UTC().Add(ttl)}, nil
}
