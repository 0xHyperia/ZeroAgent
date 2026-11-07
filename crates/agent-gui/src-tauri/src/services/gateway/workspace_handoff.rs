use super::{proto, ws_transport::workspace_snapshot_from_settings, GatewayController};
use std::{fs, io::Write, path::Path};

pub(crate) const WORKSPACE_HANDOFF_MAX: usize = 32 << 20;

impl GatewayController {
    pub(crate) async fn copy_workspace_file(
        &self,
        request: proto::WorkspaceHandoffRequest,
    ) -> Result<String, String> {
        let snapshot = self.current_settings_snapshot().await?;
        let workspace = workspace_snapshot_from_settings(&snapshot)?
            .into_iter()
            .find(|item| item.id == request.workspace_id)
            .ok_or_else(|| "Workspace is unavailable".to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            copy_file(Path::new(&workspace.path), &request)
        })
        .await
        .map_err(|_| "Workspace transfer result is unknown".to_string())?
    }
}

fn copy_file(root: &Path, request: &proto::WorkspaceHandoffRequest) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(&request.operation_id)
        .map_err(|_| "Invalid workspace transfer".to_string())?;
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
    let root = root
        .canonicalize()
        .map_err(|_| "Workspace is unavailable".to_string())?;
    if !root.is_dir() {
        return Err("Workspace is unavailable".into());
    }
    let folder = format!("ZA-{id}");
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
    fn workspace_transfer_preserves_bytes_and_refuses_a_conflicting_retry() {
        let root = tempfile::tempdir().unwrap();
        let mut request = proto::WorkspaceHandoffRequest {
            workspace_id: "workspace".into(),
            operation_id: uuid::Uuid::new_v4().to_string(),
            file_name: "../report.pdf".into(),
            content: vec![0, 1, 255],
        };
        let path = copy_file(root.path(), &request).unwrap();
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
}
