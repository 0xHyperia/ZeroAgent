"""Structured file operations for the ZeroAgent execution workspace."""

import argparse
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

# Isolated Python mode omits the script directory. Only load sibling runtime modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from office import office_operation
from pdf_tools import pdf_operation
from runtime_common import FileToolError, FORMATS, Workspace

OPERATIONS = ("inspect", "create", "edit", "convert", "render", "verify")


def artifact_operation(workspace, kind, operation, source, output, request, scratch):
    from runtime_common import checked_zip, engine_path, run_engine

    if source is not None:
        checked_zip(source).close()

    inputs = {}
    if kind == "presentations":
        for slide in request.get("slides", []):
            for item in slide.get("objects", []):
                if item.get("type") == "image":
                    reference = item["source"]
                    asset = workspace.source(reference)
                    copy = scratch / f"image-{len(inputs)}{asset.suffix}"
                    workspace.snapshot(asset, copy, workspace.digest(asset))
                    inputs[reference] = str(copy)
    job = scratch / "artifact-tool.json"
    job.write_text(json.dumps({
        "kind": kind, "operation": operation, "source": str(source) if source else None,
        "output": str(output), "request": request, "inputs": inputs,
    }), encoding="utf-8")
    script = Path(__file__).with_name("artifact_tool.mjs")
    result = scratch / "artifact-tool-result.json"
    run_engine([engine_path("ZEROAGENT_FILE_NODE"), str(script), str(job), str(result)], scratch)
    return json.loads(result.read_text(encoding="utf-8"))


def use_artifact_tool(kind, operation, source, request):
    if kind not in ("spreadsheet", "presentations") or operation not in ("create", "render"):
        return False
    if source is not None and source.suffix.lower() not in (".xlsx", ".pptx"):
        return False
    engine = request.get("engine")
    if engine == "artifact":
        return True
    if engine == "office" or not os.environ.get("ZEROAGENT_FILE_ARTIFACT_ENTRY"):
        return False
    if operation == "render":
        return True
    if kind == "spreadsheet":
        return not request.get("names") and all(
            not spec.get("validation") and not spec.get("data_tables")
            for spec in request.get("sheets", [])
        )
    return all(
        "layout" not in slide and all(
            item.get("type") in ("text", "shape", "chart", "image")
            and not item.get("link")
            and not str(item.get("shape", "")).isupper()
            and not str(item.get("chart", "")).isupper()
            for item in slide.get("objects", [])
        )
        for slide in request.get("slides", [])
    )


def request_from(stream):
    raw = stream.read(128 * 1024 + 1)
    if len(raw) > 128 * 1024:
        raise FileToolError("request_too_large", "Request exceeds 128 KiB.")
    value = json.loads(raw, parse_constant=reject_nonfinite)
    if not isinstance(value, dict):
        raise FileToolError("invalid_request", "Supply a JSON object.")
    return value


def reject_nonfinite(value):
    raise FileToolError("invalid_number", f"JSON numeric value {value} is not finite.")


def run(workspace, kind, operation, request):
    source = None
    version = request.get("source_version")
    if operation != "create" or request.get("source") is not None:
        source = workspace.source(request.get("source"))
        if source.suffix.lower() not in FORMATS[kind]:
            raise FileToolError("invalid_format", "The file extension does not match the selected skill.")
        if operation == "edit" and (not isinstance(version, str) or len(version) != 64):
            raise FileToolError("source_version_required", "Inspect the source and supply its SHA-256.")
        source_version = workspace.digest(source)
        if version is not None and version != source_version:
            raise FileToolError("source_changed", "The source has changed since it was inspected.")
    destination = None
    if operation in ("create", "edit", "convert", "render"):
        destination = workspace.destination(request.get("output"))
        if operation == "render":
            allowed = {".png"}
        elif operation == "convert":
            allowed = {".txt"} if kind == "pdf" else set(FORMATS[kind]) | {".pdf"}
        else:
            allowed = {FORMATS[kind][0]}
        if destination.suffix.lower() not in allowed:
            raise FileToolError("invalid_output_format", "Choose an output extension supported by this operation.")

    with TemporaryDirectory(prefix=".file-runtime-", dir=workspace.root) as directory:
        scratch = Path(directory)
        if source is not None:
            original = scratch / ("source" + source.suffix.lower())
            workspace.snapshot(source, original, source_version)
        else:
            original = None
        staged = scratch / ("result" + destination.suffix.lower()) if destination else None
        engine = pdf_operation if kind == "pdf" else office_operation
        if use_artifact_tool(kind, operation, source, request):
            engine = artifact_operation
        result = engine(workspace, kind, operation, original, staged, request, scratch)
        if source is not None:
            result["source_version"] = source_version
        if staged is not None:
            if not staged.is_file():
                raise FileToolError("no_output", "The engine produced no output file.")
            output_kind = next((name for name, formats in FORMATS.items() if staged.suffix in formats), None)
            if output_kind is not None:
                verifier = pdf_operation if output_kind == "pdf" else office_operation
                result["verification"] = verifier(workspace, output_kind, "verify", staged, None, {}, scratch)
            elif staged.suffix == ".png":
                from PIL import Image

                with Image.open(staged) as image:
                    result["verification"] = {"format": "png", "width": image.width, "height": image.height}
                    image.verify()
            else:
                with staged.open(encoding="utf-8") as text:
                    result["verification"] = {"format": "txt", "line_count": sum(1 for _ in text)}
            if source is not None and workspace.digest(source) != source_version:
                raise FileToolError("source_changed", "The source changed during processing.")
            result["output_version"] = workspace.digest(staged)
            workspace.publish(staged, destination)
            result["output"] = destination.relative_to(workspace.root).as_posix()
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("format", choices=FORMATS)
    parser.add_argument("operation", choices=OPERATIONS)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--request", help="Request JSON file inside the workspace. Defaults to stdin.")
    args = parser.parse_args()
    try:
        workspace = Workspace(args.workspace)
        if args.request:
            with workspace.source(args.request).open("rb") as stream:
                request = request_from(stream)
        else:
            request = request_from(sys.stdin.buffer)
        result = run(workspace, args.format, args.operation, request)
    except FileToolError as error:
        print(json.dumps({"ok": False, "code": error.code, "message": str(error)}, ensure_ascii=True))
        return 1
    except ModuleNotFoundError as error:
        print(json.dumps({"ok": False, "code": "runtime_unavailable", "message": f"Runtime dependency missing: {error.name}"}))
        return 1
    except (ValueError, TypeError, KeyError, IndexError, OSError, RuntimeError) as error:
        print(json.dumps({"ok": False, "code": "file_operation_failed", "message": f"Unable to process the request ({type(error).__name__})."}))
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
