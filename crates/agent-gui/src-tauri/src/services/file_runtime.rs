use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Deserialize;

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub(super) mod managed;

#[derive(serde::Serialize)]
pub(crate) struct RuntimeSetupStatus {
    pub(super) phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded_bytes: Option<u64>,
    can_download: bool,
    can_import: bool,
    enabled: bool,
    can_manage: bool,
    can_remove: bool,
    external: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
    ready: bool,
}

impl RuntimeSetupStatus {
    pub(super) fn unavailable(ready: bool) -> Self {
        Self {
            phase: if ready { "ready" } else { "unavailable" },
            version: None,
            download_bytes: None,
            downloaded_bytes: None,
            can_download: false,
            can_import: false,
            enabled: ready,
            can_manage: false,
            can_remove: false,
            external: false,
            error: None,
            ready,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeSetupSource {
    Download,
    Offline,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeManagementAction {
    Enable,
    Disable,
    Remove,
}

const VARIABLES: [&str; 13] = [
    "ZEROAGENT_FILE_PYTHON",
    "ZEROAGENT_FILE_TOOL",
    "ZEROAGENT_FILE_SOFFICE",
    "ZEROAGENT_FILE_TESSERACT",
    "ZEROAGENT_FILE_CJK_FONT",
    "TESSDATA_PREFIX",
    "ZEROAGENT_FILE_NODE",
    "ZEROAGENT_FILE_ARTIFACT_ENTRY",
    "ZEROAGENT_FILE_POPPLER_BIN",
    "ZEROAGENT_FILE_UNZIP",
    "ZEROAGENT_FILE_GIT",
    "ZEROAGENT_FILE_HEIF_CONVERT",
    "ZEROAGENT_FILE_JXR_DECODER",
];

#[derive(Deserialize)]
struct RuntimeManifest {
    format: u32,
    python: PathBuf,
    soffice: Option<PathBuf>,
    tesseract: Option<PathBuf>,
    cjk_font: Option<PathBuf>,
    tessdata: Option<PathBuf>,
    node: Option<PathBuf>,
    artifact_tool: Option<PathBuf>,
    poppler_bin: Option<PathBuf>,
    unzip: Option<PathBuf>,
    git: Option<PathBuf>,
    heif_convert: Option<PathBuf>,
    jxr_decoder: Option<PathBuf>,
}

fn member(root: &Path, relative: &Path, directory: bool) -> Option<PathBuf> {
    if !relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let absolute = root.join(relative).canonicalize().ok()?;
    (absolute.starts_with(root)
        && if directory {
            absolute.is_dir()
        } else {
            absolute.is_file()
        })
    .then_some(absolute)
}

fn runtime_paths(root: &Path, require_complete: bool) -> Option<FileRuntime> {
    let root = root.canonicalize().ok()?;
    let manifest_path = member(&root, Path::new("runtime.json"), false)?;
    if manifest_path.metadata().ok()?.len() > 16 * 1024 * 1024 {
        return None;
    }
    let manifest: RuntimeManifest =
        serde_json::from_slice(&std::fs::read(manifest_path).ok()?).ok()?;
    if manifest.format != 1 {
        return None;
    }
    let python = member(&root, &manifest.python, false)?;
    let tool = member(&root, Path::new("tools/file_tool.py"), false)?;
    let mut bindings = vec![
        ("RUNTIME_PYTHON", python.clone()),
        ("ZEROAGENT_FILE_PYTHON", python.clone()),
        ("ZEROAGENT_FILE_TOOL", tool),
    ];
    for (name, path, directory) in [
        ("ZEROAGENT_FILE_SOFFICE", manifest.soffice, false),
        ("ZEROAGENT_FILE_TESSERACT", manifest.tesseract, false),
        ("ZEROAGENT_FILE_CJK_FONT", manifest.cjk_font, false),
        ("TESSDATA_PREFIX", manifest.tessdata, true),
        ("ZEROAGENT_FILE_NODE", manifest.node, false),
        (
            "ZEROAGENT_FILE_ARTIFACT_ENTRY",
            manifest.artifact_tool,
            false,
        ),
        ("ZEROAGENT_FILE_POPPLER_BIN", manifest.poppler_bin, true),
        ("ZEROAGENT_FILE_UNZIP", manifest.unzip, false),
        ("ZEROAGENT_FILE_GIT", manifest.git, false),
        ("ZEROAGENT_FILE_HEIF_CONVERT", manifest.heif_convert, false),
        ("ZEROAGENT_FILE_JXR_DECODER", manifest.jxr_decoder, false),
    ] {
        match path {
            Some(path) => bindings.push((name, member(&root, &path, directory)?)),
            None if require_complete => return None,
            None => {}
        }
    }
    if let Some((_, node)) = bindings
        .iter()
        .find(|(name, _)| *name == "ZEROAGENT_FILE_NODE")
    {
        bindings.push(("RUNTIME_NODE", node.clone()));
    }
    if let Some((_, artifact)) = bindings
        .iter()
        .find(|(name, _)| *name == "ZEROAGENT_FILE_ARTIFACT_ENTRY")
    {
        let modules = artifact
            .ancestors()
            .nth(4)
            .filter(|path| path.ends_with("node_modules") && path.starts_with(&root))?;
        bindings.push(("RUNTIME_NODE_MODULES", modules.to_path_buf()));
    }
    Some(FileRuntime { python, bindings })
}

#[derive(Clone)]
pub(super) struct FileRuntime {
    python: PathBuf,
    bindings: Vec<(&'static str, PathBuf)>,
}

impl FileRuntime {
    pub(super) async fn ready(&self) -> bool {
        if !self.bindings.iter().all(|(_, path)| path.exists()) {
            return false;
        }
        let mut probe = tokio::process::Command::new(&self.python);
        probe
            .args([
                "-IB",
                "-c",
                "import docx, pdf2image, pdfplumber, pypdf, pypdfium2, reportlab, PIL",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        probe.creation_flags(0x08000000); // CREATE_NO_WINDOW
        matches!(
            tokio::time::timeout(Duration::from_secs(5), probe.status()).await,
            Ok(Ok(status)) if status.success()
        )
    }
}

pub(super) fn configure(command: &mut Command, resource_dir: Option<&Path>) -> Option<FileRuntime> {
    for name in ["RUNTIME_NODE", "RUNTIME_PYTHON", "RUNTIME_NODE_MODULES"] {
        command.env_remove(name);
    }
    for variable in VARIABLES {
        command.env_remove(variable);
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    if managed::disabled_at_startup() {
        return None;
    }
    let installed = resource_dir.map(|path| path.join("file-runtime"));
    let portable = if cfg!(windows) {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|dir| dir.join("file-runtime")))
    } else {
        None
    };
    #[cfg(debug_assertions)]
    let explicit_development = std::env::var_os("ZEROAGENT_DEV_FILE_RUNTIME").map(PathBuf::from);
    #[cfg(not(debug_assertions))]
    let explicit_development: Option<PathBuf> = None;
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    let managed_runtime = managed::bound_runtime;
    #[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
    let managed_runtime = || None;
    let runtime = managed_runtime()
        .or_else(|| {
            explicit_development
                .filter(|root| root.is_absolute())
                .and_then(|root| runtime_paths(&root, false))
        })
        .or_else(|| {
            cfg!(debug_assertions)
                .then(|| {
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../../.zeroagent/file-runtime/desktop-dev")
                })
                .and_then(|root| runtime_paths(&root, false))
        })
        .or_else(|| {
            [installed, portable]
                .into_iter()
                .flatten()
                .find_map(|root| runtime_paths(&root, true))
        })?;
    command.envs(runtime.bindings.iter().map(|(name, path)| (*name, path)));
    Some(runtime)
}

#[cfg(test)]
mod tests {
    use super::runtime_paths;

    #[test]
    fn basic_runtime_is_accepted_only_for_development() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        std::fs::create_dir(root.join("tools")).unwrap();
        std::fs::write(root.join("tools/file_tool.py"), "").unwrap();
        std::fs::write(root.join("python.exe"), "").unwrap();
        let manifest = root.join("runtime.json");
        std::fs::write(&manifest, r#"{"format":1,"python":"python.exe"}"#).unwrap();

        let runtime = runtime_paths(root, false).unwrap();
        assert!(runtime
            .bindings
            .iter()
            .any(|(name, _)| *name == "RUNTIME_PYTHON"));
        assert!(runtime_paths(root, true).is_none());

        std::fs::write(&manifest, r#"{"format":1,"python":"../python.exe"}"#).unwrap();
        assert!(runtime_paths(root, false).is_none());
    }
}
