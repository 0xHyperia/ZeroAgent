import hashlib
import os
from pathlib import Path, PureWindowsPath
import shutil
import stat
import subprocess
import zipfile


FORMATS = {
    "documents": (".docx", ".doc"),
    "pdf": (".pdf",),
    "spreadsheet": (".xlsx", ".xls", ".csv", ".tsv"),
    "presentations": (".pptx", ".ppt"),
}
MAX_FILE = 128 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024


class FileToolError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Workspace:
    def __init__(self, root):
        self.root = root.resolve(strict=True)
        if not self.root.is_dir():
            raise FileToolError("invalid_workspace", "Select an existing execution workspace.")

    def path(self, reference):
        if not isinstance(reference, str) or not reference or len(reference) > 2048:
            raise FileToolError("invalid_reference", "Supply a workspace-relative file reference.")
        windows = PureWindowsPath(reference)
        components = reference.replace("\\", "/").split("/")
        if windows.anchor or any(part in ("", ".", "..") or ":" in part or part.endswith((" ", ".")) for part in components):
            raise FileToolError("invalid_reference", "File references must stay inside the execution workspace.")
        path = self.root
        for part in components:
            path /= part
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise FileToolError("invalid_reference", "Linked paths cannot be used as file references.")
        if not path.resolve().is_relative_to(self.root):
            raise FileToolError("invalid_reference", "File references must stay inside the execution workspace.")
        return path

    def source(self, reference):
        path = self.path(reference)
        if not path.is_file() or path.stat().st_nlink != 1:
            raise FileToolError("source_unavailable", "The selected source is unavailable.")
        if path.stat().st_size > MAX_FILE:
            raise FileToolError("source_too_large", "The source exceeds 128 MiB.")
        return path

    def destination(self, reference):
        path = self.path(reference)
        if not path.parent.is_dir():
            raise FileToolError("output_folder_missing", "Select an existing output folder.")
        if path.exists():
            raise FileToolError("output_exists", "Choose a new output filename.")
        return path

    def digest(self, path):
        with path.open("rb") as stream:
            if os.fstat(stream.fileno()).st_size > MAX_FILE:
                raise FileToolError("file_too_large", "The file exceeds 128 MiB.")
            return hashlib.file_digest(stream, "sha256").hexdigest()

    def snapshot(self, source, copy, version):
        shutil.copyfile(source, copy)
        if self.digest(copy) != version:
            raise FileToolError("source_changed", "The source changed while the tool was reading it.")

    def publish(self, source, destination):
        # Link the verified file without replacing an existing filename or exposing partial bytes.
        try:
            os.link(source, self.destination(destination.relative_to(self.root).as_posix()))
        except FileExistsError as error:
            raise FileToolError("output_exists", "The output filename was taken during processing.") from error


def checked_zip(source):
    try:
        archive = zipfile.ZipFile(source)
    except zipfile.BadZipFile as error:
        raise FileToolError("invalid_package", "This is not a readable Office package.") from error
    entries = archive.infolist()
    names = set()
    if len(entries) > 16000 or sum(item.file_size for item in entries) > MAX_EXPANDED:
        archive.close()
        raise FileToolError("package_too_large", "The Office package exceeds the expansion limit.")
    for item in entries:
        name = item.filename
        parts = name.rstrip("/").split("/")
        if (name.casefold() in names or any(part in ("", ".", "..") for part in parts)
                or "\\" in name or ":" in name or item.flag_bits & 1
                or stat.S_ISLNK(item.external_attr >> 16)):
            archive.close()
            raise FileToolError("invalid_package", "The Office package contains invalid or encrypted entries.")
        names.add(name.casefold())
    return archive


def engine_path(variable):
    raw = os.environ.get(variable)
    path = Path(raw) if raw else None
    if path is None or not path.is_absolute() or not path.is_file():
        raise FileToolError("runtime_unavailable", f"The bundled engine {variable} is unavailable.")
    return str(path)


def run_engine(args, scratch):
    try:
        return subprocess.run(args, cwd=scratch, check=True, timeout=120,
                              stdin=subprocess.DEVNULL, capture_output=True)
    except subprocess.TimeoutExpired as error:
        raise FileToolError("engine_timeout", "The rendering or conversion engine timed out.") from error
    except subprocess.CalledProcessError as error:
        raise FileToolError("engine_failed", "The rendering or conversion engine rejected the file.") from error
