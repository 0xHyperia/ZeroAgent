package objectstore

import (
	"context"
	"errors"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// InitializeBucket is an explicit deployment operation, never a Gateway startup
// fallback. It creates only the configured bucket and does not change existing
// contents, policies or credentials. Ordinary requests retain the Store API.
func (s *S3Store) InitializeBucket(ctx context.Context) error {
	if s == nil || !s.status.Enabled {
		return ErrDisabled
	}
	if err := s.Ready(ctx); err == nil {
		return nil
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	// One attempt: an unknown write is reported for explicit inspection, not
	// retried against another target or with weaker credentials.
	_, err := s.client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(s.cfg.Bucket)}, func(options *s3.Options) {
		options.RetryMaxAttempts = 1
	})
	if err != nil {
		return safeError(err)
	}
	return s.Ready(ctx)
}
