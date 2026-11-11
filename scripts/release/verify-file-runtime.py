"""Exercise installed document tools in an isolated Python process."""

import json
import platform
import sys
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory


def offline(event, _args):
    if event in {"socket.connect", "socket.getaddrinfo", "subprocess.Popen", "os.system"}:
        raise RuntimeError(f"External execution is unavailable during acceptance: {event}")


sys.addaudithook(offline)
runtime = Path(sys.argv[1]).resolve(strict=True)
manifest = json.loads((runtime / "runtime.json").read_text(encoding="utf-8"))
python = (runtime / manifest["python"]).resolve(strict=True)
if Path(sys.executable).resolve(strict=True) != python or not python.is_relative_to(runtime):
    raise RuntimeError("The acceptance test is not using the bundled Python")
python_version = platform.python_version()
expected_version = manifest.get("components", {}).get("python", {}).get("version")
if expected_version is not None and expected_version != python_version:
    raise RuntimeError(f"Bundled Python is {python_version}, expected {expected_version}")
sys.path.insert(0, str(runtime / "tools"))

import docx
import pypdf
import pypdfium2
import reportlab
from reportlab.pdfgen.canvas import Canvas
from file_tool import main

for module in (docx, pypdf, pypdfium2, reportlab):
    if not Path(module.__file__).resolve(strict=True).is_relative_to(runtime):
        raise RuntimeError(f"{module.__name__} loaded from outside the installed runtime")


def call_tool(root, kind, operation, request):
    request_path = root / "request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")
    args = sys.argv
    try:
        sys.argv = [str(runtime / "tools" / "file_tool.py"), kind, operation,
                    "--workspace", str(root), "--request", request_path.name]
        with redirect_stdout(StringIO()) as stdout:
            status = main()
        result = json.loads(stdout.getvalue())
        if status != 0 or result.get("ok") is not True:
            raise RuntimeError(f"{kind} {operation} failed: {result}")
        return result
    finally:
        sys.argv = args


with TemporaryDirectory(prefix="zeroagent-installed-reader-") as directory:
    root = Path(directory)
    document = docx.Document()
    document.add_paragraph("Unchanged paragraph")
    document.add_paragraph("Version 1")
    document.save(root / "source.docx")
    pdf = Canvas(str(root / "source.pdf"))
    pdf.drawString(48, 750, "Version 1")
    pdf.showPage()
    pdf.drawString(48, 750, "Unchanged page")
    pdf.save()

    for kind, suffix, anchor in [
        ("documents", "docx", {"paragraph": 1}),
        ("pdf", "pdf", {"page": 1}),
    ]:
        source = f"source.{suffix}"
        output = f"revised.{suffix}"
        original = (root / source).read_bytes()
        info = call_tool(root, kind, "inspect", {"source": source})
        result = call_tool(root, kind, "edit", {
            "source": source,
            "source_version": info["source_version"],
            "output": output,
            "operations": [{"op": "replace_text", "before": "Version 1", "after": "Version 2", **anchor}],
        })
        assert result["verification"] and result["output"] == output
        assert (root / source).read_bytes() == original
    assert [p.text for p in docx.Document(root / "revised.docx").paragraphs] == [
        "Unchanged paragraph", "Version 2",
    ]
    pages = pypdf.PdfReader(root / "revised.pdf").pages
    assert len(pages) == 2
    assert pages[0].extract_text().strip() == "Version 2"
    assert pages[1].extract_text().strip() == "Unchanged page"
    call_tool(root, "pdf", "render", {"source": "revised.pdf", "output": "revised.png", "page": 1})

print(json.dumps({
    "python": str(python), "pythonVersion": python_version,
    "docx": "passed", "pdf": "passed", "network": "blocked-by-audit-hook",
}))
