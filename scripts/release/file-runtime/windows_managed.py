"""Build the Windows file-tools companion ZIP using independently pinned assets."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from assemble import LOCK, copy_component, digest, download, extract_tar, unpack_conda, unpack_office


TARGET = "x86_64-pc-windows-msvc"
WINDOWS_LOCK = Path(__file__).with_name("windows-managed.lock.json")
ARCHIVE_NAME = "file-runtime.zip"
ENTRY_LIMIT = 50_000
ARCHIVE_LIMIT = 2 * 1024**3
FILE_LIMIT = 768 * 1024**2
TREE_LIMIT = 4 * 1024**3
MANIFEST_LIMIT = 16 * 1024**2
DEVICE_NAME = re.compile(r"(?i)^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.|$)")
WHEEL_DIRECTORIES = {
    "platlib": ("Lib", "site-packages"),
    "purelib": ("Lib", "site-packages"),
    "scripts": ("Scripts",),
    "headers": ("Include",),
    "data": (),
}


def safe_parts(name):
    parts = name.removesuffix("/").split("/")
    if len(name.encode("utf-8")) > 2048 or any(
        part in {"", ".", ".."}
        or len(part.encode("utf-16-le")) > 510
        or part.endswith((".", " "))
        or DEVICE_NAME.match(part)
        or "licensee" in part.casefold()
        or any(ord(char) < 32 or 127 <= ord(char) <= 159 or char in '\\:<>|"*?' for char in part)
        for part in parts
    ):
        raise ValueError("A runtime path is invalid, unsupported or protected")
    return parts


def inventory(root):
    """Traverse without opening protected files or following reparse points."""
    def entries(directory):
        for filename in sorted(directory.iterdir()):
            name = filename.relative_to(root).as_posix()
            safe_parts(name)
            details = filename.lstat()
            if getattr(details, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError("A runtime member is a reparse point")
            if stat.S_ISDIR(details.st_mode):
                yield from entries(filename)
            elif stat.S_ISREG(details.st_mode):
                yield name, filename, details.st_size
            else:
                raise ValueError("A runtime member is not a regular file")

    root_details = root.lstat()
    if not stat.S_ISDIR(root_details.st_mode) or (
        getattr(root_details, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    ):
        raise ValueError("The runtime root is a link")
    files = {}
    seen = set()
    total = 0
    for name, filename, size in entries(root):
        key = name.casefold()
        if key in seen or len(files) >= ENTRY_LIMIT or size > FILE_LIMIT:
            raise ValueError("Duplicate or oversized runtime member")
        seen.add(key)
        total += size
        if total > TREE_LIMIT:
            raise ValueError("Expanded runtime exceeds its size bound")
        files[name] = filename
    return files


def expand_zip(archive, destination, *, wheel=False):
    """Copy regular files from a hash-checked official ZIP to its staging root."""
    with ZipFile(archive) as source:
        members = source.infolist()
        if len(members) > ENTRY_LIMIT or sum(member.file_size for member in members) > TREE_LIMIT:
            raise ValueError("Dependency ZIP exceeds its resource bounds")
        seen = set()
        files = []
        for item in members:
            parts = safe_parts(item.filename)
            mode = item.external_attr >> 16
            kind = stat.S_IFMT(mode)
            expected_kind = stat.S_IFDIR if item.is_dir() else stat.S_IFREG
            if kind not in {0, expected_kind} or item.file_size > FILE_LIMIT:
                raise ValueError("Unexpected dependency ZIP entry type or size")
            if item.is_dir():
                continue
            if wheel:
                relative = Path("Lib", "site-packages", *parts)
                if parts[0].endswith(".data"):
                    if len(parts) < 3 or parts[1] not in WHEEL_DIRECTORIES:
                        raise ValueError("Unexpected wheel installation layout")
                    relative = Path(*WHEEL_DIRECTORIES[parts[1]], *parts[2:])
            else:
                relative = Path(*parts)
            key = relative.as_posix().casefold()
            path = destination / relative
            if key in seen or path.exists():
                raise ValueError("Duplicate installed dependency path")
            seen.add(key)
            files.append((item, path))
        for item, path in files:
            path.parent.mkdir(parents=True, exist_ok=True)
            with source.open(item) as stream, path.open("xb") as output:
                shutil.copyfileobj(stream, output, length=1024 * 1024)


def assert_asset(asset, hosts):
    origin = urlsplit(asset.get("url", ""))
    if (
        origin.hostname not in hosts
        or origin.scheme != "https"
        or origin.username
        or origin.password
        or origin.port is not None
        or not re.fullmatch(r"[0-9a-f]{64}", asset.get("sha256", ""))
    ):
        raise ValueError("Runtime inputs must have an approved public origin and SHA-256")


def assemble_runtime(destination, downloads, scratch):
    if platform.system() != "Windows" or platform.machine() not in {"AMD64", "x86_64"}:
        raise ValueError("The runtime must be assembled on Windows x64")
    windows = json.loads(WINDOWS_LOCK.read_text(encoding="utf-8"))
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    if windows["format"] != 1:
        raise ValueError("Unsupported Windows runtime lock format")
    public_inputs = {
        "python": windows["python"],
        "node": lock["targets"][TARGET]["node"],
        "soffice": lock["targets"][TARGET]["soffice"],
        **{name: lock["shared"][name] for name in (
            "poppler-source", "cjk_font", "cjk-license", "ocr-license", "ocr-pdf-config",
            "ocr-pdf-font", "eng", "chi_sim", "chi_tra",
        )},
    }
    for name, asset in public_inputs.items():
        hosts = {
            "python": {"www.python.org"},
            "node": {"nodejs.org"},
            "soffice": {"download.documentfoundation.org"},
            "poppler-source": {"poppler.freedesktop.org"},
        }.get(name, {"raw.githubusercontent.com"})
        assert_asset(asset, hosts)
    for wheel in windows["wheels"]:
        assert_asset(wheel, {"files.pythonhosted.org"})
    conda = lock["conda"]["win-64"]
    for asset in conda:
        assert_asset(asset, {"conda.anaconda.org"})

    destination.mkdir()
    downloads.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=6) as pool:
        paths = dict(zip(public_inputs, pool.map(lambda item: download(item, downloads), public_inputs.values())))
        wheel_archives = list(pool.map(lambda item: download(item, downloads), windows["wheels"]))
        native_archives = list(pool.map(lambda item: download(item, downloads), conda))

    with TemporaryDirectory(prefix="za-win-tools-", dir=scratch) as temporary:
        work = Path(temporary)
        python = destination / "python"
        python.mkdir()
        expand_zip(paths["python"], python)
        for archive in wheel_archives:
            expand_zip(archive, python, wheel=True)

        node_input = work / "node"
        node_input.mkdir()
        expand_zip(paths["node"], node_input)
        node_source, = node_input.iterdir()
        copy_component(node_source, destination / "node", refuse_private=True)

        licenses = destination / "licenses"
        licenses.mkdir()
        shutil.copy2(paths["cjk-license"], licenses / "cjk-font.txt")
        shutil.copy2(paths["ocr-license"], licenses / "ocr-models.txt")
        extract_tar(paths["poppler-source"], licenses, ("poppler-26.05.0/COPYING",), refuse_private=True)
        native = destination / "native"
        native.mkdir()
        notices = licenses / "conda"
        notices.mkdir()
        for archive in native_archives:
            with TemporaryDirectory(dir=work) as package:
                unpack_conda(archive, native, notices, Path(package), refuse_private=True)

        office_input = work / "office"
        office_input.mkdir()
        soffice, latin_font = unpack_office(
            paths["soffice"], destination / "office", "Windows", office_input,
            refuse_private=True,
        )

    fonts = destination / "fonts"
    fonts.mkdir()
    shutil.copy2(paths["cjk_font"], fonts / "NotoSansSC-VF.ttf")
    tessdata = destination / "tessdata"
    (tessdata / "configs").mkdir(parents=True)
    shutil.copy2(paths["ocr-pdf-config"], tessdata / "configs/pdf")
    shutil.copy2(paths["ocr-pdf-font"], tessdata / "pdf.ttf")
    for language in ("eng", "chi_sim", "chi_tra"):
        shutil.copy2(paths[language], tessdata / f"{language}.traineddata")

    local_tools = Path(__file__).resolve().parents[3] / "crates/file-runtime"
    tools = destination / "tools"
    tools.mkdir()
    for name in ("file_tool.py", "runtime_common.py", "document_review.py", "office.py", "pdf_tools.py"):
        shutil.copy2(local_tools / name, tools / name)

    entries = {
        "python": "python/python.exe",
        "node": "node/node.exe",
        "soffice": soffice,
        "poppler_bin": "native/Library/bin",
        "tesseract": "native/Library/bin/tesseract.exe",
        "unzip": "native/Library/bin/bsdtar.exe",
        "cjk_font": "fonts/NotoSansSC-VF.ttf",
        "latin_font": latin_font,
        "tessdata": "tessdata",
    }
    files = inventory(destination)
    for name, location in entries.items():
        if name in {"poppler_bin", "tessdata"}:
            if not any(filename.startswith(location + "/") for filename in files):
                raise ValueError(f"Runtime directory is missing: {name}")
        elif location not in files:
            raise ValueError(f"Runtime file is missing: {name}")
    python_notice = next(
        (name for name in ("python/LICENSE.txt", "python/LICENSE", "python/LICENSE.md") if name in files),
        None,
    )
    components = {
        "python": {**windows["python"], "license": python_notice},
        "node": {"version": "24.22.1", **public_inputs["node"], "license": "node/LICENSE"},
        "soffice": {"version": "26.2.7", **public_inputs["soffice"], "license": "office/LICENSE.html"},
    }
    for name, component in components.items():
        if component["license"] not in files:
            raise ValueError(f"Required public license notice is missing: {name}")

    manifest = {
        "format": 1, "target": TARGET, **entries, "components": components,
        "wheel_sources": windows["wheels"], "native_sources": conda,
        "public_sources": public_inputs,
        "files": {name: digest(path) for name, path in files.items()},
    }
    (destination / "runtime.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def verify_tree(runtime):
    files = inventory(runtime)
    manifest_file = files.pop("runtime.json")
    if manifest_file.stat().st_size > MANIFEST_LIMIT:
        raise ValueError("The runtime manifest exceeds its size bound")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    if (
        manifest.get("format") != 1
        or manifest.get("target") != TARGET
        or manifest.get("artifact_tool") is not None
        or manifest["files"] != {name: digest(path) for name, path in files.items()}
    ):
        raise ValueError("The managed runtime manifest does not match this tree")
    return manifest_file, files


def pack_runtime(runtime, output):
    manifest_file, files = verify_tree(runtime)
    output.mkdir()
    archive = output / ARCHIVE_NAME
    with ZipFile(archive, "x", ZIP_DEFLATED) as bundle:
        for name, path in {"runtime.json": manifest_file, **files}.items():
            entry = ZipInfo(name)
            entry.compress_type = ZIP_DEFLATED
            entry.file_size = path.stat().st_size
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            with path.open("rb") as source, bundle.open(entry, "w") as destination:
                shutil.copyfileobj(source, destination, length=1024 * 1024)
    archive_size = archive.stat().st_size
    if not 0 < archive_size <= ARCHIVE_LIMIT:
        raise ValueError("The companion ZIP exceeds its size bound")
    receipt = {
        "format": 1,
        "target": TARGET,
        "source_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "bytes": archive_size,
        "sha256": digest(archive),
    }
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")


def restore_runtime(pack, destination):
    receipt = json.loads((pack / "receipt.json").read_text(encoding="utf-8"))
    archive = pack / ARCHIVE_NAME
    if (
        receipt.get("format") != 1
        or receipt.get("target") != TARGET
        or receipt.get("bytes") != archive.stat().st_size
        or not 0 < receipt["bytes"] <= ARCHIVE_LIMIT
        or receipt.get("sha256") != digest(archive)
    ):
        raise ValueError("The Windows file runtime ZIP does not match its receipt")
    destination.mkdir()
    expand_zip(archive, destination)
    verify_tree(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    assembly = subcommands.add_parser("assemble")
    assembly.add_argument("destination", type=Path)
    assembly.add_argument("--downloads", type=Path, required=True)
    assembly.add_argument("--scratch", type=Path, required=True)
    packer = subcommands.add_parser("pack")
    packer.add_argument("runtime", type=Path)
    packer.add_argument("output", type=Path)
    restore = subcommands.add_parser("restore")
    restore.add_argument("pack", type=Path)
    restore.add_argument("destination", type=Path)
    options = parser.parse_args()
    if options.command == "assemble":
        assemble_runtime(options.destination, options.downloads, options.scratch)
    elif options.command == "pack":
        pack_runtime(options.runtime, options.output)
    else:
        restore_runtime(options.pack, options.destination)
