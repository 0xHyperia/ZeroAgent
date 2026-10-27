# Tauri updater signature verification

Independent release tooling; this package has its own workspace and lockfile.
It does not change the application's dependencies or signing identity.

From the repository root:

```sh
cargo test --locked --manifest-path scripts/release/verify-updater-signatures/Cargo.toml

cargo run --locked --manifest-path scripts/release/verify-updater-signatures/Cargo.toml -- \
  --config generated-tauri-config.json path/to/installer.exe path/to/application.tar.gz

cargo run --locked --manifest-path scripts/release/verify-updater-signatures/Cargo.toml -- \
  --public-key-env ZEROAGENT_UPDATER_PUBLIC_KEY path/to/probe
```

Choose exactly one public-key source. `--config` reads
`plugins.updater.pubkey` from the generated JSON configuration; it does not merge
overlays itself. The environment option accepts only
`ZEROAGENT_UPDATER_PUBLIC_KEY`. The program never reads private-key variables,
generates keys, signs assets, installs packages, or contacts a network service.
Cargo may download locked dependencies when building for the first time.

Supply one or more actual asset paths; each must have an adjacent `<asset>.sig`.
Both the configured public key and `.sig` contents must use Tauri's outer
standard-base64 wrapper around UTF-8 Minisign text. Leading/trailing whitespace
around `.sig` wrappers is trimmed as in the release manifest generator;
public-key environment values are trimmed as in the application's override.
Configuration public keys are decoded verbatim, matching the plugin's static
configuration behavior. Raw Minisign files are not accepted as Tauri signatures.
Use `--` before asset paths that begin with `--`.

Verification matches `tauri-plugin-updater` **2.10.1** in the application's
root lockfile: decode both outer wrappers, use `PublicKey::decode` and
`Signature::decode`, then `PublicKey::verify(asset_bytes, signature, true)`.
The verifier is the same official **minisign-verify 0.2.5**, pinned exactly;
there is no local Ed25519 implementation. The signed trusted comment is also
verified. SHA-256 identifies the bytes checked; it is not used in place of
signature verification. Assets are read into memory, matching the updater.

Successful stdout is JSON Lines: one `updater_signature_verified` record per
asset with `asset`, `sha256`, and `public_key_sha256`, followed by one
`updater_signatures_verified` record with `assets` and `public_key_sha256`.
The public-key fingerprint is SHA-256 of the decoded 42-byte Minisign public-key
packet, excluding its untrusted comment. Public-key values are never printed.
Any error writes an `updater_signature_error` JSON record to stderr and exits 1;
success exits 0. Earlier asset records may precede a later failure, so always
check the exit status and require the final summary before accepting a batch.

Run this against a newly signed probe before the expensive bundle build, then
against every staged updater asset after bundling. This confirms the supplied
public key and actual `.sig` files agree; runtime key selection and operating
system code signing are separate checks.

The checked-in CLI tests use the official crate's public legacy/prehashed
vectors and reject modified assets, changed public-key material with the same
key ID, changed signatures, changed trusted comments, invalid encoding, missing
signatures, and invalid CLI/configuration inputs. See
[`tests/fixtures/NOTICE.md`](tests/fixtures/NOTICE.md) for provenance and license.
No production keys or private signing fixtures are included.
