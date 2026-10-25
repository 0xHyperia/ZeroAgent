use crate::services::mcp_oauth::{self as native_mcp_oauth, CredentialOwner};

const MCP_OAUTH_TARGET_CHANGED: &str =
    "MCP_OAUTH_TARGET_CHANGED: MCP 配置已变更，请重新载入后再授权";

// Private values participate in the digest, never in an IPC result or error.
#[derive(Clone, PartialEq, Eq)]
struct McpOauthTarget {
    server: native_mcp_oauth::OauthServer,
    material: Value,
}

fn mcp_oauth_target_digest(storage_id: &str, target: &McpOauthTarget) -> Result<String, String> {
    Ok(backup_sha256_hex(
        &serde_json::to_vec(&json!({"profile":storage_id,"target":target.material}))
            .map_err(|_| "无法校验 MCP OAuth 目标")?,
    ))
}

/// The Go callback can run while configuration replacement owns both the Native
/// gate and Go's LiveManager lock. Verify saved private material without either
/// reentering the gate or requesting Go HTTP from this path.
pub(crate) fn verify_mcp_credential_target_file(
    backend_root: &Path,
    storage_id: &str,
    claim: &Value,
) -> Result<(native_mcp_oauth::OauthServer, String), String> {
    let invalid = || MCP_OAUTH_TARGET_CHANGED.to_string();
    let fields = claim.as_object().ok_or_else(invalid)?;
    if fields.keys().any(|field| {
        !matches!(
            field.as_str(),
            "id" | "transport" | "url" | "scope" | "clientId" | "credentialRef" | "headers"
        )
    }) {
        return Err(invalid());
    }
    let id = claim
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.trim() == *id)
        .ok_or_else(invalid)?;
    let saved = read_private_backend_json_at(backend_root, "config.json.live-mcp.json")?
        .ok_or_else(invalid)?;
    let enabled = saved
        .get("servers")
        .and_then(Value::as_array)
        .and_then(|servers| {
            servers
                .iter()
                .find(|server| server.get("id").and_then(Value::as_str) == Some(id))
        })
        .and_then(|server| server.get("enabled"))
        .and_then(Value::as_bool)
        .ok_or_else(invalid)?;
    if !enabled {
        return Err(invalid());
    }
    let actual = mcp_oauth_target(&saved, id)?;
    let incoming = json!({"servers":[{"id":id,"transport":claim.get("transport"),"url":claim.get("url"),"enabled":true,
        "headers":claim.get("headers").cloned().unwrap_or_else(||json!({})),
        "auth":{"type":"oauth","scope":claim.get("scope"),"clientId":claim.get("clientId"),"credentialRef":claim.get("credentialRef")}}]});
    if mcp_oauth_target(&incoming, id)? != actual {
        return Err(invalid());
    }
    let digest = mcp_oauth_target_digest(storage_id, &actual)?;
    Ok((actual.server, digest))
}

fn mcp_oauth_target(settings: &Value, id: &str) -> Result<McpOauthTarget, String> {
    let invalid = || MCP_OAUTH_TARGET_CHANGED.to_string();
    let servers = settings
        .get("servers")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let matches = servers
        .iter()
        .filter(|server| server.get("id").and_then(Value::as_str) == Some(id))
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(invalid());
    }
    let saved = matches[0];
    // The source adapter supports both Streamable HTTP and legacy GET/POST SSE.
    // Keep their identities distinct even when they use the same endpoint URL.
    let transport = saved
        .get("transport")
        .and_then(Value::as_str)
        .filter(|transport| matches!(*transport, "http" | "sse"))
        .ok_or_else(invalid)?;
    saved
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(invalid)?;
    let auth = saved
        .get("auth")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    if auth
        .get("type")
        .and_then(Value::as_str)
        .is_none_or(|value| !value.eq_ignore_ascii_case("oauth"))
    {
        return Err(invalid());
    }
    let optional = |field: &str| -> Result<Option<String>, String> {
        match auth.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => {
                Ok((!value.trim().is_empty()).then(|| value.trim().to_owned()))
            }
            _ => Err(invalid()),
        }
    };
    let raw = saved
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let parsed = url::Url::parse(raw.trim()).map_err(|_| invalid())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(invalid());
    }
    let url = native_mcp_oauth::discovery::canonical_resource(raw).map_err(|_| invalid())?;
    let server = native_mcp_oauth::OauthServer {
        id: id.to_owned(),
        url,
        scope_override: optional("scope")?,
        static_client_id: optional("clientId")?,
    };
    let headers = saved.get("headers").cloned().unwrap_or_else(|| json!({}));
    if !headers
        .as_object()
        .is_some_and(|fields| fields.values().all(Value::is_string))
    {
        return Err(invalid());
    }
    if saved.get("messageUrl").is_some_and(|value| {
        !value.is_null() && !value.as_str().is_some_and(|raw| raw.trim().is_empty())
    }) {
        return Err(invalid());
    }
    let credential_ref = match auth.get("credentialRef") {
        None | Some(Value::Null) => "",
        Some(Value::String(value)) => value.as_str(),
        _ => return Err(invalid()),
    };
    let material = json!({"id":server.id,"transport":transport,"url":server.url,
        "scope":server.scope_override,"clientId":server.static_client_id,
        "credentialRef":credential_ref,"headers":headers});
    Ok(McpOauthTarget { material, server })
}

pub(crate) struct CanonicalMcpOauthBinding {
    backend: ProfileBackupBackend,
    target: McpOauthTarget,
    mcp_revision: u64,
    digest: String,
}

impl CanonicalMcpOauthBinding {
    pub(crate) fn capture(
        connection: crate::services::kbrain_backend::KBrainBackendConnection,
        state: Arc<crate::services::kbrain_backend::KBrainBackendState>,
        store: &native_mcp_oauth::store::TokenStore,
        claimed: &native_mcp_oauth::OauthServer,
        transport: &str,
    ) -> Result<Self, String> {
        if !store.matches_target(store.profile_root(), &claimed.id) {
            return Err(MCP_OAUTH_TARGET_CHANGED.into());
        }
        let backend =
            ProfileBackupBackend::new(connection, Some(state), store.profile_root().to_owned())?;
        Self::capture_backend(backend, claimed, transport)
    }

    fn capture_backend(
        backend: ProfileBackupBackend,
        claimed: &native_mcp_oauth::OauthServer,
        transport: &str,
    ) -> Result<Self, String> {
        let (target, mcp_revision, digest) = {
            let _guard = backend.configuration.blocking_lock();
            let target = Self::read_target_locked(&backend, &claimed.id)?;
            let mut claim = claimed.clone();
            claim.url = native_mcp_oauth::discovery::canonical_resource(&claim.url)
                .map_err(|_| MCP_OAUTH_TARGET_CHANGED)?;
            if target.material["transport"].as_str() != Some(transport) || target.server != claim {
                return Err(MCP_OAUTH_TARGET_CHANGED.into());
            }
            let digest = mcp_oauth_target_digest(&backend.connection.storage_id, &target)?;
            (target, backend.configuration.mcp_revision(), digest)
        };
        Ok(Self {
            backend,
            target,
            mcp_revision,
            digest,
        })
    }

    fn read_target_locked(
        backend: &ProfileBackupBackend,
        id: &str,
    ) -> Result<McpOauthTarget, String> {
        let public = backend.request(reqwest::Method::GET, "/v1/mcp", None)?;
        let private = backend.private_mcp_locked(&public)?;
        mcp_oauth_target(&private, id)
    }

    fn validate_locked(&self) -> Result<(), String> {
        if self.backend.configuration.mcp_revision() != self.mcp_revision
            || Self::read_target_locked(&self.backend, &self.target.server.id)? != self.target
        {
            return Err(MCP_OAUTH_TARGET_CHANGED.into());
        }
        self.backend.ensure_owner()
    }

    pub(crate) fn server(&self) -> &native_mcp_oauth::OauthServer {
        &self.target.server
    }

    pub(crate) fn status(
        &self,
        store: &native_mcp_oauth::store::TokenStore,
    ) -> Result<native_mcp_oauth::OauthStatusInfo, String> {
        let _guard = self.backend.configuration.blocking_lock();
        self.validate_locked()?;
        if !store.matches_target(&self.backend.settings_root, &self.target.server.id) {
            return Err(MCP_OAUTH_TARGET_CHANGED.into());
        }
        let record = store.snapshot()?.record;
        // Retain legacy records for rollback. Without a proven configured-target
        // binding, do not advertise them as usable by the new Go execution path.
        if record
            .as_ref()
            .is_none_or(|record| record.target_binding.as_deref() != Some(self.digest.as_str()))
        {
            return Ok(native_mcp_oauth::none_status());
        }
        native_mcp_oauth::status_in(store, self.server())
    }
}

impl CredentialOwner for CanonicalMcpOauthBinding {
    fn validate(&self) -> Result<(), String> {
        let _guard = self.backend.configuration.blocking_lock();
        self.validate_locked()
    }

    fn persist(
        &self,
        store: &native_mcp_oauth::store::TokenStore,
        record: &native_mcp_oauth::store::TokenRecord,
        baseline: &native_mcp_oauth::store::Snapshot,
    ) -> Result<&'static str, String> {
        let _guard = self.backend.configuration.blocking_lock();
        self.validate_locked()?;
        if !store.matches_target(&self.backend.settings_root, &self.target.server.id) {
            return Err(MCP_OAUTH_TARGET_CHANGED.into());
        }
        let mut bound = record.clone();
        bound.target_binding = Some(self.digest.clone());
        store.save(&bound, baseline)
    }
}
