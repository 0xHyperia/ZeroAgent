"""Exercise installed document tools in an isolated Python process."""

import json
import os
import platform
import re
import runpy
import sys
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory


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

suffix = ".exe" if os.name == "nt" else ""
soffice = Path(os.environ["ZEROAGENT_FILE_SOFFICE"]).resolve(strict=True)
poppler = Path(os.environ["ZEROAGENT_FILE_POPPLER_BIN"]).resolve(strict=True)
approved_children = {soffice, *(
    (poppler / f"{name}{suffix}").resolve(strict=True)
    for name in ("pdfinfo", "pdftoppm")
)}
if not all(path.is_file() and path.is_relative_to(runtime) for path in approved_children):
    raise RuntimeError("A document rendering executable resolves outside the bundled runtime")


def offline(event, args):
    if event in {"socket.connect", "socket.getaddrinfo", "os.system"}:
        raise RuntimeError(f"Unavailable during acceptance: {event}")
    if event == "subprocess.Popen":
        command = args[0]
        if command is None and os.name == "nt":
            # Windows reports the encoded command line when executable= was omitted.
            first = re.match(r'^(?:"([^"]+)"|(\S+))', args[1])
            command = (first[1] or first[2]) if first else None
        if command is None:
            raise RuntimeError("The renderer executable was not specified")
        executable = Path(os.fsdecode(command))
        if not executable.is_absolute() or executable.resolve() not in approved_children:
            raise RuntimeError(f"Acceptance only permits bundled document renderers: {executable}")


sys.addaudithook(offline)

import docx
import pypdf
import pypdfium2
import reportlab
from PIL import Image
import pdf2image
from reportlab.pdfgen.canvas import Canvas
from file_tool import main

for module in (docx, pdf2image, pypdf, pypdfium2, reportlab, Image):
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


def render_word(root):
    renderer = Path(__file__).resolve().parents[2] / (
        "crates/agent-gateway/internal/account/skills/documents/render_docx.py"
    )
    destination = root / "word-pages"
    args = sys.argv
    try:
        sys.argv = [str(renderer), str(root / "revised.docx"), "--output_dir",
                    str(destination), "--emit_pdf", "--dpi", "96"]
        with redirect_stdout(StringIO()):
            runpy.run_path(str(renderer), run_name="__main__")
    finally:
        sys.argv = args

    for index in (1, 2):
        with Image.open(destination / f"page-{index}.png") as page:
            assert page.format == "PNG" and min(page.size) > 100
            assert page.convert("L").getextrema()[0] < 230
    pages = pypdf.PdfReader(destination / "revised.pdf").pages
    assert len(pages) == 2
    assert "Version 2" in pages[0].extract_text()
    assert "Unchanged second Word page" in pages[1].extract_text()


with TemporaryDirectory(prefix="zeroagent-installed-reader-") as directory:
    root = Path(directory)
    document = docx.Document()
    document.add_paragraph("Unchanged paragraph")
    document.add_paragraph("Version 1")
    document.add_page_break()
    document.add_paragraph("Unchanged second Word page")
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
    assert [p.text for p in docx.Document(root / "revised.docx").paragraphs if p.text.strip()] == [
        "Unchanged paragraph", "Version 2", "Unchanged second Word page",
    ]
    pages = pypdf.PdfReader(root / "revised.pdf").pages
    assert len(pages) == 2
    assert pages[0].extract_text().strip() == "Version 2"
    assert pages[1].extract_text().strip() == "Unchanged page"
    call_tool(root, "pdf", "render", {"source": "revised.pdf", "output": "revised.png", "page": 1})
    render_word(root)

new_bytecode = sorted(
    item for path in runtime.rglob("*.pyc")
    if (item := path.relative_to(runtime).as_posix()) not in manifest["files"]
)
if new_bytecode:
    examples = ", ".join(new_bytecode[:5])
    raise RuntimeError(f"Document conversion generated {len(new_bytecode)} bytecode files in the runtime: {examples}")

print(json.dumps({
    "python": str(python), "pythonVersion": python_version,
    "docx": "passed", "pdf": "passed", "word_render": "passed", "word_pdf": "passed",
    "runtime_bytecode": "clean",
    "python_network": "blocked-by-audit-hook", "libreoffice": str(soffice),
}))
