"""Assemble the pinned ZeroAgent file runtime on its target operating system."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import platform
import posixpath
import shutil
import subprocess
import tarfile
from tempfile import TemporaryDirectory
from urllib.parse import urlparse
from zipfile import ZipFile


LOCK = Path(__file__).with_name("dependencies.lock.json")
COMPONENT_PATH = "codex-primary-runtime/dependencies/"
TARGETS = {
    "x86_64-pc-windows-msvc": ("Windows", {"AMD64", "x86_64"}, "win-64"),
    "x86_64-apple-darwin": ("Darwin", {"x86_64"}, "osx-64"),
    "aarch64-apple-darwin": ("Darwin", {"arm64"}, "osx-arm64"),
    "x86_64-unknown-linux-gnu": ("Linux", {"x86_64"}, "linux-64"),
}


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(asset, directory):
    url, expected_hash = asset["url"], asset["sha256"]
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise ValueError(f"Invalid dependency URL: {url}")
    location = directory / expected_hash
    location.mkdir(exist_ok=True)
    filename = location / Path(parsed.path).name
    if filename.exists() and digest(filename) == expected_hash:
        return filename
    partial = filename.with_name(filename.name + ".part")
    try:
        subprocess.run(
            ["curl", "--fail", "--silent", "--show-error", "--location", "--retry", "3",
             "--proto", "=https", "--proto-redir", "=https", "--max-time", "600",
             "--output", str(partial), url],
            check=True,
        )
        if digest(partial) != expected_hash:
            raise ValueError(f"SHA-256 mismatch for {filename.name}")
        partial.replace(filename)
    finally:
        partial.unlink(missing_ok=True)
    return filename


def extract_tar(archive, destination, prefixes=(), *, copy_python_aliases=False):
    with tarfile.open(archive) as source:
        members = (member for member in source if not prefixes or member.name.startswith(prefixes))

        def filter_member(member, path):
            # CPython uses absolute aliases for some ABI libraries and terminfo data.
            # Rebase the known build prefix within the component, then apply the data filter.
            python_prefix = COMPONENT_PATH + "python/"
            if (copy_python_aliases and member.issym() and member.name.startswith(python_prefix)
                    and member.linkname.startswith("/")):
                _, build_prefix, target = member.linkname.partition("/python-download/python/")
                rebased = posixpath.normpath(python_prefix + target)
                if build_prefix and rebased.startswith(python_prefix):
                    member = member.replace(linkname=posixpath.relpath(rebased, posixpath.dirname(member.name)))
            return tarfile.data_filter(member, path)

        source.extractall(destination, members=members, filter=filter_member)


def copy_component(source, destination):
    # A runtime can be installed in any directory. Materialize aliases while the
    # entire verified dependency tree is still available.
    shutil.copytree(
        source, destination,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", "LibreOffice_*.msi"),
    )


def unpack_conda(archive, prefix, notices, scratch):
    if archive.suffix == ".conda":
        with ZipFile(archive) as package:
            for kind in ("pkg-", "info-"):
                member, = [name for name in package.namelist() if name.startswith(kind)]
                if Path(member).name != member:
                    raise ValueError(f"Unexpected member in {archive.name}")
                package.extract(member, scratch)
                destination = prefix if kind == "pkg-" else scratch
                payload = scratch / member
                if platform.system() == "Darwin":
                    # The system BSD tar on macOS does not decode these zstd streams.
                    tar = payload.with_suffix("")
                    subprocess.run(["zstd", "-q", "-d", payload, "-o", tar], check=True)
                    payload.unlink()
                    payload = tar
                subprocess.run(["tar", "-xf", payload, "-C", destination], check=True)
                payload.unlink()
    else:
        extract_tar(archive, scratch)
        for entry in scratch.iterdir():
            if entry.name != "info":
                if entry.is_dir():
                    shutil.copytree(entry, prefix / entry.name, dirs_exist_ok=True, symlinks=True)
                else:
                    shutil.copy2(entry, prefix / entry.name, follow_symlinks=False)
    licenses = scratch / "info" / "licenses"
    if licenses.is_dir():
        copy_component(licenses, notices / archive.name)


def unpack_office(archive, destination, system, scratch):
    if system == "Windows":
        # msiexec exits before the install if invoked through the shell.
        result = subprocess.run(["msiexec.exe", "/a", archive, "/qn", "REBOOT=ReallySuppress", f"TARGETDIR={scratch}"])
        if result.returncode not in (0, 3010):
            raise RuntimeError(f"LibreOffice administrative extraction exited {result.returncode}")
        suite = next(path.parent.parent for path in scratch.rglob("soffice.com")
                     if (path.parent.parent / "LICENSE.html").is_file())
        copy_component(suite, destination)
        return "office/program/soffice.com", "office/Fonts/LiberationSans-Regular.ttf"
    if system == "Darwin":
        mount = scratch / "dmg"
        mount.mkdir()
        subprocess.run(["hdiutil", "attach", archive, "-readonly", "-nobrowse",
                        "-mountpoint", mount], check=True)
        try:
            destination.mkdir()
            copy_component(mount / "LibreOffice.app", destination / "LibreOffice.app")
        finally:
            subprocess.run(["hdiutil", "detach", mount], check=True)
        return ("office/LibreOffice.app/Contents/MacOS/soffice",
                "office/LibreOffice.app/Contents/Resources/fonts/truetype/LiberationSans-Regular.ttf")

    extract_tar(archive, scratch)
    for rpm in sorted(scratch.glob("*/RPMS/*.rpm")):
        command = subprocess.Popen(["rpm2cpio", rpm], stdout=subprocess.PIPE)
        with command.stdout:
            extracted = subprocess.run(["cpio", "-idmu", "--quiet", "--no-absolute-filenames", "./opt/*"],
                                       stdin=command.stdout, cwd=scratch)
        if command.wait() or extracted.returncode:
            raise RuntimeError(f"Cannot extract {rpm.name}")
    suite, = scratch.glob("opt/libreoffice*")
    copy_component(suite, destination)
    return "office/program/soffice", "office/share/fonts/truetype/LiberationSans-Regular.ttf"


def package_version(metadata):
    return next(line.split(": ", 1)[1] for line in metadata.read_text(encoding="utf-8").splitlines()
                if line.startswith("Version: "))


def assemble(options):
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    directory = options.downloads.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    dest = options.destination.resolve()
    dest.mkdir()
    system, machines, subdir = TARGETS[options.target]
    if platform.system() != system or platform.machine() not in machines:
        raise ValueError(f"{options.target} must be assembled on its native architecture")
    inputs = lock["targets"][options.target]
    packages = lock["conda"][subdir]
    all_assets = inputs | lock["shared"]
    print(f"Fetching checked runtime inputs for {options.target}", flush=True)
    with ThreadPoolExecutor(max_workers=6) as pool:
        paths = dict(zip(all_assets, pool.map(lambda item: download(item, directory), all_assets.values())))
        archives = list(pool.map(lambda package: download(package, directory), packages))

    artifact_rel = "node/node_modules/@oai/artifact-tool"
    packaged_components = ["python", "native/git", "native/libheif", "native/jxrlib", artifact_rel]
    licenses = dest / "licenses"
    licenses.mkdir()
    for file in ("cpython-license", "git-license", "libheif-license", "jxrlib-license", "cjk-license", "ocr-license"):
        shutil.copy2(paths[file], licenses / f"{file}.txt")
    extract_tar(paths["poppler-source"], licenses, ("poppler-26.05.0/COPYING",))
    with TemporaryDirectory(prefix="za-runtime-", dir=options.scratch.resolve() if options.scratch else None) as scratch_name:
        scratch = Path(scratch_name)
        print("Assembling CPython, Git, image tools, Node.js and Artifact Tool", flush=True)
        extract_tar(paths["component_bundle"], scratch,
                    tuple(COMPONENT_PATH + name for name in packaged_components), copy_python_aliases=True)
        base = scratch / COMPONENT_PATH
        copy_component(base / "python", dest / "python")
        for path in ("git", "libheif", "jxrlib"):
            copy_component(base / "native" / path, dest / path)
        with TemporaryDirectory(dir=scratch) as node_scratch:
            if system == "Windows":
                with ZipFile(paths["node"]) as node:
                    node.extractall(node_scratch)
            else:
                extract_tar(paths["node"], Path(node_scratch))
            node_root, = Path(node_scratch).iterdir()
            copy_component(node_root, dest / "node")
        (dest / artifact_rel).parent.mkdir(parents=True, exist_ok=True)
        copy_component(base / artifact_rel, dest / artifact_rel)
        print("Assembling Tesseract, Poppler and libarchive with their locked libraries", flush=True)
        conda = scratch / "conda"
        conda.mkdir()
        notices = licenses / "conda"
        notices.mkdir()
        for archive in archives:
            with TemporaryDirectory(dir=scratch) as package_scratch:
                unpack_conda(archive, conda, notices, Path(package_scratch))
        for models in (conda / "share/tessdata", conda / "Library/share/tessdata"):
            if models.is_dir():
                shutil.rmtree(models)
        copy_component(conda, dest / "native")

        print("Assembling LibreOffice and fonts", flush=True)
        office_scratch = scratch / "office-input"
        office_scratch.mkdir()
        soffice, latin_font = unpack_office(paths["soffice"], dest / "office", system, office_scratch)

    (dest / "fonts").mkdir()
    (dest / "tessdata/configs").mkdir(parents=True)
    shutil.copy2(paths["cjk_font"], dest / "fonts" / "NotoSansSC-VF.ttf")
    shutil.copy2(paths["ocr-pdf-config"], dest / "tessdata/configs/pdf")
    shutil.copy2(paths["ocr-pdf-font"], dest / "tessdata/pdf.ttf")
    for name in ("eng", "chi_sim", "chi_tra"):
        shutil.copy2(paths[name], dest / "tessdata" / f"{name}.traineddata")

    extension = ".exe" if system == "Windows" else ""
    bin_dir = "native/Library/bin" if extension else "native/bin"
    site_packages = dest / "python" / ("Lib/site-packages" if extension else "lib/python3.12/site-packages")
    pdfium, = site_packages.glob("pypdfium2-*.dist-info")
    pdfium_license = pdfium / "licenses/LICENSES/BSD-3-Clause.txt"
    office_licenses = sorted((dest / "office").rglob("LICENSE.html"))
    office_license, = [p for p in office_licenses if p.parent in
                       (dest / "office", dest / "office/LibreOffice.app/Contents/Resources")]
    artifact_version = json.loads((dest / artifact_rel / "package.json").read_text(encoding="utf-8"))["version"]
    entries = {
        "node": "node/node.exe" if extension else "node/bin/node",
        "artifact_tool": artifact_rel + "/dist/artifact_tool.mjs",
        "python": "python/python.exe" if extension else "python/bin/python3.12",
        "git": "git/cmd/git.exe" if extension else "git/bin/git",
        "pdfium": (site_packages / "pypdfium2/__init__.py").relative_to(dest).as_posix(),
        "soffice": soffice,
        "tesseract": f"{bin_dir}/tesseract{extension}",
        "poppler_bin": bin_dir,
        "unzip": f"{bin_dir}/bsdtar{extension}",
        "heif_convert": f"libheif/libheif/bin/heif-convert{extension}",
        "jxr_decoder": f"jxrlib/jxrlib/bin/JxrDecApp{extension}",
        "cjk_font": "fonts/NotoSansSC-VF.ttf",
        "latin_font": latin_font,
        "tessdata": "tessdata",
    }
    bundle = inputs["component_bundle"]["url"]
    git_version = subprocess.check_output([dest / entries["git"], "--version"], text=True).strip().removeprefix("git version ")
    def component(version, source, license_file):
        if not (dest / license_file).is_file():
            raise ValueError(f"Missing dependency license: {license_file}")
        return {"version": version, "source": source, "license": license_file}

    def conda_component(name, license_file=None):
        package, = [item for item in packages if item["name"] == name]
        if license_file is None:
            notice = licenses / "conda" / Path(urlparse(package["url"]).path).name
            license_path = next(file for file in sorted(notice.rglob("*")) if file.is_file())
            license_file = license_path.relative_to(dest).as_posix()
        return component(package["version"], package["url"], license_file)

    components = {
        "node": component("24.22.1", inputs["node"]["url"], "node/LICENSE"),
        "artifact_tool": component(artifact_version, bundle, artifact_rel + "/LICENSE.md"),
        "python": component("3.12.14", bundle, "licenses/cpython-license.txt"),
        "pdfium": component(package_version(pdfium / "METADATA"), bundle, pdfium_license.relative_to(dest).as_posix()),
        "git": component(git_version, bundle, "licenses/git-license.txt"),
        "heif_convert": component("1.23.2", bundle, "licenses/libheif-license.txt"),
        "jxr_decoder": component("1.1", bundle, "licenses/jxrlib-license.txt"),
        "tesseract": conda_component("tesseract"),
        "poppler": conda_component("poppler", "licenses/poppler-26.05.0/COPYING"),
        "unzip": conda_component("libarchive"),
        "soffice": component("26.2.7", inputs["soffice"]["url"], office_license.relative_to(dest).as_posix()),
        "cjk_font": component("2.004", lock["shared"]["cjk_font"]["url"], "licenses/cjk-license.txt"),
        "latin_font": component("LibreOffice 26.2.7", inputs["soffice"]["url"], office_license.relative_to(dest).as_posix()),
        "ocr_models": component("4.1.0", lock["shared"]["eng"]["url"], "licenses/ocr-license.txt"),
    }
    for name, location in entries.items():
        if not (dest / location).exists():
            raise ValueError(f"Missing runtime entry {name}: {location}")
    file_hashes = {}
    for file in sorted(dest.rglob("*")):
        if file.is_symlink():
            raise ValueError(f"Runtime contains a linked file: {file}")
        if file.is_file():
            file_hashes[file.relative_to(dest).as_posix()] = digest(file)
    manifest = {"format": 1, "target": options.target, **entries, "components": components, "files": file_hashes}
    (dest / "runtime.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=TARGETS)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--downloads", type=Path, required=True)
    parser.add_argument("--scratch", type=Path)
    assemble(parser.parse_args())
