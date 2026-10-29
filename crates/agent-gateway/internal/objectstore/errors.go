package objectstore

import (
	"context"
	"errors"
	"net/http"

	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

var (
	ErrDisabled        = errors.New("object storage is not configured")
	ErrInvalidConfig   = errors.New("object storage configuration is invalid")
	ErrInvalidKey      = errors.New("object storage key is invalid")
	ErrInvalidInput    = errors.New("object storage input is invalid")
	ErrInvalidMetadata = errors.New("object storage metadata is invalid")
	ErrTooLarge        = errors.New("object exceeds the storage size limit")
	ErrLengthMismatch  = errors.New("object length does not match its declared size")
	ErrIntegrity       = errors.New("object checksum does not match")
	ErrNotFound        = errors.New("object was not found")
	ErrAccessDenied    = errors.New("object storage access was denied")
	ErrThrottled       = errors.New("object storage is rate limited")
	ErrUnavailable     = errors.New("object storage is unavailable")
)

// Public failures deliberately do not wrap SDK errors. An S3-compatible server
// may reflect credentials, signed URLs or submitted metadata in its error body.
func safeError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	var apiError smithy.APIError
	if errors.As(err, &apiError) {
		switch apiError.ErrorCode() {
		case "NoSuchKey", "NoSuchBucket", "NotFound", "404":
			return ErrNotFound
		case "AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken":
			return ErrAccessDenied
		case "SlowDown", "Throttling", "ThrottlingException", "TooManyRequests":
			return ErrThrottled
		case "BadDigest", "InvalidDigest", "XAmzContentSHA256Mismatch":
			return ErrIntegrity
		case "EntityTooLarge":
			return ErrTooLarge
		}
	}
	var responseError *smithyhttp.ResponseError
	if errors.As(err, &responseError) {
		switch responseError.HTTPStatusCode() {
		case http.StatusNotFound:
			return ErrNotFound
		case http.StatusUnauthorized, http.StatusForbidden:
			return ErrAccessDenied
		case http.StatusTooManyRequests:
			return ErrThrottled
		}
	}
	return ErrUnavailable
}
