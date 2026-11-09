//! Chrome Web Store packages are verified before anything reaches WebView2.
use std::{
    collections::HashSet,
    fs,
    io::{self, Cursor, Read},
    path::{Path, PathBuf},
    time::Duration,
};

use aws_lc_rs::signature::{self, ParsedPublicKey, VerificationAlgorithm};
use base64::{engine::general_purpose::STANDARD, Engine};
use prost::Message;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use url::Url;
use zip::ZipArchive;

const MAX_PACKAGE: usize = 64 * 1024 * 1024;
const MAX_UNPACKED: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST: u64 = 256 * 1024;
// Chromium's production CRX3 Web Store publisher SPKI SHA-256 (crx_verifier.cc).
const WEB_STORE_PUBLISHER: [u8; 32] = [
    0x61, 0xf7, 0xf2, 0xa6, 0xbf, 0xcf, 0x74, 0xcd, 0x0b, 0xc1, 0xfe, 0x24, 0x97, 0xcc, 0x9b, 0x04,
    0x25, 0x4c, 0x65, 0x8f, 0x79, 0xf2, 0x14, 0x53, 0x92, 0x86, 0x7e, 0xa8, 0x36, 0x63, 0x67, 0xcf,
];

#[derive(Message)]
struct CrxFileHeader {
    #[prost(message, repeated, tag = "2")]
    rsa: Vec<Proof>,
    #[prost(message, repeated, tag = "3")]
    ecdsa: Vec<Proof>,
    #[prost(bytes = "vec", tag = "10000")]
    signed_header_data: Vec<u8>,
}

#[derive(Message)]
struct Proof {
    #[prost(bytes = "vec", tag = "1")]
    public_key: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    signature: Vec<u8>,
}

#[derive(Message)]
struct SignedData {
    #[prost(bytes = "vec", tag = "1")]
    crx_id: Vec<u8>,
}

#[derive(Clone, Serialize)]
pub(super) struct StoreManifest {
    pub id: String,
    name: String,
    version: String,
    permissions: Vec<String>,
    #[serde(rename = "optionalPermissions")]
    optional_permissions: Vec<String>,
}

pub(super) struct StorePackage {
    pub manifest: StoreManifest,
    pub directory: TempDir,
    pub popup: Option<String>,
}

pub(super) fn extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| matches!(byte, b'a'..=b'p'))
}

pub(super) fn store_extension_id(input: &str) -> Option<String> {
    let url = Url::parse(input).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("chromewebstore.google.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    match url.path_segments()?.collect::<Vec<_>>().as_slice() {
        ["detail", id] | ["detail", _, id] if extension_id(id) => Some((*id).to_string()),
        _ => None,
    }
}

pub(super) async fn fetch(id: &str, runtime_version: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(35))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if attempt.previous().len() < 4
                && url.scheme() == "https"
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && matches!(
                    url.host_str(),
                    Some("clients2.google.com" | "clients2.googleusercontent.com")
                )
            {
                attempt.follow()
            } else {
                attempt.error("Untrusted Chrome Web Store redirect")
            }
        }))
        .build()
        .map_err(|_| "Could not start the Chrome Web Store request")?;
    let mut download = Url::parse("https://clients2.google.com/service/update2/crx")
        .map_err(|_| "Invalid Chrome Web Store endpoint")?;
    download
        .query_pairs_mut()
        .append_pair("response", "redirect")
        .append_pair("prodversion", runtime_version)
        .append_pair("acceptformat", "crx3")
        .append_pair("x", &format!("id={id}&uc"));
    let mut response = client
        .get(download)
        .send()
        .await
        .map_err(|_| "Could not download this Chrome Web Store extension")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("The Chrome Web Store did not provide this extension".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PACKAGE as u64)
    {
        return Err("The extension download is too large".into());
    }
    let mut package = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The extension download was interrupted")?
    {
        if chunk.len() > MAX_PACKAGE.saturating_sub(package.len()) {
            return Err("The extension download is too large".into());
        }
        package.extend_from_slice(&chunk);
    }
    Ok(package)
}

fn verify<'a>(package: &'a [u8], id: &str, publisher: [u8; 32]) -> Option<(&'a [u8], Vec<u8>)> {
    if !extension_id(id) || package.get(..8)? != b"Cr24\x03\x00\x00\x00" {
        return None;
    }
    let header_length = u32::from_le_bytes(package.get(8..12)?.try_into().ok()?) as usize;
    if header_length > 128 * 1024 {
        return None;
    }
    let header = CrxFileHeader::decode(package.get(12..12 + header_length)?).ok()?;
    let zip = package.get(12 + header_length..)?;
    let requested: Vec<_> = id
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| ((pair[0] - b'a') << 4) | (pair[1] - b'a'))
        .collect();
    let signed = SignedData::decode(header.signed_header_data.as_slice()).ok()?;
    if signed.crx_id != requested {
        return None;
    }
    let mut message = Vec::with_capacity(20 + header.signed_header_data.len() + zip.len());
    message.extend_from_slice(b"CRX3 SignedData\0");
    message.extend_from_slice(&(header.signed_header_data.len() as u32).to_le_bytes());
    message.extend_from_slice(&header.signed_header_data);
    message.extend_from_slice(zip);
    let mut developer = None;
    let mut published = false;
    let rsa: &'static dyn VerificationAlgorithm = &signature::RSA_PKCS1_2048_8192_SHA256;
    let ecdsa: &'static dyn VerificationAlgorithm = &signature::ECDSA_P256_SHA256_ASN1;
    for (proof, algorithm) in header
        .rsa
        .into_iter()
        .map(|proof| (proof, rsa))
        .chain(header.ecdsa.into_iter().map(|proof| (proof, ecdsa)))
    {
        let hash: [u8; 32] = Sha256::digest(&proof.public_key).into();
        let is_publisher = hash == publisher;
        let is_developer = hash[..16] == requested;
        if !is_publisher && !is_developer {
            continue;
        }
        ParsedPublicKey::new(algorithm, &proof.public_key)
            .ok()?
            .verify_sig(&message, &proof.signature)
            .ok()?;
        published |= is_publisher;
        if is_developer {
            developer = Some(proof.public_key);
        }
    }
    published.then_some((zip, developer?))
}

fn safe_path(name: &str) -> Option<PathBuf> {
    let name = name.strip_suffix('/').unwrap_or(name);
    if name.len() > 240 || name.is_empty() {
        return None;
    }
    let mut result = PathBuf::new();
    for part in name.split('/') {
        let stem = part.split('.').next()?.trim_end().to_ascii_uppercase();
        if part.is_empty()
            || part.ends_with(['.', ' '])
            || part.contains(['\\', ':', '*', '?', '"', '<', '>', '|'])
            || part.chars().any(char::is_control)
            || matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
            )
            || stem
                .strip_prefix("COM")
                .or_else(|| stem.strip_prefix("LPT"))
                .is_some_and(|digit| {
                    matches!(
                        digit,
                        "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
        {
            return None;
        }
        result.push(part);
    }
    Some(result)
}

fn unpack(data: &[u8], destination: &Path) -> Option<()> {
    let mut archive = ZipArchive::new(Cursor::new(data)).ok()?;
    if archive.len() > 12_000 {
        return None;
    }
    let mut remaining = MAX_UNPACKED;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index).ok()?;
        let name = std::str::from_utf8(file.name_raw()).ok()?;
        let relative = safe_path(name)?;
        if !names.insert(name.trim_end_matches('/').to_lowercase()) || file.is_symlink() {
            return None;
        }
        if relative.starts_with("_metadata") {
            continue;
        }
        let target = destination.join(relative);
        if file.is_dir() {
            fs::create_dir_all(target).ok()?;
        } else {
            fs::create_dir_all(target.parent()?).ok()?;
            let expected = file.size();
            remaining = remaining.checked_sub(expected)?;
            let mut output = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(target)
                .ok()?;
            if io::copy(&mut file.take(expected + 1), &mut output).ok()? != expected {
                return None;
            }
        }
    }
    Some(())
}

pub(super) fn popup_path(manifest: &Value) -> Option<String> {
    let path = manifest["action"]["default_popup"]
        .as_str()
        .or_else(|| manifest["browser_action"]["default_popup"].as_str())?;
    safe_path(path)?;
    (!path.ends_with('/') && !path.contains(['#', '%'])).then(|| path.to_string())
}

fn read_json(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_MANIFEST {
        return None;
    }
    serde_json::from_reader(file.take(MAX_MANIFEST)).ok()
}

fn manifest_name(manifest: &Value, path: &Path) -> Option<String> {
    let name = manifest["name"].as_str()?.trim();
    let localized = name
        .strip_prefix("__MSG_")
        .and_then(|key| key.strip_suffix("__"))
        .and_then(|key| {
            let locale = manifest["default_locale"].as_str()?;
            if locale.is_empty()
                || !locale
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return None;
            }
            let messages = read_json(&path.join("_locales").join(locale).join("messages.json"))?;
            Some(messages[key]["message"].as_str()?.to_string())
        });
    let name = localized.as_deref().unwrap_or(name).trim();
    (!name.is_empty()).then(|| name.chars().take(160).collect())
}

fn permissions(manifest: &Value, fields: &[&str]) -> Vec<String> {
    let mut values: Vec<_> = fields
        .iter()
        .filter_map(|name| manifest[name].as_array())
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    values.sort();
    values.dedup();
    values
}

pub(super) fn prepare(data: Vec<u8>, id: String, profile: PathBuf) -> Result<StorePackage, String> {
    let (zip, key) = verify(&data, &id, WEB_STORE_PUBLISHER)
        .ok_or("Could not verify the Chrome Web Store publisher and extension signatures")?;
    let directory = tempfile::Builder::new()
        .prefix("store-extension-")
        .tempdir_in(&profile)
        .map_err(|_| "Could not create the extension installation directory")?;
    unpack(zip, directory.path())
        .ok_or("The browser extension package could not be safely unpacked")?;
    let path = directory.path().join("manifest.json");
    let mut manifest = read_json(&path).ok_or("The browser extension manifest is invalid")?;
    if !matches!(manifest["manifest_version"].as_u64(), Some(2 | 3)) {
        return Err("The browser extension manifest is invalid".into());
    }
    let popup = popup_path(&manifest);
    let name =
        manifest_name(&manifest, directory.path()).ok_or("The browser extension has no name")?;
    let version = manifest["version"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() < 100)
        .ok_or("The browser extension has no valid version")?
        .to_string();
    let mut required = permissions(&manifest, &["permissions", "host_permissions"]);
    if let Some(scripts) = manifest["content_scripts"].as_array() {
        for script in scripts {
            required.extend(permissions(script, &["matches"]));
        }
    }
    required.sort();
    required.dedup();
    let optional_permissions = permissions(
        &manifest,
        &["optional_permissions", "optional_host_permissions"],
    );
    manifest["key"] = Value::String(STANDARD.encode(key));
    fs::write(
        &path,
        serde_json::to_vec(&manifest).map_err(|_| "Invalid extension manifest")?,
    )
    .map_err(|_| "Could not prepare the browser extension manifest")?;
    Ok(StorePackage {
        manifest: StoreManifest {
            id,
            name,
            version,
            permissions: required,
            optional_permissions,
        },
        directory,
        popup,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_store_page_and_safe_archive_paths() {
        const ID: &str = "nngceckbapebfimnlniiiahkandclblb";
        assert_eq!(
            store_extension_id(&format!(
                "https://chromewebstore.google.com/detail/bitwarden/{ID}?hl=en"
            )),
            Some(ID.into())
        );
        assert!(store_extension_id(&format!(
            "https://chromewebstore.google.com.evil.test/detail/{ID}"
        ))
        .is_none());
        assert!(store_extension_id(&format!(
            "https://user@chromewebstore.google.com/detail/{ID}"
        ))
        .is_none());
        assert!(store_extension_id(&format!(
            "https://chromewebstore.google.com/detail/{ID}/other"
        ))
        .is_none());
        assert!(safe_path("assets/popup/index.html").is_some());
        for name in [
            "../escape",
            "drive:C",
            "aux.txt",
            "_locales/COM¹.svg",
            "a\\b",
            "a/./b",
            "/root",
            "a./b",
        ] {
            assert!(safe_path(name).is_none(), "{name}");
        }
        assert!(verify(b"Cr24\x03\0\0\0\xff\xff\xff\xff", ID, WEB_STORE_PUBLISHER).is_none());
    }

    #[test]
    #[ignore = "requires a genuine Chrome Web Store package supplied by the caller"]
    fn official_store_package_signature_rejects_changed_payload() {
        let package = PathBuf::from(std::env::var_os("ZEROAGENT_CRX_FIXTURE").unwrap());
        let id = std::env::var("ZEROAGENT_CRX_ID").unwrap();
        let mut data = fs::read(package).unwrap();
        let profile = tempfile::tempdir().unwrap();
        let prepared = prepare(data.clone(), id.clone(), profile.path().to_path_buf()).unwrap();
        assert_eq!(prepared.manifest.id, id);
        assert!(prepared.popup.is_some());
        let index = data.len() - 1;
        data[index] ^= 1;
        assert!(verify(&data, &id, WEB_STORE_PUBLISHER).is_none());
    }
}
