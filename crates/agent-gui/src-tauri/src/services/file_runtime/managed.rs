mod archive;
mod transfer;

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Seek};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf, Prefix};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tempfile::NamedTempFile;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
};

use super::{
    runtime_paths, FileRuntime, RuntimeManagementAction, RuntimeSetupSource, RuntimeSetupStatus,
};

const TARGET: &str = "x86_64-pc-windows-msvc";
const DESCRIPTOR: &str = include_str!(concat!(env!("OUT_DIR"), "/file-runtime.json"));
const MAX_DESCRIPTOR_BYTES: u64 = 4096;
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

static RUNTIME_INSTALLER: OnceLock<Option<Installer>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    ArchiveInvalid,
    Busy,
    DownloadFailed,
    FileSelectionFailed,
    StorageUnavailable,
    VerificationFailed,
}

impl Failure {
    fn code(self) -> &'static str {
        match self {
            Self::ArchiveInvalid => "archive_invalid",
            Self::Busy => "busy",
            Self::DownloadFailed => "download_failed",
            Self::FileSelectionFailed => "file_selection_failed",
            Self::StorageUnavailable => "storage_unavailable",
            Self::VerificationFailed => "verification_failed",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    format: u32,
    target: String,
    version: String,
    archive: ArchiveDescriptor,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveDescriptor {
    url: Option<String>,
    name: String,
    bytes: u64,
    sha256: String,
}

fn is_version(version: &str) -> bool {
    version.len() <= 100
        && version
            .strip_prefix('v')
            .is_some_and(|number| semver::Version::parse(number).is_ok())
}

impl Descriptor {
    fn parse(bytes: &[u8]) -> Option<Self> {
        let value: Self = serde_json::from_slice(bytes).ok()?;
        let archive = &value.archive;
        (value.format == 1
            && value.target == TARGET
            && is_version(&value.version)
            && archive.name == format!("ZeroAgent-{}-Windows-x64-file-tools.zip", value.version)
            && (1..=MAX_ARCHIVE_BYTES).contains(&archive.bytes)
            && archive::is_sha256(&archive.sha256)
            && archive.url.as_deref().is_none_or(|value| {
                transfer::signed_url(value).is_some_and(|url| {
                    url.path_segments()
                        .and_then(Iterator::last)
                        .is_some_and(|name| name == archive.name)
                })
            }))
        .then_some(value)
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Installed {
    generation: String,
    version: String,
    archive_sha256: String,
    manifest_sha256: String,
}

#[derive(Clone, Copy, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Policy {
    #[default]
    Enabled,
    Disabled,
    Remove,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    current: Option<Installed>,
    previous: Option<Installed>,
    #[serde(default)]
    policy: Policy,
}

#[derive(Clone, Copy)]
enum Progress {
    Idle,
    Downloading(u64),
    Verifying,
    PendingRestart,
    Failed(Failure),
}

impl Progress {
    fn busy(self) -> bool {
        matches!(self, Self::Downloading(_) | Self::Verifying)
    }

    fn phase(self, ready: bool, available: bool) -> &'static str {
        match self {
            Self::Downloading(_) => "downloading",
            Self::Verifying => "verifying",
            Self::PendingRestart => "pending_restart",
            Self::Failed(_) => "failed",
            Self::Idle if ready => "ready",
            Self::Idle if available => "missing",
            Self::Idle => "unavailable",
        }
    }
}

struct Installer {
    root: PathBuf,
    descriptor: Option<Descriptor>,
    // This binding is frozen before the account lifecycle starts any K-brain
    // process. Selecting an account or reconnecting cannot activate a download.
    active: Option<(Installed, FileRuntime)>,
    enabled_at_startup: bool,
    usage: File,
    progress: Mutex<Progress>,
    ready_before_setup: AtomicBool,
}

fn is_link(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn ensure_directory(path: &Path) -> Result<(), Failure> {
    fs::create_dir_all(path).map_err(|_| Failure::StorageUnavailable)?;
    real_directory(path).ok_or(Failure::StorageUnavailable)
}

fn real_directory(path: &Path) -> Option<()> {
    let info = fs::symlink_metadata(path).ok()?;
    (!is_link(&info) && info.is_dir()).then_some(())
}

fn read_bounded(path: &Path, limit: u64) -> Option<Vec<u8>> {
    if path.components().any(|part| {
        part.as_os_str()
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("licensee")
    }) {
        return None;
    }
    let info = fs::symlink_metadata(path).ok()?;
    if is_link(&info) || !info.is_file() || info.len() > limit {
        return None;
    }
    let mut bytes = Vec::with_capacity(info.len() as usize);
    File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn lock_writable_file(path: &Path, exclusive: bool) -> Result<File, Failure> {
    match fs::symlink_metadata(path) {
        Ok(info) if is_link(&info) || !info.is_file() => return Err(Failure::StorageUnavailable),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(Failure::StorageUnavailable),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    if exclusive {
        options.share_mode(0);
    }
    options.open(path).map_err(|_| Failure::StorageUnavailable)
}

fn lock_preparation(root: &Path) -> Result<File, Failure> {
    let file = lock_writable_file(&root.join("prepare.lock"), false)?;
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => Failure::Busy,
        std::fs::TryLockError::Error(_) => Failure::StorageUnavailable,
    })?;
    Ok(file)
}

fn is_generation(name: &str) -> bool {
    uuid::Uuid::parse_str(name).is_ok_and(|uuid| uuid.simple().to_string() == name)
}

fn accept_selection(root: &Path, record: &Installed) -> Option<FileRuntime> {
    if !is_version(&record.version)
        || !archive::is_sha256(&record.archive_sha256)
        || !archive::is_sha256(&record.manifest_sha256)
        || !is_generation(&record.generation)
    {
        return None;
    }
    let versions = root.join("versions");
    let directory = versions.join(&record.generation);
    for path in [root, versions.as_path(), directory.as_path()] {
        real_directory(path)?;
    }
    let manifest = read_bounded(&directory.join("runtime.json"), MAX_MANIFEST_BYTES)?;
    (archive::sha256(&manifest) == record.manifest_sha256)
        .then(|| runtime_paths(&directory, false))
        .flatten()
}

fn read_selection(root: &Path) -> Result<Selection, Failure> {
    real_directory(root).ok_or(Failure::StorageUnavailable)?;
    let path = root.join("selection.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Selection::default()),
        Err(_) => Err(Failure::StorageUnavailable),
        Ok(_) => serde_json::from_slice(
            &read_bounded(&path, MAX_DESCRIPTOR_BYTES).ok_or(Failure::StorageUnavailable)?,
        )
        .map_err(|_| Failure::StorageUnavailable),
    }
}

fn resolve_selection(root: &Path, selection: Selection) -> Option<(Installed, FileRuntime)> {
    [selection.current, selection.previous]
        .into_iter()
        .flatten()
        .find_map(|record| accept_selection(root, &record).map(|runtime| (record, runtime)))
}

fn owned_entries(
    root: &Path,
    folder: &str,
    owns: impl Fn(&str) -> bool,
) -> io::Result<Vec<PathBuf>> {
    let directory = root.join(folder);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Ok(info) if info.is_dir() && !is_link(&info) => {}
        Err(error) => return Err(error),
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid runtime directory",
            ))
        }
    }
    let root = root.canonicalize()?;
    if directory.canonicalize()? != root.join(folder) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid runtime directory",
        ));
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_name().to_str().is_some_and(&owns) {
            entries.push(entry.path());
        }
    }
    Ok(entries)
}

fn is_download(name: &str) -> bool {
    name.strip_suffix(".part").is_some_and(archive::is_sha256)
}

fn validate_removal_tree(path: &Path, versions: &Path) -> io::Result<()> {
    let mut remaining = vec![path.to_path_buf()];
    while let Some(path) = remaining.pop() {
        let info = fs::symlink_metadata(&path)?;
        if is_link(&info)
            || path.file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .to_ascii_lowercase()
                    .contains("licensee")
            })
            || (!info.is_dir() && !info.is_file())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Unexpected runtime contents",
            ));
        }
        if info.is_dir() {
            for entry in fs::read_dir(&path)? {
                remaining.push(entry?.path());
            }
        }
    }
    if path.canonicalize()?.parent() != Some(versions) || !path.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid runtime generation",
        ));
    }
    Ok(())
}

fn remove_workspace_tools(root: &Path) -> io::Result<()> {
    let versions = owned_entries(root, "versions", is_generation)?;
    let downloads = owned_entries(root, "downloads", is_download)?;
    if !versions.is_empty() {
        let versions_directory = root.join("versions").canonicalize()?;
        for path in &versions {
            validate_removal_tree(path, &versions_directory)?;
        }
    }
    for path in &downloads {
        let info = fs::symlink_metadata(path)?;
        if is_link(&info) || !info.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid runtime download",
            ));
        }
    }
    for path in versions {
        fs::remove_dir_all(path)?;
    }
    for path in downloads {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn initialize_selection(root: &Path) -> Option<(File, Selection)> {
    ensure_directory(root).ok()?;
    let usage = lock_writable_file(&root.join("usage.lock"), false).ok()?;
    if let Ok(_lock) = lock_preparation(root) {
        if read_selection(root).is_ok_and(|selection| selection.policy == Policy::Remove)
            && usage.try_lock().is_ok()
        {
            if remove_workspace_tools(root).is_ok() {
                let _ = publish_selection(
                    root,
                    &Selection {
                        policy: Policy::Disabled,
                        ..Selection::default()
                    },
                );
            }
            usage.unlock().ok()?;
        }
    }
    usage.lock_shared().ok()?;
    let selection = read_selection(root).unwrap_or(Selection {
        policy: Policy::Disabled,
        ..Selection::default()
    });
    Some((usage, selection))
}

pub(in crate::services) fn initialize(app: &AppHandle) {
    RUNTIME_INSTALLER.get_or_init(|| {
        let root = if crate::runtime::data_home::isolation_requested() {
            crate::runtime::data_home::home_dir()?.join(".zeroagent/file-runtimes")
        } else {
            app.path().app_local_data_dir().ok()?.join("file-runtimes")
        };
        let (usage, selection) = initialize_selection(&root)?;
        let enabled = selection.policy == Policy::Enabled;
        #[cfg(debug_assertions)]
        let override_path = std::env::var_os("ZEROAGENT_FILE_RUNTIME_DESCRIPTOR");
        #[cfg(not(debug_assertions))]
        let override_path: Option<std::ffi::OsString> = None;
        let descriptor = match override_path {
            Some(path) => {
                let path = PathBuf::from(path);
                path.is_absolute()
                    .then(|| read_bounded(&path, MAX_DESCRIPTOR_BYTES))
                    .flatten()
                    .and_then(|data| Descriptor::parse(&data))
            }
            None => Descriptor::parse(DESCRIPTOR.as_bytes()),
        };
        Some(Installer {
            active: enabled
                .then(|| resolve_selection(&root, selection))
                .flatten(),
            enabled_at_startup: enabled,
            usage,
            root,
            descriptor,
            progress: Mutex::new(Progress::Idle),
            ready_before_setup: AtomicBool::new(false),
        })
    });
}

fn instance() -> Option<&'static Installer> {
    RUNTIME_INSTALLER.get().and_then(Option::as_ref)
}

pub(super) fn bound_runtime() -> Option<FileRuntime> {
    instance()?
        .active
        .as_ref()
        .map(|(_, runtime)| runtime.clone())
}

pub(super) fn disabled_at_startup() -> bool {
    instance().is_some_and(|installer| !installer.enabled_at_startup)
}

pub(in crate::services) fn release_usage_for_restart() {
    if let Some(installer) = instance() {
        let _ = installer.usage.unlock();
    }
}

pub(in crate::services) fn status(ready: bool) -> RuntimeSetupStatus {
    instance().map_or_else(
        || RuntimeSetupStatus::unavailable(ready),
        |installer| installer.status(ready),
    )
}

pub(in crate::services) fn status_while_preparing() -> Option<RuntimeSetupStatus> {
    let installer = instance()?;
    let progress = installer.progress();
    (progress.busy() || matches!(progress, Progress::PendingRestart))
        .then(|| installer.status(installer.ready_before_setup.load(Ordering::Relaxed)))
}

impl Installer {
    fn progress(&self) -> Progress {
        self.progress
            .lock()
            .map_or(Progress::Failed(Failure::StorageUnavailable), |state| {
                *state
            })
    }

    fn update_progress(&self, progress: Progress) {
        if let Ok(mut current) = self.progress.lock() {
            *current = progress;
        }
    }

    fn status(&self, ready: bool) -> RuntimeSetupStatus {
        let progress = self.progress();
        let descriptor = self.descriptor.as_ref();
        let selection = read_selection(&self.root).ok();
        let enabled = selection
            .as_ref()
            .is_some_and(|state| state.policy == Policy::Enabled);
        let removal = selection
            .as_ref()
            .is_some_and(|state| state.policy == Policy::Remove);
        let can_import = enabled && descriptor.is_some();
        let can_remove = !removal
            && selection.as_ref().is_some_and(|state| {
                state.current.is_some()
                    || state.previous.is_some()
                    || owned_entries(&self.root, "versions", is_generation)
                        .is_ok_and(|paths| !paths.is_empty())
                    || owned_entries(&self.root, "downloads", is_download)
                        .is_ok_and(|paths| !paths.is_empty())
            });
        let active_version = self
            .active
            .as_ref()
            .map(|(receipt, _)| receipt.version.clone())
            .or_else(|| {
                selection
                    .as_ref()?
                    .current
                    .as_ref()
                    .map(|receipt| receipt.version.clone())
            });
        let target_version = descriptor.map(|descriptor| descriptor.version.clone());
        let external = ready && self.active.is_none();
        let phase = match (enabled, self.enabled_at_startup, removal) {
            _ if selection.is_none() => "failed",
            (_, _, true) => "pending_removal",
            (false, true, _) => "pending_disable",
            (false, false, _) => "disabled",
            (true, false, _) if matches!(progress, Progress::Idle) => "pending_enable",
            _ => progress.phase(ready, can_import),
        };
        RuntimeSetupStatus {
            phase,
            version: if external {
                None
            } else if ready || !enabled || phase == "pending_enable" {
                active_version
            } else {
                target_version.or(active_version)
            },
            download_bytes: descriptor.map(|descriptor| descriptor.archive.bytes),
            downloaded_bytes: match progress {
                Progress::Downloading(bytes) => Some(bytes),
                _ => None,
            },
            can_download: can_import
                && descriptor.is_some_and(|descriptor| descriptor.archive.url.is_some()),
            can_import,
            enabled,
            can_manage: selection.is_some(),
            can_remove,
            external,
            error: match progress {
                _ if selection.is_none() => Some(Failure::StorageUnavailable.code()),
                Progress::Failed(error) => Some(error.code()),
                _ => None,
            },
            ready,
        }
    }

    fn start(&self, source: &RuntimeSetupSource, ready: bool) -> Result<Progress, String> {
        let descriptor = self.descriptor.as_ref().ok_or("unavailable")?;
        if matches!(source, RuntimeSetupSource::Download) && descriptor.archive.url.is_none() {
            return Err("download_unavailable".into());
        }
        let mut progress = self.progress.lock().map_err(|_| "storage_unavailable")?;
        if read_selection(&self.root).map_err(Failure::code)?.policy != Policy::Enabled {
            return Err("disabled".into());
        }
        let previous = *progress;
        if matches!(previous, Progress::PendingRestart) {
            return Err("pending_restart".into());
        }
        if previous.busy() {
            return Err("busy".into());
        }
        self.ready_before_setup.store(ready, Ordering::Relaxed);
        *progress = match source {
            RuntimeSetupSource::Download => Progress::Downloading(0),
            RuntimeSetupSource::Offline => Progress::Verifying,
        };
        Ok(previous)
    }

    fn install(&self, selected: Option<PathBuf>) -> Result<(), Failure> {
        let descriptor = self
            .descriptor
            .as_ref()
            .ok_or(Failure::StorageUnavailable)?;
        let archive = &descriptor.archive;
        let _lock = lock_preparation(&self.root)?;
        let selection = read_selection(&self.root)?;
        if selection.policy != Policy::Enabled {
            return Err(Failure::Busy);
        }

        let downloads = self.root.join("downloads");
        let versions = self.root.join("versions");
        ensure_directory(&downloads)?;
        ensure_directory(&versions)?;
        let generation = uuid::Uuid::new_v4().simple().to_string();
        let staged = tempfile::Builder::new()
            .prefix(&generation)
            .rand_bytes(0)
            .tempdir_in(&versions)
            .map_err(|_| Failure::StorageUnavailable)?;
        let mut cached_path = None;
        let file = match selected {
            Some(path) => copy_selected_archive(&path, archive.bytes, &downloads)?,
            None => {
                let url = archive
                    .url
                    .as_deref()
                    .and_then(transfer::signed_url)
                    .ok_or(Failure::DownloadFailed)?;
                let cache = downloads.join(format!("{}.part", archive.sha256));
                let output = lock_writable_file(&cache, true)?;
                let downloaded = transfer::download(&url, output, archive.bytes, |bytes| {
                    self.update_progress(Progress::Downloading(bytes));
                })?;
                cached_path = Some(cache);
                downloaded
            }
        };
        self.update_progress(Progress::Verifying);
        let result = archive::checked_zip(file, archive.bytes, &archive.sha256)
            .and_then(|archive| archive::extract(archive, staged.path()));
        if let Some(cache) = cached_path {
            // A complete buffer is consumed whether its validation succeeded or
            // failed, so retries cannot keep selecting a corrupt completed file.
            let _ = fs::remove_file(cache);
        }
        let manifest_sha256 = result?;
        let runtime = runtime_paths(staged.path(), false).ok_or(Failure::VerificationFailed)?;
        check_workspace_tools(&runtime, staged.path())?;
        let record = Installed {
            generation,
            version: descriptor.version.clone(),
            archive_sha256: archive.sha256.clone(),
            manifest_sha256,
        };
        let previous = self
            .active
            .as_ref()
            .map(|(receipt, _)| receipt.clone())
            .or_else(|| resolve_selection(&self.root, selection).map(|(receipt, _)| receipt));
        publish_selection(
            &self.root,
            &Selection {
                current: Some(record),
                previous,
                policy: Policy::Enabled,
            },
        )?;
        let _ = staged.keep();
        Ok(())
    }
}

pub(in crate::services) fn manage(
    action: RuntimeManagementAction,
    ready: bool,
) -> Result<RuntimeSetupStatus, String> {
    let installer = instance().ok_or("unavailable")?;
    let mut progress = installer
        .progress
        .lock()
        .map_err(|_| "storage_unavailable")?;
    if progress.busy() {
        return Err("busy".into());
    }
    let _lock = lock_preparation(&installer.root).map_err(Failure::code)?;
    let mut selection = read_selection(&installer.root).map_err(Failure::code)?;
    if selection.policy == Policy::Remove {
        return Err("pending_removal".into());
    }
    selection.policy = match action {
        RuntimeManagementAction::Enable => Policy::Enabled,
        RuntimeManagementAction::Disable => Policy::Disabled,
        RuntimeManagementAction::Remove => {
            selection.current = None;
            selection.previous = None;
            Policy::Remove
        }
    };
    publish_selection(&installer.root, &selection).map_err(Failure::code)?;
    if matches!(*progress, Progress::Failed(_)) {
        *progress = Progress::Idle;
    }
    drop(progress);
    Ok(installer.status(ready))
}

fn publish_selection(root: &Path, selection: &Selection) -> Result<(), Failure> {
    let mut state = NamedTempFile::new_in(root).map_err(|_| Failure::StorageUnavailable)?;
    serde_json::to_writer(state.as_file_mut(), selection)
        .map_err(|_| Failure::StorageUnavailable)?;
    state
        .as_file()
        .sync_all()
        .map_err(|_| Failure::StorageUnavailable)?;
    state
        .persist(root.join("selection.json"))
        .map_err(|_| Failure::StorageUnavailable)?;
    Ok(())
}

fn copy_selected_archive(path: &Path, expected: u64, directory: &Path) -> Result<File, Failure> {
    let local_volume = matches!(
        path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
    );
    if !path.is_absolute()
        || !local_volume
        || !path
            .extension()
            .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
        || path.components().any(|part| {
            part.as_os_str()
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("licensee")
        })
    {
        return Err(Failure::FileSelectionFailed);
    }
    let source = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| Failure::FileSelectionFailed)?;
    let info = source
        .metadata()
        .map_err(|_| Failure::FileSelectionFailed)?;
    if is_link(&info) || !info.is_file() || info.len() != expected {
        return Err(Failure::ArchiveInvalid);
    }
    let mut output = tempfile::tempfile_in(directory).map_err(|_| Failure::StorageUnavailable)?;
    let count = io::copy(&mut source.take(expected + 1), &mut output)
        .map_err(|_| Failure::StorageUnavailable)?;
    if count != expected {
        return Err(Failure::ArchiveInvalid);
    }
    output.rewind().map_err(|_| Failure::StorageUnavailable)?;
    Ok(output)
}

fn check_workspace_tools(runtime: &FileRuntime, directory: &Path) -> Result<(), Failure> {
    if !runtime
        .bindings
        .iter()
        .any(|(name, _)| *name == "ZEROAGENT_FILE_SOFFICE")
    {
        return Err(Failure::VerificationFailed);
    }
    let directory = directory
        .canonicalize()
        .map_err(|_| Failure::VerificationFailed)?;
    let profile = tempfile::tempdir().map_err(|_| Failure::StorageUnavailable)?;
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or(Failure::VerificationFailed)?;
    let path = std::env::join_paths([root.join("System32"), root.clone()])
        .map_err(|_| Failure::VerificationFailed)?;
    let mut probe = Command::new(&runtime.python);
    crate::runtime::process::configure_child_process_group(&mut probe);
    probe
        .args([
            "-IB",
            "-c",
            include_str!("../../../../../file-runtime/check_workspace_tools.py"),
        ])
        .arg(directory)
        .current_dir(profile.path())
        .env_clear()
        .env("PATH", path)
        .env("SystemRoot", &root)
        .env("WINDIR", &root)
        .env("TEMP", profile.path())
        .env("TMP", profile.path())
        .env("USERPROFILE", profile.path())
        .env("HOME", profile.path())
        .env("APPDATA", profile.path())
        .env("LOCALAPPDATA", profile.path())
        .envs(runtime.bindings.iter().map(|(name, path)| (*name, path)))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = probe.spawn().map_err(|_| Failure::VerificationFailed)?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(Failure::VerificationFailed),
            Ok(None) if started.elapsed() < Duration::from_secs(150) => {
                std::thread::sleep(Duration::from_millis(100));
            }
            _ => break,
        }
    }
    crate::runtime::process::kill_child_process_tree_best_effort(&mut child);
    Err(Failure::VerificationFailed)
}

pub(in crate::services) async fn prepare(
    source: RuntimeSetupSource,
    ready: bool,
) -> Result<RuntimeSetupStatus, String> {
    let installer = instance().ok_or("unavailable")?;
    let previous = installer.start(&source, ready)?;
    let selected = if let RuntimeSetupSource::Offline = source {
        let selection = tauri::async_runtime::spawn_blocking(|| {
            rfd::FileDialog::new()
                .add_filter("ZIP", &["zip"])
                .pick_file()
        })
        .await;
        match selection {
            Ok(Some(path)) => Some(path),
            Ok(None) => {
                installer.update_progress(previous);
                return Ok(installer.status(ready));
            }
            Err(_) => {
                installer.update_progress(Progress::Failed(Failure::FileSelectionFailed));
                return Ok(installer.status(ready));
            }
        }
    } else {
        None
    };

    tauri::async_runtime::spawn(async move {
        let result =
            tauri::async_runtime::spawn_blocking(move || installer.install(selected)).await;
        let next = match result {
            Ok(Ok(())) => Progress::PendingRestart,
            Ok(Err(Failure::Busy)) => previous,
            Ok(Err(error)) => Progress::Failed(error),
            Err(_) => Progress::Failed(Failure::VerificationFailed),
        };
        installer.update_progress(next);
    });
    Ok(installer.status(ready))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_rejects_wrong_assets_and_accepts_offline_only_installation() {
        let mut descriptor = serde_json::json!({
            "format": 1,
            "target": TARGET,
            "version": "v1.0.0-beta.2",
            "archive": {
                "name": "ZeroAgent-v1.0.0-beta.2-Windows-x64-file-tools.zip",
                "bytes": 4096,
                "sha256": archive::sha256(b"synthetic runtime"),
            },
        });
        let parse =
            |value: &serde_json::Value| Descriptor::parse(&serde_json::to_vec(value).unwrap());
        assert!(parse(&descriptor).unwrap().archive.url.is_none());
        descriptor["archive"]["url"] = "https://example.test/other.zip".into();
        assert!(parse(&descriptor).is_none());
        descriptor["archive"]["url"] = format!(
            "https://example.test/{}",
            descriptor["archive"]["name"].as_str().unwrap()
        )
        .into();
        assert!(parse(&descriptor).is_some());
        descriptor["archive"]["bytes"] = (MAX_ARCHIVE_BYTES + 1).into();
        assert!(parse(&descriptor).is_none());
    }

    #[test]
    fn invalid_current_selection_keeps_previous_generation() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path();
        let manifest = br#"{"format":1,"python":"python.exe"}"#;
        let current = Installed {
            generation: uuid::Uuid::new_v4().simple().to_string(),
            version: "v1.0.0".into(),
            archive_sha256: archive::sha256(b"current"),
            manifest_sha256: archive::sha256(manifest),
        };
        let previous = Installed {
            generation: uuid::Uuid::new_v4().simple().to_string(),
            version: "v1.0.0-beta.2".into(),
            archive_sha256: archive::sha256(b"previous"),
            manifest_sha256: archive::sha256(manifest),
        };
        let write_generation = |record: &Installed| {
            let runtime = root.join("versions").join(&record.generation);
            fs::create_dir_all(runtime.join("tools")).unwrap();
            fs::write(runtime.join("runtime.json"), manifest).unwrap();
            fs::write(runtime.join("python.exe"), []).unwrap();
            fs::write(runtime.join("tools/file_tool.py"), []).unwrap();
            runtime
        };
        let current_root = write_generation(&current);
        write_generation(&previous);
        let selection = Selection {
            current: Some(current),
            previous: Some(previous),
            policy: Policy::Enabled,
        };
        publish_selection(root, &selection).unwrap();
        let selected_version = || {
            resolve_selection(root, read_selection(root).unwrap())
                .unwrap()
                .0
                .version
        };
        assert_eq!(selected_version(), "v1.0.0");
        fs::write(current_root.join("runtime.json"), b"invalid").unwrap();
        assert_eq!(selected_version(), "v1.0.0-beta.2");
    }

    #[test]
    fn removing_waits_for_usage_and_only_clears_managed_files() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path();
        let (in_use, _) = initialize_selection(root).unwrap();
        let generation = root
            .join("versions")
            .join(uuid::Uuid::new_v4().simple().to_string());
        let cache = root
            .join("downloads")
            .join(format!("{}.part", archive::sha256(b"cache")));
        fs::create_dir_all(&generation).unwrap();
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        fs::write(&cache, b"partial").unwrap();
        let original = root.join("downloads/original.zip");
        fs::write(&original, b"user archive").unwrap();

        publish_selection(
            root,
            &Selection {
                policy: Policy::Remove,
                ..Selection::default()
            },
        )
        .unwrap();
        let (second, selection) = initialize_selection(root).unwrap();
        assert!(selection.policy == Policy::Remove);
        assert!(generation.is_dir() && cache.is_file());
        drop(second);
        drop(in_use);

        let (_, selection) = initialize_selection(root).unwrap();
        assert!(selection.policy == Policy::Disabled);
        assert!(!generation.exists() && !cache.exists());
        assert_eq!(fs::read(original).unwrap(), b"user archive");
    }

    #[test]
    fn removal_preserves_a_generation_when_its_contents_are_protected() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path();
        let generation = root
            .join("versions")
            .join(uuid::Uuid::new_v4().simple().to_string());
        fs::create_dir_all(generation.join("Licensee-placeholder")).unwrap();
        publish_selection(
            root,
            &Selection {
                policy: Policy::Remove,
                ..Selection::default()
            },
        )
        .unwrap();
        let (_, selection) = initialize_selection(root).unwrap();
        assert!(selection.policy == Policy::Remove);
        assert!(generation.is_dir());
    }
}
