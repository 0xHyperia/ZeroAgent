use super::{proto, ws_transport::workspace_snapshot_from_settings, GatewayController};
use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) const WORKSPACE_HANDOFF_MAX: usize = 32 << 20;
pub(crate) const WORKSPACE_HANDOFF_TARGET_CHANGED: &str = "workspace_target_changed";

impl GatewayController {
    #[cfg(desktop)]
    pub(crate) async fn host_bridge_workspace(&self, path: &str) -> Result<String, String> {
        use crate::runtime::project_path::project_path_key;
        let key = project_path_key(path);
        let snapshot = self.current_settings_snapshot().await?;
        workspace_snapshot_from_settings(&snapshot)?
            .into_iter()
            .find(|item| {
                !key.is_empty() && project_path_key(&item.path) == key && Path::new(&item.path).is_dir()
            })
            .map(|_| key)
            .ok_or_else(|| "The current workspace is unavailable on this device".to_string())
    }

    pub(crate) async fn handle_workspace_handoff(
        &self,
        request: proto::WorkspaceHandoffRequest,
    ) -> Result<Option<String>, String> {
        let destination = self
            .workspace_handoff_destination(&request.workspace_id)
            .await?;
        Self::handle_workspace_handoff_to(destination, request).await
    }

    pub(crate) async fn workspace_handoff_destination(
        &self,
        workspace_id: &str,
    ) -> Result<String, String> {
        let snapshot = self.current_settings_snapshot().await?;
        workspace_snapshot_from_settings(&snapshot)?
            .into_iter()
            .find(|item| item.id == workspace_id)
            .map(|item| item.path)
            .ok_or_else(|| WORKSPACE_HANDOFF_TARGET_CHANGED.to_string())
    }

    pub(crate) async fn handle_workspace_handoff_to(
        destination: String,
        request: proto::WorkspaceHandoffRequest,
    ) -> Result<Option<String>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            perform_workspace_handoff(&destination, &request)
        })
        .await
        .map_err(|_| "Workspace transfer result is unknown".to_string())?
    }
}

fn perform_workspace_handoff(
    destination: &str,
    request: &proto::WorkspaceHandoffRequest,
) -> Result<Option<String>, String> {
    if request.expected_workspace_path.is_empty() || destination != request.expected_workspace_path
    {
        return Err(WORKSPACE_HANDOFF_TARGET_CHANGED.into());
    }
    let root = Path::new(destination);
    if request.check_only {
        if !request.file_name.is_empty() || !request.content.is_empty() {
            return Err("Invalid workspace receipt lookup".into());
        }
        check_receipt(root, &request.operation_id)
    } else {
        copy_file(root, request).map(Some)
    }
}

fn operation_directory(root: &Path, operation_id: &str) -> Result<(PathBuf, String), String> {
    let id = uuid::Uuid::parse_str(operation_id)
        .map_err(|_| "Invalid workspace transfer".to_string())?;
    let root = root
        .canonicalize()
        .map_err(|_| "Workspace is unavailable".to_string())?;
    if !root.is_dir() {
        return Err("Workspace is unavailable".into());
    }
    Ok((root, format!("ZA-{id}")))
}

fn check_receipt(root: &Path, operation_id: &str) -> Result<Option<String>, String> {
    let (root, folder) = operation_directory(root, operation_id)?;
    let target = root.join(&folder);
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Workspace receipt could not be read".into()),
    };
    let unavailable = || "Workspace receipt could not be verified".to_string();
    if !metadata.is_dir() || target.canonicalize().map_err(|_| unavailable())? != target {
        return Err(unavailable());
    }
    let mut entries = fs::read_dir(&target).map_err(|_| unavailable())?;
    let entry = entries
        .next()
        .transpose()
        .map_err(|_| unavailable())?
        .ok_or_else(unavailable)?;
    let name = entry.file_name().into_string().map_err(|_| unavailable())?;
    let path = entry.path();
    if entries.next().is_some()
        || !name.starts_with("ZA-")
        || name.chars().any(|c| c.is_control() || "/\\:".contains(c))
        || !entry.file_type().is_ok_and(|kind| kind.is_file())
        || path.canonicalize().map_err(|_| unavailable())? != path
    {
        return Err(unavailable());
    }
    Ok(Some(format!("{folder}/{name}")))
}

fn copy_file(root: &Path, request: &proto::WorkspaceHandoffRequest) -> Result<String, String> {
    let (root, folder) = operation_directory(root, &request.operation_id)?;
    if request.content.len() > WORKSPACE_HANDOFF_MAX || request.file_name.trim().is_empty() {
        return Err("Invalid workspace transfer".into());
    }
    let name: String = request
        .file_name
        .chars()
        .take(80)
        .map(|c| {
            if c.is_control() || "/\\:\"<>|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() {
        return Err("Invalid workspace transfer file name".into());
    }
    // The prefix avoids Windows reserved basenames while keeping the extension.
    let name = format!("ZA-{name}");
    let target = root.join(&folder);
    let receipt = format!("{folder}/{name}");
    let temp = tempfile::tempdir_in(&root)
        .map_err(|_| "Could not create workspace transfer".to_string())?;
    {
        let mut file = fs::File::create_new(temp.path().join(&name))
            .map_err(|_| "Could not create workspace transfer".to_string())?;
        file.write_all(&request.content)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save workspace transfer".to_string())?;
    }
    // Publish a complete nonempty directory. Concurrent renames cannot replace it.
    if fs::rename(temp.path(), &target).is_ok() {
        return Ok(receipt);
    }
    let original = target.join(name);
    if fs::symlink_metadata(&original).is_ok_and(|metadata| {
        metadata.file_type().is_file()
            && metadata.len() == request.content.len() as u64
            && original
                .canonicalize()
                .is_ok_and(|resolved| resolved == original)
            && fs::read(&original).is_ok_and(|content| content == request.content)
    }) {
        return Ok(receipt);
    }
    Err("Could not save workspace transfer or operation conflicts with an existing file".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmed_workspace_rejects_copy_and_lookup_after_a_remap() {
        let chosen = tempfile::tempdir().unwrap();
        let replacement = tempfile::tempdir().unwrap();
        let original = chosen.path().to_str().unwrap();
        let remapped = replacement.path().to_str().unwrap();
        let mut request = proto::WorkspaceHandoffRequest {
            workspace_id: "same-id".into(),
            operation_id: uuid::Uuid::new_v4().to_string(),
            file_name: "source.txt".into(),
            content: b"confirmed source".to_vec(),
            check_only: false,
            expected_workspace_path: original.into(),
        };
        assert_eq!(
            perform_workspace_handoff(remapped, &request).unwrap_err(),
            WORKSPACE_HANDOFF_TARGET_CHANGED
        );
        assert_eq!(fs::read_dir(replacement.path()).unwrap().count(), 0);
        let receipt = perform_workspace_handoff(original, &request)
            .unwrap()
            .unwrap();
        request.check_only = true;
        request.file_name.clear();
        request.content.clear();
        assert_eq!(
            perform_workspace_handoff(remapped, &request).unwrap_err(),
            WORKSPACE_HANDOFF_TARGET_CHANGED
        );
        assert_eq!(
            perform_workspace_handoff(original, &request).unwrap(),
            Some(receipt)
        );
        request.expected_workspace_path.clear();
        assert_eq!(
            perform_workspace_handoff(original, &request).unwrap_err(),
            WORKSPACE_HANDOFF_TARGET_CHANGED
        );
    }

    #[test]
    fn workspace_transfer_preserves_bytes_and_refuses_a_conflicting_retry() {
        let root = tempfile::tempdir().unwrap();
        let mut request = proto::WorkspaceHandoffRequest {
            workspace_id: "workspace".into(),
            operation_id: uuid::Uuid::new_v4().to_string(),
            file_name: "../report.pdf".into(),
            content: vec![0, 1, 255],
            check_only: false,
            expected_workspace_path: root.path().to_string_lossy().into_owned(),
        };
        assert_eq!(
            check_receipt(root.path(), &request.operation_id).unwrap(),
            None
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        let path = copy_file(root.path(), &request).unwrap();
        assert_eq!(
            check_receipt(root.path(), &request.operation_id).unwrap(),
            Some(path.clone())
        );
        assert_eq!(path.split('/').count(), 2);
        assert!(path.ends_with(".pdf"));
        assert_eq!(copy_file(root.path(), &request).unwrap(), path);
        request.file_name = "other.pdf".into();
        assert!(copy_file(root.path(), &request).is_err());
        request.file_name = "../report.pdf".into();
        request.content[0] = 4;
        assert!(copy_file(root.path(), &request).is_err());
        assert_eq!(fs::read(root.path().join(path)).unwrap(), [0, 1, 255]);
    }

    #[test]
    fn workspace_receipt_rejects_an_ambiguous_operation_directory() {
        let root = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let directory = root.path().join(format!("ZA-{id}"));
        fs::create_dir(&directory).unwrap();
        assert!(check_receipt(root.path(), &id).is_err());
        fs::write(directory.join("ZA-first"), [1]).unwrap();
        fs::write(directory.join("ZA-second"), [2]).unwrap();
        assert!(check_receipt(root.path(), &id).is_err());
    }
}
