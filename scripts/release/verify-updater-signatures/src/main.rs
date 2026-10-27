use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{env, ffi::OsString, fs, path::PathBuf, process::ExitCode};

const PUBLIC_KEY_ENV: &str = "ZEROAGENT_UPDATER_PUBLIC_KEY";
const USAGE: &str = "Usage: verify-updater-signatures (--config <generated-tauri-config.json> | --public-key-env ZEROAGENT_UPDATER_PUBLIC_KEY) [--] <asset>...\nEach asset must have an adjacent <asset>.sig containing Tauri's base64-wrapped Minisign signature.";

enum KeySource {
    Config(PathBuf),
    Environment,
}

fn arguments() -> Result<(KeySource, Vec<PathBuf>), String> {
    let mut args = env::args_os().skip(1);
    let option = args.next().ok_or(USAGE)?;
    let value = args.next().ok_or(USAGE)?;
    let source = if option == "--config" {
        KeySource::Config(value.into())
    } else if option == "--public-key-env" && value == PUBLIC_KEY_ENV {
        KeySource::Environment
    } else {
        return Err(USAGE.into());
    };
    let mut assets = Vec::new();
    let mut literal_paths = false;
    for arg in args {
        if !literal_paths && arg == "--" {
            literal_paths = true;
        } else if !literal_paths && arg.to_string_lossy().starts_with("--") {
            return Err(USAGE.into());
        } else {
            assets.push(PathBuf::from(arg));
        }
    }
    if assets.is_empty() {
        return Err(USAGE.into());
    }
    Ok((source, assets))
}

fn public_key_value(source: KeySource) -> Result<String, String> {
    match source {
        KeySource::Config(path) => {
            let contents = fs::read(&path)
                .map_err(|e| format!("cannot read config {}: {e}", path.display()))?;
            let config: Value = serde_json::from_slice(&contents)
                .map_err(|e| format!("invalid config JSON: {e}"))?;
            config
                .pointer("/plugins/updater/pubkey")
                .and_then(Value::as_str)
                .filter(|key| !key.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| "config must contain nonempty plugins.updater.pubkey".into())
        }
        KeySource::Environment => env::var(PUBLIC_KEY_ENV)
            .ok()
            // Match the application's updater_public_key_override().
            .map(|key| key.trim().to_owned())
            .filter(|key| !key.is_empty())
            .ok_or_else(|| format!("{PUBLIC_KEY_ENV} must contain a public key")),
    }
}

fn decode_outer_base64(value: &str, label: &str) -> Result<String, String> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| format!("{label} must be Tauri outer-base64"))?;
    String::from_utf8(decoded).map_err(|_| format!("{label} must decode to UTF-8 Minisign text"))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn run() -> Result<(), String> {
    let (source, assets) = arguments()?;
    let public_key_text = decode_outer_base64(&public_key_value(source)?, "public key")?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|e| format!("invalid Minisign public key: {e}"))?;
    // Hash the public packet, excluding the untrusted comment and text encoding.
    let packet = STANDARD
        .decode(
            public_key_text
                .lines()
                .nth(1)
                .ok_or("missing public key packet")?,
        )
        .map_err(|_| "invalid public key packet")?;
    let public_key_sha256 = sha256(&packet);

    for asset in &assets {
        let mut signature_path: OsString = asset.as_os_str().to_owned();
        signature_path.push(".sig");
        let signature_path = PathBuf::from(signature_path);
        let signature_outer = fs::read_to_string(&signature_path)
            .map_err(|e| format!("cannot read signature {}: {e}", signature_path.display()))?;
        // Match create-tauri-updater-manifest.mjs when loading adjacent .sig files.
        let signature_text = decode_outer_base64(signature_outer.trim(), "signature")?;
        let signature = Signature::decode(&signature_text)
            .map_err(|e| format!("invalid Minisign signature for {}: {e}", asset.display()))?;
        let bytes =
            fs::read(asset).map_err(|e| format!("cannot read asset {}: {e}", asset.display()))?;

        // Match tauri-plugin-updater 2.10.1: decode both outer wrappers and allow
        // legacy Minisign signatures. The official crate also checks the signed
        // trusted comment; the SHA-256 below is only an audit identifier.
        public_key
            .verify(&bytes, &signature, true)
            .map_err(|e| format!("signature verification failed for {}: {e}", asset.display()))?;
        println!(
            "{}",
            json!({
                "event": "updater_signature_verified",
                "asset": asset,
                "sha256": sha256(&bytes),
                "public_key_sha256": public_key_sha256,
            })
        );
    }
    println!(
        "{}",
        json!({
            "event": "updater_signatures_verified",
            "assets": assets.len(),
            "public_key_sha256": public_key_sha256,
        })
    );
    Ok(())
}

fn main() -> ExitCode {
    if env::args_os().skip(1).eq([OsString::from("--help")]) {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!(
                "{}",
                json!({"event": "updater_signature_error", "message": message})
            );
            ExitCode::FAILURE
        }
    }
}
