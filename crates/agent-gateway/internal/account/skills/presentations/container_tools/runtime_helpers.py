import os
from pathlib import Path


def _required_runtime_path(env_name: str, *, directory: bool) -> Path:
    raw_value = os.environ.get(env_name)
    if not raw_value:
        raise RuntimeError(f"{env_name} is required.")
    value = Path(raw_value)
    if not value.is_absolute():
        raise RuntimeError(f"{env_name} must be an absolute path.")
    if directory and not value.is_dir():
        raise RuntimeError(f"{env_name} is not a directory: {value}")
    if not directory and not value.is_file():
        raise RuntimeError(f"{env_name} is not a file: {value}")
    return value


def _binary_candidates(bin_dir: Path, name: str) -> tuple[Path, ...]:
    suffixes = (".exe", "") if os.name == "nt" else ("",)
    return tuple(bin_dir / f"{name}{suffix}" for suffix in suffixes)


def runtime_node() -> str:
    node = _required_runtime_path("RUNTIME_NODE", directory=False)
    if os.name != "nt" and not os.access(node, os.X_OK):
        raise RuntimeError(f"RUNTIME_NODE is not executable: {node}")
    return str(node)


def runtime_binary(name: str) -> str:
    if name in ("pdfinfo", "pdftoppm"):
        directory = _required_runtime_path("ZEROAGENT_FILE_POPPLER_BIN", directory=True)
        for candidate in _binary_candidates(directory, name):
            if candidate.is_file():
                return str(candidate)
        raise RuntimeError(f"ZeroAgent Poppler executable is missing: {name}")
    optional = {"JxrDecApp": "ZEROAGENT_FILE_JXR_DECODER", "heif-convert": "ZEROAGENT_FILE_HEIF_CONVERT"}
    if name in optional:
        return str(_required_runtime_path(optional[name], directory=False))
    raise RuntimeError(f"Unknown ZeroAgent runtime binary: {name}")


def runtime_bin_dir(*required_binaries: str) -> str:
    directory = _required_runtime_path("ZEROAGENT_FILE_POPPLER_BIN", directory=True)
    for name in required_binaries:
        if Path(runtime_binary(name)).parent != directory:
            raise RuntimeError(f"{name} is outside the configured Poppler directory")
    return str(directory)
