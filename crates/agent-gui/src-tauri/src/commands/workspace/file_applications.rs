use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

const MAX_APPLICATIONS: usize = 24;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileApplication {
    id: String,
    name: String,
    icon_data_url: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileApplications {
    default_application: Option<FileApplication>,
    alternatives: Vec<FileApplication>,
}

fn application_id(identity: &str) -> String {
    Sha256::digest(identity.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(any(windows, target_os = "linux"))]
fn png_data_url(png: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    format!("data:image/png;base64,{}", STANDARD.encode(png))
}

pub(super) use platform::{list, open};

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::services::cua_driver::installed_apps::windows::{app_icon_data_url, icon_to_png};
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, IDataObject, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        AssocQueryStringW, BHID_DataObject, IAssocHandler, IShellItem, SHAssocEnumHandlers,
        SHCreateItemFromParsingName, SHLoadIndirectString, ASSOCF_NONE, ASSOCSTR, ASSOCSTR_APPID,
        ASSOCSTR_EXECUTABLE, ASSOCSTR_FRIENDLYAPPNAME, ASSOC_FILTER_RECOMMENDED,
    };
    use windows_core::{HSTRING, PCWSTR, PWSTR};
    use windows_sys::Win32::UI::{Shell::ExtractIconExW, WindowsAndMessaging::DestroyIcon};

    struct Apartment;

    impl Apartment {
        fn enter() -> windows_core::Result<Self> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
            Ok(Self)
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn take_string(value: PWSTR) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let result = unsafe { value.to_string() }.ok();
        unsafe { CoTaskMemFree(Some(value.as_ptr().cast())) };
        result.filter(|value| !value.trim().is_empty())
    }

    fn association(extension: &HSTRING, field: ASSOCSTR) -> Option<String> {
        let mut buffer = vec![0_u16; 32768];
        let mut length = buffer.len() as u32;
        unsafe {
            AssocQueryStringW(
                ASSOCF_NONE,
                field,
                extension,
                PCWSTR::null(),
                Some(PWSTR(buffer.as_mut_ptr())),
                &mut length,
            )
            .ok()
            .ok()?;
        }
        String::from_utf16(buffer.get(..length.checked_sub(1)? as usize)?)
            .ok()
            .filter(|value| !value.trim().is_empty())
    }

    fn extension(path: &Path) -> Option<HSTRING> {
        Some(HSTRING::from(format!(".{}", path.extension()?.to_str()?)))
    }

    fn handlers(extension: &HSTRING) -> impl Iterator<Item = (String, IAssocHandler)> {
        let enumeration = unsafe { SHAssocEnumHandlers(extension, ASSOC_FILTER_RECOMMENDED) }.ok();
        std::iter::from_fn(move || {
            let mut output = [None];
            unsafe { enumeration.as_ref()?.Next(&mut output, None) }.ok()?;
            output[0].take()
        })
        .take(128)
        .filter_map(|handler| {
            let name = take_string(unsafe { handler.GetName() }.ok()?)?;
            Some((name, handler))
        })
    }

    fn packaged_icon(location: &str) -> Option<String> {
        if !location.starts_with("@{") {
            return None;
        }
        let mut output = [0_u16; 1024];
        unsafe { SHLoadIndirectString(&HSTRING::from(location), &mut output, None) }.ok()?;
        let path =
            String::from_utf16(&output[..output.iter().position(|unit| *unit == 0)?]).ok()?;
        let path = Path::new(&path);
        if !path.is_absolute() || !path.extension()?.eq_ignore_ascii_case("png") {
            return None;
        }
        use std::io::Read;
        const LIMIT: u64 = 256 * 1024;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .ok()?
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        (bytes.len() <= LIMIT as usize && bytes.starts_with(b"\x89PNG\r\n\x1a\n"))
            .then(|| png_data_url(&bytes))
    }

    fn handler_icon(handler: &IAssocHandler, name: &str) -> Option<String> {
        let mut location = PWSTR::null();
        let mut index = 0;
        if unsafe { handler.GetIconLocation(&mut location, &mut index) }.is_ok() {
            if let Some(location) = take_string(location) {
                if let Some(icon) = packaged_icon(&location) {
                    return Some(icon);
                }
                let location = Path::new(&location);
                if location.is_absolute() && location.is_file() {
                    let source: Vec<u16> = location.as_os_str().encode_wide().chain([0]).collect();
                    let mut icon = std::ptr::null_mut();
                    unsafe {
                        ExtractIconExW(source.as_ptr(), index, &mut icon, std::ptr::null_mut(), 1);
                    }
                    if !icon.is_null() {
                        let png = icon_to_png(icon);
                        unsafe { DestroyIcon(icon) };
                        if let Some(png) = png {
                            return Some(png_data_url(&png));
                        }
                    }
                }
            }
        }
        let path = Path::new(name);
        if !path.is_absolute() || !path.is_file() {
            return None;
        }
        app_icon_data_url(path)
    }

    pub(in super::super) fn list(file: &Path) -> FileApplications {
        let (Ok(_apartment), Some(extension)) = (Apartment::enter(), extension(file)) else {
            return FileApplications::default();
        };
        let executable = association(&extension, ASSOCSTR_EXECUTABLE);
        let app_id = association(&extension, ASSOCSTR_APPID);
        let default_name = association(&extension, ASSOCSTR_FRIENDLYAPPNAME);
        let mut seen = std::collections::HashSet::new();
        let mut items = handlers(&extension)
            .filter_map(|(identity, handler)| {
                let name = take_string(unsafe { handler.GetUIName() }.ok()?)?;
                seen.insert(identity.to_lowercase())
                    .then_some((identity, handler, name))
            })
            .collect::<Vec<_>>();
        let default_index = items
            .iter()
            .position(|(identity, _, _)| {
                executable
                    .iter()
                    .chain(&app_id)
                    .any(|default| default.eq_ignore_ascii_case(identity))
            })
            .or_else(|| {
                items
                    .iter()
                    .position(|(_, _, name)| default_name.as_ref() == Some(name))
            });
        let describe =
            |(identity, handler, name): (String, IAssocHandler, String)| FileApplication {
                id: application_id(&identity.to_lowercase()),
                name,
                icon_data_url: handler_icon(&handler, &identity),
            };
        let default_application = default_index
            .map(|index| describe(items.remove(index)))
            .or_else(|| {
                default_name.map(|name| FileApplication {
                    id: "default".into(),
                    name,
                    icon_data_url: executable
                        .as_deref()
                        .map(Path::new)
                        .filter(|path| path.is_absolute())
                        .and_then(app_icon_data_url),
                })
            });
        let mut names = std::collections::HashSet::new();
        if let Some(default) = &default_application {
            names.insert(default.name.to_lowercase());
        }
        let alternatives = items
            .into_iter()
            .filter(|(_, _, name)| names.insert(name.to_lowercase()))
            .take(MAX_APPLICATIONS)
            .map(describe)
            .collect();
        FileApplications {
            default_application,
            alternatives,
        }
    }

    pub(in super::super) fn open(file: &Path, id: &str) -> Result<(), String> {
        let _apartment = Apartment::enter().map_err(|error| error.to_string())?;
        let extension = extension(file).ok_or("This file has no registered extension")?;
        let (_, handler) = handlers(&extension)
            .find(|(name, _)| application_id(&name.to_lowercase()) == id)
            .ok_or("The application is no longer associated with this file type")?;
        let path = file
            .as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>();
        let item: IShellItem = unsafe { SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None) }
            .map_err(|error| error.to_string())?;
        let data: IDataObject = unsafe { item.BindToHandler(None, &BHID_DataObject) }
            .map_err(|error| error.to_string())?;
        unsafe { handler.Invoke(&data) }.map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use crate::services::cua_driver::installed_apps::read_macos_app_bundle;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    use std::{path::PathBuf, process::Command};

    fn applications(file: &Path) -> (Option<PathBuf>, Vec<PathBuf>) {
        let Some(path) = file.to_str() else {
            return (None, Vec::new());
        };
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let workspace = NSWorkspace::sharedWorkspace();
        let default = workspace
            .URLForApplicationToOpenURL(&url)
            .and_then(|url| url.path());
        let urls = workspace.URLsForApplicationsToOpenURL(&url);
        (
            default.map(|path| PathBuf::from(path.to_string())),
            urls.iter()
                .filter_map(|url| url.path().map(|path| PathBuf::from(path.to_string())))
                .collect(),
        )
    }

    pub(in super::super) fn list(file: &Path) -> FileApplications {
        fn describe(path: &Path) -> Option<FileApplication> {
            let app = read_macos_app_bundle(path)?;
            Some(FileApplication {
                id: application_id(path.to_str()?),
                name: app.name,
                icon_data_url: app.icon_data_url,
            })
        }
        let (default, applications) = applications(file);
        FileApplications {
            alternatives: applications
                .iter()
                .filter(|path| Some(*path) != default.as_ref())
                .take(MAX_APPLICATIONS)
                .filter_map(|path| describe(path))
                .collect(),
            default_application: default.as_deref().and_then(describe),
        }
    }

    pub(in super::super) fn open(file: &Path, id: &str) -> Result<(), String> {
        let (_, applications) = applications(file);
        let application = applications
            .into_iter()
            .find(|path| path.to_str().is_some_and(|path| application_id(path) == id))
            .ok_or("The application is no longer associated with this file type")?;
        let mut command = Command::new("/usr/bin/open");
        command.arg("-a").arg(application).arg(file);
        crate::runtime::process::spawn_and_reap(&mut command)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use gio::{prelude::*, AppInfo, File};
    use gtk::prelude::IconThemeExt;

    fn content_type(file: &File) -> Option<gio::glib::GString> {
        file.query_info(
            "standard::content-type",
            gio::FileQueryInfoFlags::NONE,
            gio::Cancellable::NONE,
        )
        .ok()?
        .content_type()
    }

    fn id(app: &AppInfo) -> Option<String> {
        Some(application_id(&app.id()?))
    }

    // GTK icon themes belong to the desktop main thread.
    pub(in super::super) fn list(file: &Path) -> FileApplications {
        let Some(content_type) = content_type(&File::for_path(file)) else {
            return FileApplications::default();
        };
        let theme = gtk::is_initialized_main_thread()
            .then(gtk::IconTheme::default)
            .flatten();
        let describe = |app: &AppInfo| {
            let icon_data_url = (|| {
                let icon = app.icon()?;
                let info =
                    theme
                        .as_ref()?
                        .lookup_by_gicon(&icon, 32, gtk::IconLookupFlags::FORCE_SIZE)?;
                let png = info.load_icon().ok()?.save_to_bufferv("png", &[]).ok()?;
                Some(png_data_url(&png))
            })();
            Some(FileApplication {
                id: id(app)?,
                name: app.display_name().to_string(),
                icon_data_url,
            })
        };
        let default = AppInfo::default_for_type(&content_type, false);
        FileApplications {
            default_application: default.as_ref().and_then(describe),
            alternatives: AppInfo::all_for_type(&content_type)
                .iter()
                .filter(|app| {
                    app.should_show() && !default.as_ref().is_some_and(|item| item.equal(*app))
                })
                .take(MAX_APPLICATIONS)
                .filter_map(describe)
                .collect(),
        }
    }

    pub(in super::super) fn open(file: &Path, selected: &str) -> Result<(), String> {
        let file = File::for_path(file);
        let content_type = content_type(&file).ok_or("Could not identify the file type")?;
        let application = AppInfo::all_for_type(&content_type)
            .into_iter()
            .find(|app| app.should_show() && id(app).as_deref() == Some(selected))
            .ok_or("The application is no longer associated with this file type")?;
        application
            .launch(&[file], gio::AppLaunchContext::NONE)
            .map_err(|error| error.to_string())
    }
}
