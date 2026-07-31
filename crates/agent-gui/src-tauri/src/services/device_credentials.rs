use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CREDENTIAL_TARGET: &str = "ZeroAgent/device-credential";
const MAX_ACCOUNT_SCOPE_LENGTH: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCredentialRecord {
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub credential: String,
}

impl DeviceCredentialRecord {
    pub fn effective_agent_id(&self) -> &str {
        let agent_id = self.agent_id.trim();
        if agent_id.is_empty() {
            self.device_id.trim()
        } else {
            agent_id
        }
    }

    pub fn effective_token(&self) -> &str {
        let token = self.token.trim();
        if token.is_empty() {
            self.credential.trim()
        } else {
            token
        }
    }
}

fn credential_target(account_scope: Option<&str>) -> Result<String, String> {
    let Some(scope) = account_scope
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
    else {
        return Ok(CREDENTIAL_TARGET.to_string());
    };
    if scope.len() > MAX_ACCOUNT_SCOPE_LENGTH {
        return Err("device credential account scope is too long".to_string());
    }
    let digest = Sha256::digest(scope.as_bytes());
    let suffix = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{CREDENTIAL_TARGET}/{suffix}"))
}

pub fn load_device_credential() -> Result<Option<DeviceCredentialRecord>, String> {
    load_device_credential_for_scope(None)
}

pub fn load_device_credential_for_scope(
    account_scope: Option<&str>,
) -> Result<Option<DeviceCredentialRecord>, String> {
    let target = credential_target(account_scope)?;
    let Some(value) = platform_load(&target)? else {
        return Ok(None);
    };
    let record: DeviceCredentialRecord = serde_json::from_str(&value)
        .map_err(|error| format!("decode device credential: {error}"))?;
    if record.effective_agent_id().is_empty() || record.effective_token().is_empty() {
        return Ok(None);
    }
    Ok(Some(record))
}

pub fn save_device_credential(record: &DeviceCredentialRecord) -> Result<(), String> {
    save_device_credential_for_scope(record, None)
}

pub fn save_device_credential_for_scope(
    record: &DeviceCredentialRecord,
    account_scope: Option<&str>,
) -> Result<(), String> {
    if record.agent_id.trim().is_empty() || record.token.trim().is_empty() {
        return Err("agent id and token are required".to_string());
    }
    let value = serde_json::to_string(record)
        .map_err(|error| format!("encode device credential: {error}"))?;
    platform_save(&credential_target(account_scope)?, &value)
}

#[tauri::command]
pub fn device_credential_get(
    account_scope: Option<String>,
) -> Result<Option<DeviceCredentialRecord>, String> {
    load_device_credential_for_scope(account_scope.as_deref())
}

#[tauri::command]
pub async fn device_credential_set(
    record: DeviceCredentialRecord,
    account_scope: Option<String>,
    gateway_controller: tauri::State<
        '_,
        std::sync::Arc<crate::services::gateway::GatewayController>,
    >,
) -> Result<(), String> {
    save_device_credential_for_scope(&record, account_scope.as_deref())?;
    // The Gateway runner has one active identity. Keep its legacy target in
    // sync while retaining per-account records for future account switches.
    if account_scope
        .as_deref()
        .is_some_and(|scope| !scope.trim().is_empty())
    {
        save_device_credential(&record)?;
    }
    gateway_controller.reload_from_db().await
}

#[tauri::command]
pub async fn device_credential_activate(
    account_scope: String,
    gateway_controller: tauri::State<
        '_,
        std::sync::Arc<crate::services::gateway::GatewayController>,
    >,
) -> Result<(), String> {
    match load_device_credential_for_scope(Some(&account_scope))? {
        Some(record) => save_device_credential(&record)?,
        None => platform_delete(CREDENTIAL_TARGET)?,
    }
    gateway_controller.reload_from_db().await
}

#[tauri::command]
pub fn device_credential_delete() -> Result<(), String> {
    platform_delete(CREDENTIAL_TARGET)
}

#[tauri::command]
pub fn device_default_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "ZeroAgent device".to_string())
}

#[tauri::command]
pub fn zeroagent_app_version() -> String {
    crate::app_version().to_string()
}

#[cfg(target_os = "windows")]
fn wide(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_os = "windows")]
fn platform_save(target_name: &str, value: &str) -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };
    let mut target = wide(target_name);
    let mut username = wide("ZeroAgent");
    let mut blob = value.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: username.as_mut_ptr(),
        ..Default::default()
    };
    let ok = unsafe { CredWriteW(&credential, 0) };
    if ok == 0 {
        return Err(format!(
            "write Windows Credential Manager entry failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn platform_load(target_name: &str) -> Result<Option<String>, String> {
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };
    let target = wide(target_name);
    let mut pointer: *mut CREDENTIALW = std::ptr::null_mut();
    let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) };
    if ok == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(1168) {
            return Ok(None);
        }
        return Err(format!(
            "read Windows Credential Manager entry failed: {error}"
        ));
    }
    let result = unsafe {
        let credential = &*pointer;
        let bytes = std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        );
        String::from_utf8(bytes.to_vec()).map_err(|error| format!("decode credential: {error}"))
    };
    unsafe { CredFree(pointer.cast()) };
    result.map(Some)
}

#[cfg(target_os = "windows")]
fn platform_delete(target_name: &str) -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};
    let target = wide(target_name);
    let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if ok == 0 && std::io::Error::last_os_error().raw_os_error() != Some(1168) {
        return Err(format!(
            "delete Windows Credential Manager entry failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        credential_target, DeviceCredentialRecord, CREDENTIAL_TARGET, MAX_ACCOUNT_SCOPE_LENGTH,
    };

    #[test]
    fn legacy_record_remains_usable_during_upgrade() {
        let record: DeviceCredentialRecord =
            serde_json::from_str(r#"{"deviceId":"legacy-device","credential":"legacy-token"}"#)
                .unwrap();
        assert_eq!(record.effective_agent_id(), "legacy-device");
        assert_eq!(record.effective_token(), "legacy-token");
    }

    #[test]
    fn canonical_record_takes_precedence_over_legacy_aliases() {
        let record = DeviceCredentialRecord {
            agent_id: "agent-new".to_string(),
            token: "agt_new".to_string(),
            device_id: "legacy-device".to_string(),
            credential: "legacy-token".to_string(),
        };
        assert_eq!(record.effective_agent_id(), "agent-new");
        assert_eq!(record.effective_token(), "agt_new");
    }

    #[test]
    fn account_scopes_use_distinct_opaque_credential_targets() {
        let first = credential_target(Some("https://usa0.top|user:1")).unwrap();
        let second = credential_target(Some("https://usa0.top|user:2")).unwrap();
        assert_ne!(first, second);
        assert!(first.starts_with("ZeroAgent/device-credential/"));
        assert!(!first.contains("user:1"));
        assert_eq!(credential_target(None).unwrap(), CREDENTIAL_TARGET);
    }

    #[test]
    fn oversized_account_scope_is_rejected() {
        assert!(credential_target(Some(&"x".repeat(MAX_ACCOUNT_SCOPE_LENGTH + 1))).is_err());
    }
}

#[cfg(target_os = "macos")]
fn platform_save(target_name: &str, value: &str) -> Result<(), String> {
    let status = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            "ZeroAgent",
            "-s",
            target_name,
            "-w",
            value,
        ])
        .status()
        .map_err(|error| format!("launch macOS Keychain: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("write macOS Keychain entry failed".to_string())
    }
}

#[cfg(target_os = "macos")]
fn platform_load(target_name: &str) -> Result<Option<String>, String> {
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            "ZeroAgent",
            "-s",
            target_name,
            "-w",
        ])
        .output()
        .map_err(|error| format!("launch macOS Keychain: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
    ))
}

#[cfg(target_os = "macos")]
fn platform_delete(target_name: &str) -> Result<(), String> {
    let _ = std::process::Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            "ZeroAgent",
            "-s",
            target_name,
        ])
        .status();
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
fn platform_save(target_name: &str, value: &str) -> Result<(), String> {
    use std::io::Write;
    let mut child = std::process::Command::new("secret-tool")
        .args([
            "store",
            "--label=ZeroAgent device credential",
            "service",
            target_name,
            "account",
            "ZeroAgent",
        ])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("launch Secret Service: {error}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("Secret Service stdin unavailable")?
        .write_all(value.as_bytes())
        .map_err(|error| error.to_string())?;
    if child.wait().map_err(|error| error.to_string())?.success() {
        Ok(())
    } else {
        Err("write Secret Service entry failed".to_string())
    }
}

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
fn platform_load(target_name: &str) -> Result<Option<String>, String> {
    let output = std::process::Command::new("secret-tool")
        .args(["lookup", "service", target_name, "account", "ZeroAgent"])
        .output()
        .map_err(|error| format!("launch Secret Service: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!value.is_empty()).then_some(value))
}

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
fn platform_delete(target_name: &str) -> Result<(), String> {
    let _ = std::process::Command::new("secret-tool")
        .args(["clear", "service", target_name, "account", "ZeroAgent"])
        .status();
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn platform_save(_target_name: &str, _value: &str) -> Result<(), String> {
    Err("device credential vault is unavailable on the mobile web wrapper".to_string())
}
#[cfg(any(target_os = "android", target_os = "ios"))]
fn platform_load(_target_name: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(any(target_os = "android", target_os = "ios"))]
fn platform_delete(_target_name: &str) -> Result<(), String> {
    Ok(())
}
