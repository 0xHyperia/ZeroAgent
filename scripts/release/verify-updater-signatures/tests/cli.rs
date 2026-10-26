use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

const PUBLIC_KEY: &str = include_str!("fixtures/public-key.minisign");
const PREHASHED: &str = include_str!("fixtures/prehashed.minisig");
const LEGACY: &str = include_str!("fixtures/legacy.minisig");
const PUBLIC_KEY_ENV: &str = "LIVEAGENT_UPDATER_PUBLIC_KEY";
static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    directory: PathBuf,
    asset: PathBuf,
    signature: PathBuf,
    config: PathBuf,
}

impl Fixture {
    fn new(signature: &str) -> Self {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-fixtures")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&directory).unwrap();
        let fixture = Self {
            asset: directory.join("golden asset.bin"),
            signature: directory.join("golden asset.bin.sig"),
            config: directory.join("generated-tauri-config.json"),
            directory,
        };
        fs::write(&fixture.asset, b"test").unwrap();
        fs::write(&fixture.signature, STANDARD.encode(signature)).unwrap();
        fs::write(
            &fixture.config,
            json!({"plugins": {"updater": {"pubkey": STANDARD.encode(PUBLIC_KEY)}}}).to_string(),
        )
        .unwrap();
        fixture
    }

    fn command(&self) -> Command {
        Command::new(env!("CARGO_BIN_EXE_verify-updater-signatures"))
    }

    fn verify(&self) -> Output {
        self.command()
            .arg("--config")
            .arg(&self.config)
            .arg(&self.asset)
            .output()
            .unwrap()
    }
}

fn rejected(output: Output) {
    assert!(!output.status.success(), "invalid input was accepted");
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["event"], "updater_signature_error");
    assert!(!String::from_utf8_lossy(&output.stdout)
        .contains("\"event\":\"updater_signatures_verified\""));
}

#[test]
fn official_prehashed_vector_passes_through_generated_config() {
    let fixture = Fixture::new(PREHASHED);
    let output = fixture.verify();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["event"], "updater_signature_verified");
    assert_eq!(
        lines[0]["sha256"],
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    );
    assert_eq!(
        lines[0]["public_key_sha256"],
        "8b9c38506fa59539ef0d1d25889cc19d2ea67c36ad402067c0d5bcc866c727cd"
    );
    assert_eq!(lines[1]["event"], "updater_signatures_verified");
    assert_eq!(lines[1]["assets"], 1);
}

#[test]
fn official_legacy_vector_passes_through_public_key_environment() {
    let fixture = Fixture::new(LEGACY);
    let output = fixture
        .command()
        .args(["--public-key-env", PUBLIC_KEY_ENV])
        .env(PUBLIC_KEY_ENV, STANDARD.encode(PUBLIC_KEY))
        .arg(&fixture.asset)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(PUBLIC_KEY.lines().nth(1).unwrap()));
}

#[test]
fn tampered_asset_is_rejected() {
    let fixture = Fixture::new(PREHASHED);
    fs::write(&fixture.asset, b"Test").unwrap();
    rejected(fixture.verify());
}

#[test]
fn different_public_key_with_same_key_id_is_rejected() {
    let fixture = Fixture::new(PREHASHED);
    let mut packet = STANDARD.decode(PUBLIC_KEY.lines().nth(1).unwrap()).unwrap();
    packet[10] ^= 1; // Preserve the key ID; force the cryptographic verification path.
    let wrong_key = format!(
        "untrusted comment: altered public test key\n{}\n",
        STANDARD.encode(packet)
    );
    rejected(
        fixture
            .command()
            .args(["--public-key-env", PUBLIC_KEY_ENV])
            .env(PUBLIC_KEY_ENV, STANDARD.encode(wrong_key))
            .arg(&fixture.asset)
            .output()
            .unwrap(),
    );
}

#[test]
fn corrupted_signature_packet_is_rejected() {
    let fixture = Fixture::new(PREHASHED);
    let mut lines: Vec<String> = PREHASHED.lines().map(str::to_owned).collect();
    let mut packet = STANDARD.decode(&lines[1]).unwrap();
    packet[10] ^= 1;
    lines[1] = STANDARD.encode(packet);
    fs::write(&fixture.signature, STANDARD.encode(lines.join("\n"))).unwrap();
    rejected(fixture.verify());
}

#[test]
fn tampered_trusted_comment_is_rejected() {
    let fixture = Fixture::new(PREHASHED);
    fs::write(
        &fixture.signature,
        STANDARD.encode(PREHASHED.replace("file:test", "file:changed")),
    )
    .unwrap();
    rejected(fixture.verify());
}

#[test]
fn malformed_outer_base64_is_rejected() {
    let fixture = Fixture::new(PREHASHED);
    fs::write(&fixture.signature, "not-base64!").unwrap();
    rejected(fixture.verify());
}

#[test]
fn missing_signature_is_rejected() {
    let fixture = Fixture::new(PREHASHED);
    fs::remove_file(&fixture.signature).unwrap();
    rejected(fixture.verify());
}

#[test]
fn every_supplied_asset_must_verify() {
    let fixture = Fixture::new(PREHASHED);
    let second = fixture.directory.join("second.bin");
    fs::write(&second, b"tampered").unwrap();
    fs::write(
        fixture.directory.join("second.bin.sig"),
        STANDARD.encode(PREHASHED),
    )
    .unwrap();
    let output = fixture
        .command()
        .arg("--config")
        .arg(&fixture.config)
        .arg(&fixture.asset)
        .arg(&second)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&output.stdout)
        .contains("\"event\":\"updater_signature_verified\""));
    rejected(output);
}

#[test]
fn both_key_sources_are_rejected() {
    let fixture = Fixture::new(PREHASHED);
    rejected(
        fixture
            .command()
            .arg("--config")
            .arg(&fixture.config)
            .args(["--public-key-env", PUBLIC_KEY_ENV])
            .arg(&fixture.asset)
            .output()
            .unwrap(),
    );
}

#[test]
fn arbitrary_environment_variable_names_are_rejected() {
    let fixture = Fixture::new(PREHASHED);
    rejected(
        fixture
            .command()
            .args(["--public-key-env", "TAURI_SIGNING_PRIVATE_KEY"])
            .arg(&fixture.asset)
            .output()
            .unwrap(),
    );
}

#[test]
fn no_assets_are_rejected() {
    let fixture = Fixture::new(PREHASHED);
    rejected(
        fixture
            .command()
            .arg("--config")
            .arg(&fixture.config)
            .output()
            .unwrap(),
    );
}

#[test]
fn missing_config_public_key_is_rejected() {
    let fixture = Fixture::new(PREHASHED);
    fs::write(&fixture.config, "{}").unwrap();
    rejected(fixture.verify());
}

#[test]
fn config_public_key_is_not_silently_trimmed() {
    let fixture = Fixture::new(PREHASHED);
    fs::write(
        &fixture.config,
        json!({"plugins": {"updater": {"pubkey": format!(" {}\n", STANDARD.encode(PUBLIC_KEY))}}})
            .to_string(),
    )
    .unwrap();
    rejected(fixture.verify());
}

#[test]
fn environment_public_key_is_trimmed_like_the_application_override() {
    let fixture = Fixture::new(PREHASHED);
    let output = fixture
        .command()
        .args(["--public-key-env", PUBLIC_KEY_ENV])
        .env(
            PUBLIC_KEY_ENV,
            format!(" {}\n", STANDARD.encode(PUBLIC_KEY)),
        )
        .arg(&fixture.asset)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn signature_wrapper_is_trimmed_like_the_release_manifest_generator() {
    let fixture = Fixture::new(PREHASHED);
    fs::write(
        &fixture.signature,
        format!(" {}\n", STANDARD.encode(PREHASHED)),
    )
    .unwrap();
    let output = fixture.verify();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
