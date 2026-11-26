"""Build the Windows file-tools companion ZIP using independently pinned assets."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import platform
import re
import shutil
import stat
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from zipfile import ZipFile

from assemble import LOCK, copy_component, digest, download, extract_tar, unpack_conda, unpack_office
from managed_pack import ENTRY_LIMIT, FILE_LIMIT, TREE_LIMIT, inventory, safe_parts


TARGET = "x86_64-pc-windows-msvc"
WINDOWS_LOCK = Path(__file__).with_name("windows-managed.lock.json")
WHEEL_DIRECTORIES = {
    "platlib": ("Lib", "site-packages"),
    "purelib": ("Lib", "site-packages"),
    "scripts": ("Scripts",),
    "headers": ("Include",),
    "data": (),
}


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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--downloads", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    options = parser.parse_args()
    assemble_runtime(options.destination, options.downloads, options.scratch)
