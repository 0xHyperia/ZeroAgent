fn main() {
    println!(
        "cargo:rustc-env=ZEROAGENT_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("TARGET")
    );
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let package_json = std::path::Path::new(&manifest_dir)
        .join("..")
        .join("package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    println!("cargo:rerun-if-env-changed=ZEROAGENT_APP_VERSION");

    let app_version = std::env::var("ZEROAGENT_APP_VERSION")
        .ok()
        .map(|version| version.trim().to_owned())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| {
            let package_json_text =
                std::fs::read_to_string(&package_json).expect("read app package.json for version");
            let package_json_value: serde_json::Value = serde_json::from_str(&package_json_text)
                .expect("parse app package.json for version");
            package_json_value
                .get("version")
                .and_then(serde_json::Value::as_str)
                .filter(|version| !version.trim().is_empty())
                .expect("app package.json version must be a non-empty string")
                .trim()
                .to_owned()
        });
    println!("cargo:rustc-env=ZEROAGENT_APP_VERSION={app_version}");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // NDK r27 and earlier need explicit ELF alignment for 16 KB page devices.
        // https://developer.android.com/guide/practices/page-sizes
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,common-page-size=16384");
    }
    // Freeze capability metadata into the app, rather than trusting a mutable
    // runtime JSON file to decide whether a sidecar may receive a host secret.
    let target = std::env::var("TARGET").expect("TARGET");
    embed_file_runtime_descriptor(&target, &app_version);
    let suffix = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        ".exe"
    } else {
        ""
    };
    let receipt_path = std::path::Path::new(&manifest_dir)
        .join("binaries")
        .join(format!("k-brain-{target}{suffix}.json"));
    println!("cargo:rerun-if-changed={}", receipt_path.display());
    let receipt = match std::fs::read_to_string(&receipt_path) {
        Ok(raw) => {
            serde_json::from_str::<serde_json::Value>(&raw).expect("parse prepared sidecar receipt")
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => panic!("read prepared sidecar receipt: {error}"),
    };
    let native_receipt = if receipt.get("origin").and_then(serde_json::Value::as_str)
        == Some("zeroagent-patched-source")
    {
        receipt
    } else {
        serde_json::json!({})
    };
    println!(
        "cargo:rustc-env=ZEROAGENT_MCP_BRIDGE_RECEIPT={}",
        serde_json::to_string(&native_receipt).expect("serialize sidecar capability receipt")
    );

    // v2 业务消息与 WebSocket 帧壳共用 agent-gateway 目录为 include 根。
    let gateway_root = std::path::Path::new(&manifest_dir)
        .join("..")
        .join("..")
        .join("agent-gateway");
    let proto_v2 = gateway_root.join("proto").join("v2").join("gateway.proto");
    let proto_v2_ws = gateway_root
        .join("proto")
        .join("v2")
        .join("gateway_ws.proto");
    embed_file_skill_packages(&gateway_root);

    println!("cargo:rerun-if-changed={}", proto_v2.display());
    println!("cargo:rerun-if-changed={}", proto_v2_ws.display());

    prost_build::Config::new()
        .compile_protos(&[proto_v2, proto_v2_ws], &[gateway_root])
        .expect("compile gateway protos");

    let is_windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if is_windows_msvc {
        let manifest_path = std::path::Path::new(
            &std::env::var("OUT_DIR").expect("OUT_DIR for Windows app manifest"),
        )
        .join("windows-app-manifest.xml");
        std::fs::write(
            &manifest_path,
            r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
        )
        .expect("write Windows app manifest");
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attributes).expect("run Tauri build script");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
            manifest_path.display()
        );
    } else {
        tauri_build::build();
    }
}

fn embed_file_runtime_descriptor(target: &str, app_version: &str) {
    const DESCRIPTOR: &str = "ZEROAGENT_FILE_RUNTIME_DESCRIPTOR";
    println!("cargo:rerun-if-env-changed={DESCRIPTOR}");
    let embedded = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"))
        .join("file-runtime.json");
    let descriptor = if target == "x86_64-pc-windows-msvc" {
        std::env::var_os(DESCRIPTOR).map(|path| {
            let path = std::path::PathBuf::from(path);
            assert!(path.is_absolute(), "{DESCRIPTOR} must be an absolute path");
            assert!(
                !path.components().any(|part| {
                    part.as_os_str()
                        .to_string_lossy()
                        .to_ascii_lowercase()
                        .contains("licensee")
                }),
                "file runtime descriptor is not an allowed input"
            );
            println!("cargo:rerun-if-changed={}", path.display());
            let len = std::fs::metadata(&path).expect("locate the file runtime descriptor").len();
            assert!(len <= 4096, "file runtime descriptor is too large");
            let descriptor: serde_json::Value = serde_json::from_slice(
                &std::fs::read(path).expect("read the file runtime descriptor"),
            )
            .expect("parse the file runtime descriptor");
            assert_eq!(descriptor["format"].as_u64(), Some(1), "invalid descriptor format");
            assert_eq!(descriptor["target"].as_str(), Some(target), "wrong runtime target");
            assert_eq!(
                descriptor["version"].as_str(),
                Some(format!("v{app_version}").as_str()),
                "file runtime belongs to another application version"
            );
            serde_json::to_vec(&descriptor).expect("write the file runtime descriptor")
        })
    } else {
        None
    };
    std::fs::write(embedded, descriptor.unwrap_or_default())
        .expect("embed file runtime descriptor");
}

fn embed_file_skill_packages(gateway_root: &std::path::Path) {
    use std::fmt::Write;
    use std::path::Path;

    fn emit(root: &Path, directory: &Path, generated: &mut String) {
        let mut entries: Vec<_> = std::fs::read_dir(directory)
            .expect("read file skill directory")
            .map(|entry| entry.expect("read file skill entry").path())
            .collect();
        entries.sort();
        for file in entries {
            let metadata = std::fs::symlink_metadata(&file).expect("read file skill metadata");
            if metadata.is_dir() {
                emit(root, &file, generated);
            } else {
                assert!(metadata.is_file(), "invalid file skill entry");
                let relative = file.strip_prefix(root).unwrap().to_str().unwrap().replace('\\', "/");
                if relative == "plugin.json" {
                    continue;
                }
                let absolute = file.canonicalize().expect("locate file skill");
                writeln!(generated, "({relative:?}, include_bytes!({absolute:?})),").unwrap();
            }
        }
    }

    let packages = gateway_root.join("internal/account/skills");
    let mut generated = String::from("fn file_skill_package(name: &str) -> &'static [(&'static str, &'static [u8])] { match name {\n");
    for id in ["documents", "pdf", "spreadsheet", "presentations"] {
        let skill = packages.join(id);
        println!("cargo:rerun-if-changed={}", skill.display());
        writeln!(generated, "{id:?} => &[").unwrap();
        emit(&skill, &skill, &mut generated);
        generated.push_str("],\n");
    }
    generated.push_str("_ => &[], } }\n");
    std::fs::write(Path::new(&std::env::var_os("OUT_DIR").unwrap()).join("file_skill_packages.rs"), generated)
        .expect("write embedded file skill manifest");
}
