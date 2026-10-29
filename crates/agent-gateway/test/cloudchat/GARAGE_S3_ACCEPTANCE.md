# Disposable real S3 acceptance

From PowerShell 7, run `./test/cloudchat/garage-s3-acceptance.ps1` in the Gateway
module. It requires the already-pulled official `dxflrs/garage:v2.5.0` image at
the recorded digest, the Go toolchain, and the existing local executor image.
The script compiles a static Linux test binary and uses that image to initialize
a new task-labelled volume and run the binary as UID 10001. It does not build or
pull images, install tools, invoke E2B, or use external storage.

The script creates one random task-labelled internal network, volume and
unprivileged Garage container. The test runner shares that container's network
namespace and connects to S3 on loopback; no host, admin or RPC ports are
published. Generated credentials stay in ACL-restricted private files. After signed
32 MiB uploads it actually restarts that container, verifies identical full-body
SHA-256, metadata and distinct owner keys, checks invalid signatures are denied,
then exercises production account file upload/download/delete HTTP handlers.
It removes resources only after checking their exact task label. After the
temporary server and its keys are destroyed, private configuration files are
overwritten with a retirement marker. Public evidence is retained under the ignored
`.codex-artifacts/garage-s3-<task-id>/` folder.

S3 header metadata is ASCII under the production adapter contract. The test
checks direct Unicode headers are rejected and explicitly base64-encoded UTF-8
descriptive metadata survives storage. Chinese canonical display filenames are
separately verified through the real account file resource API. Object keys and
metadata never establish user ownership; the HTTP account guard does.

`TestGarageS3Compatibility` is skipped unless the script supplies its explicit
private loopback configuration. The `prepare` and `verify` phases fail on absent
or cropped objects, bad metadata, invalid signature acceptance, foreign account
access, leaked keys/cookies, or unconfirmed deletion. `provenance.json` records
official image digest/version, process restart, isolation and guarded cleanup;
phase JSON records only checks, byte counts and hashes.

This local single-node Garage test proves interoperability with this real S3
implementation. It does not validate remote provider IAM, TLS, CORS, redundancy,
backups, production throughput or SLA, and does not select a production vendor.

Separate focused restore tests found that Garage v2.5.0 accepted a conflicting
`If-None-Match: *` PUT. Ordinary file interoperability above must not be presented
as acceptance of atomic restore writes. The backup CLI now tests the target's
actual conditional-write semantics on an isolated private canary before formal
database/object restoration and rejects unsupported or unconfirmed results.
This Garage version is not an accepted target for that restore contract.

Official source: [Garage Quick Start](https://garagehq.deuxfleurs.fr/documentation/quick-start/),
which documents v2.5.0, explicit default access credentials and the
`server --single-node --default-bucket` bootstrap flags. This single-node setup
is an acceptance fixture rather than a redundant production deployment.
