"""Pack and verify independent desktop file tool archives."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from assemble import TARGETS, digest


ARCHIVE_NAME = "file-runtime.zip"
ENTRY_LIMIT = 50_000
ARCHIVE_LIMIT = 2 * 1024**3
FILE_LIMIT = 768 * 1024**2
TREE_LIMIT = 4 * 1024**3
MANIFEST_LIMIT = 16 * 1024**2
DEVICE_NAME = re.compile(r"(?i)^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.|$)")


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


def expand_runtime(archive, destination):
    with ZipFile(archive) as source:
        members = source.infolist()
        if len(members) > ENTRY_LIMIT or sum(item.file_size for item in members) > TREE_LIMIT:
            raise ValueError("Runtime ZIP exceeds its resource bounds")
        paths = {}
        for item in members:
            parts = safe_parts(item.filename)
            mode = item.external_attr >> 16
            if (item.is_dir() or stat.S_IFMT(mode) != stat.S_IFREG or item.file_size > FILE_LIMIT
                    or item.filename.casefold() in paths):
                raise ValueError("Invalid runtime ZIP entry")
            paths[item.filename.casefold()] = (item, parts, mode)
        for item, parts, mode in paths.values():
            path = destination.joinpath(*parts)
            path.parent.mkdir(parents=True, exist_ok=True)
            with source.open(item) as infile, path.open("xb") as output:
                shutil.copyfileobj(infile, output, length=1024 * 1024)
            if os.name != "nt":
                path.chmod(0o700 if mode & 0o111 else 0o600)


def verify_tree(target, runtime):
    files = inventory(runtime)
    manifest_file = files.pop("runtime.json")
    if manifest_file.stat().st_size > MANIFEST_LIMIT:
        raise ValueError("The runtime manifest exceeds its size bound")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    if (
        manifest.get("format") != 1
        or manifest.get("target") != target
        or manifest["files"] != {name: digest(path) for name, path in files.items()}
    ):
        raise ValueError("The managed runtime manifest does not match this tree")
    return manifest_file, files


def pack_runtime(target, runtime, output):
    manifest_file, files = verify_tree(target, runtime)
    output.mkdir()
    archive = output / ARCHIVE_NAME
    with ZipFile(archive, "x", ZIP_DEFLATED) as bundle:
        for name, path in {"runtime.json": manifest_file, **files}.items():
            entry = ZipInfo(name)
            entry.compress_type = ZIP_DEFLATED
            entry.file_size = path.stat().st_size
            entry.create_system = 3
            mode = 0o700 if os.name != "nt" and path.stat().st_mode & 0o111 else 0o600
            entry.external_attr = (stat.S_IFREG | mode) << 16
            with path.open("rb") as source, bundle.open(entry, "w") as destination:
                shutil.copyfileobj(source, destination, length=1024 * 1024)
    archive_size = archive.stat().st_size
    if not 0 < archive_size <= ARCHIVE_LIMIT:
        raise ValueError("The companion ZIP exceeds its size bound")
    receipt = {
        "format": 1,
        "target": target,
        "source_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "bytes": archive_size,
        "sha256": digest(archive),
    }
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")


def restore_runtime(target, pack, destination):
    receipt = json.loads((pack / "receipt.json").read_text(encoding="utf-8"))
    archive = pack / ARCHIVE_NAME
    if (
        receipt.get("format") != 1
        or receipt.get("target") != target
        or receipt.get("bytes") != archive.stat().st_size
        or not 0 < receipt["bytes"] <= ARCHIVE_LIMIT
        or receipt.get("sha256") != digest(archive)
    ):
        raise ValueError("The file runtime ZIP does not match its receipt")
    destination.mkdir()
    expand_runtime(archive, destination)
    verify_tree(target, destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("pack", "restore"))
    parser.add_argument("target", choices=TARGETS)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    operation = pack_runtime if args.command == "pack" else restore_runtime
    operation(args.target, args.source, args.destination)
