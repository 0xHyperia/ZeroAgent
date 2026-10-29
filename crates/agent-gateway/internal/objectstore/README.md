# CloudChat object storage

`ConfigFromEnv(os.Getenv)` reads only `ZEROAGENT_OBJECT_STORAGE_ENDPOINT`,
`BUCKET`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` and the optional
`MAX_BYTES` / `ALLOW_LOOPBACK_HTTP` settings with that same prefix. It never
loads AWS profiles, ambient AWS credentials, proxy settings or metadata services.

`New(Config)` constructs a client without accessing the endpoint. Missing
configuration produces a disabled store whose `Status()` lists only missing
setting names. Invalid complete configuration returns a safe error. The caller
owns the store and calls `Close()` when its service stops.

When configured, Gateway readiness additionally calls `Ready(ctx)`: a signed,
two-second bounded `HeadBucket`, without creating an object. Grant the service
account bucket metadata permission as well as its application-prefix object
permissions. An unavailable/denied bucket fails readiness with a sanitized error;
an unconfigured development feature remains disabled.

The adapter uses AWS SDK for Go v2 with explicit static credentials,
`BaseEndpoint`, path-style addressing, ordinary TLS verification, no redirects,
bounded retries, operation timeouts and bounded response headers. Plain HTTP is
accepted only with explicit opt-in and a numeric loopback host, for isolated
development/tests. The endpoint must be a root URL without credentials, query,
fragment or path prefix.

## Ownership and keys

The account service must authenticate the user and resolve a file ID to an opaque
server-generated key before calling this package. These operations do not grant
ownership from a browser-supplied key or S3 metadata. Keys are bounded ASCII
resource paths without traversal, percent escapes, backslashes or empty segments;
the original display filename belongs in the account database, not in the key.

## Upload and verification

`Put` requires a declared byte length, independently measures it and computes
SHA-256 before any upload. Seekable inputs are reused from their original offset;
other inputs are staged in bounded private temporary files and removed by the
owning call. Four uploads per store can be staged/executed simultaneously. The
caller should also apply account quotas and a request concurrency limit.

`PresignUpload` requires a positive length, expected SHA-256 and a TTL of at most
15 minutes (default five minutes). The SDK signs the exact content length, MIME
type, checksum and metadata headers. Browsers supply content length from their
File/Blob; it is not returned as a manually settable header. The resulting object
must remain quarantined until `Verify` has read and hashed it against the file
record's expected size/digest. `Head` metadata alone is not proof of its bytes.
Empty files can use the server-side `Put` path.

Uploads use single-object PUT, not multipart or unbounded transfer-manager
buffering. The default object limit is 64 MiB and the configuration maximum is
1 GiB. A failed or timed-out PUT may have reached the server: reconcile the same
immutable key with `Head`/`Verify`, retaining the original operation identity.

`Get` bounds declared response length and reads, checks SHA-256 when metadata
provides it, and reports truncated/corrupt bodies. Read through EOF and always
close the body. `Verify` additionally checks the digest expected by the account
file record. Partial reads do not establish integrity. Download capabilities force
attachment disposition; active-content preview belongs on an isolated origin.

## Evidence and limits

Run `go test ./internal/objectstore` and `go vet ./internal/objectstore` from the
Gateway module. Tests use real SDK signing/serialization against isolated
`httptest` S3 protocol fixtures. They cover explicit credentials, path-style
operations, size/hash/metadata limits, presigning, provider error sanitization,
redirect refusal, truncated downloads, cancellation and upload staging cleanup.

No real S3 account, bucket, credential or paid service was used. Provider-specific
checksum enforcement, CORS, lifecycle, backup and production throughput remain
real-service acceptance items. The protocol fixture checks signed constraints;
it is not a replacement S3 signature verifier.

References: [AWS endpoint configuration](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/configure-endpoints.html),
[S3 upload utilities](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/sdk-utilities-s3.html),
[official Go v2 S3 examples](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/go_s3_code_examples.html).
