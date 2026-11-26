"""Check the prepared runtime with synthetic files before making it available."""

import os
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory


def main(runtime):
    runtime = runtime.resolve(strict=True)
    if not Path(sys.executable).resolve(strict=True).is_relative_to(runtime):
        raise RuntimeError("The tool check must use the prepared interpreter")

    office = Path(os.environ["ZEROAGENT_FILE_SOFFICE"]).resolve(strict=True)
    if not office.is_file() or not office.is_relative_to(runtime):
        raise RuntimeError("The Office engine must be in the prepared runtime")

    def offline(event, args):
        if event in {"socket.connect", "socket.getaddrinfo", "os.system"}:
            raise RuntimeError("The tool check does not require network access")
        if event == "subprocess.Popen":
            executable = args[0]
            if executable is None and os.name == "nt":
                first = re.match(r'^(?:"([^"]+)"|(\S+))', args[1])
                executable = (first[1] or first[2]) if first else None
            if not executable or Path(os.fsdecode(executable)).resolve() != office:
                raise RuntimeError("Unexpected executable during the tool check")

    sys.addaudithook(offline)
    sys.path.insert(0, str(runtime / "tools"))
    import docx
    from file_tool import run
    from PIL import Image
    from pypdf import PdfReader
    from runtime_common import Workspace

    with TemporaryDirectory(prefix="zeroagent-tools-check-") as directory:
        root = Path(directory)
        workspace = Workspace(root)
        document = docx.Document()
        document.add_paragraph("ZeroAgent workspace tools")
        document.add_paragraph("Before editing")
        source = root / "source.docx"
        document.save(source)
        version = run(workspace, "documents", "inspect", {"source": source.name})["source_version"]

        run(workspace, "documents", "edit", {
            "source": source.name,
            "source_version": version,
            "output": "edited.docx",
            "operations": [{
                "op": "replace_text", "paragraph": 1,
                "before": "Before editing", "after": "After editing",
            }],
        })
        if workspace.digest(source) != version:
            raise RuntimeError("The tool check changed the source document")
        run(workspace, "documents", "convert", {"source": "edited.docx", "output": "before.pdf"})
        output = root / "before.pdf"
        if "After editing" not in PdfReader(output).pages[0].extract_text():
            raise RuntimeError("Word export did not contain the verified edit")

        pdf_version = run(workspace, "pdf", "inspect", {"source": output.name})["source_version"]
        run(workspace, "pdf", "edit", {
            "source": output.name,
            "source_version": pdf_version,
            "output": "edited.pdf",
            "operations": [{
                "op": "comment", "page": 1, "text": "Verified comment",
                "region": {"left": 0.1, "top": 0.2, "width": 0.3, "height": 0.1},
            }],
        })
        if workspace.digest(output) != pdf_version:
            raise RuntimeError("The tool check changed the source PDF")
        annotations = PdfReader(root / "edited.pdf").pages[0].get("/Annots", [])
        if not any(item.get_object().get("/Contents") == "Verified comment" for item in annotations):
            raise RuntimeError("The PDF edit did not contain the verified comment")
        run(workspace, "pdf", "render", {"source": "edited.pdf", "output": "preview.png", "page": 1})
        with Image.open(root / "preview.png") as preview:
            if preview.format != "PNG" or min(preview.size) < 100:
                raise RuntimeError("The PDF preview was incomplete")
            preview.verify()


if __name__ == "__main__":
    main(Path(sys.argv[1]))
