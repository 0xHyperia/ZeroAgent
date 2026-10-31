"""Synthetic, owned Linux workspace for the opt-in Gateway delivery test.

This is a test transport, not an E2B substitute or a model quality evaluation.
The actual production packager runs unchanged in a separate Python process.
"""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid


request = json.load(sys.stdin)
mode = request["mode"]
if mode == "init":
    root = Path(tempfile.mkdtemp(prefix="zeroagent-site-delivery-")).resolve()
    marker = uuid.uuid4().hex
    (root / "integration.fixture").write_text(marker)
    (root / "project/src").mkdir(parents=True)
    (root / "project/.env").write_text("SYNTHETIC_PRIVATE_BUILD_CONFIG=exclude-me")
    (root / "unrelated.txt").write_text("UNRELATED_WORKSPACE_FILE")
    (root / "project/src/index.html").write_text(
        '<!doctype html><html><meta charset="utf-8"><title>资料空间 v__VERSION__</title>'
        '<link rel="stylesheet" href="style.css"><button id="counter">v__VERSION__</button>'
        '<script src="app.js"></script></html>')
    (root / "project/src/app.js").write_text(
        "document.getElementById('counter').onclick=e=>e.target.textContent='clicked'")
    (root / "project/src/style.css").write_text("body{font-family:system-ui}button{padding:16px}")
    (root / "project/build.py").write_text(
        "from pathlib import Path\n"
        "import shutil\n"
        "state=Path('build-count.txt')\n"
        "version=int(state.read_text())+1 if state.exists() else 1\n"
        "state.write_text(str(version))\n"
        "shutil.copytree('src','dist',dirs_exist_ok=True)\n"
        "p=Path('dist/index.html')\n"
        "p.write_text(p.read_text().replace('__VERSION__',str(version)))\n"
        "assert Path('dist/app.js').is_file()\n"
        "print('built static site v'+str(version))\n")
    result = {"root": str(root), "marker": marker}
else:
    root = Path(request["root"])
    assert root.is_absolute() and root.resolve() == root
    assert root.parent == Path(tempfile.gettempdir()).resolve()
    assert root.name.startswith("zeroagent-site-delivery-")
    assert (root / "integration.fixture").read_text() == request["marker"]
    if mode == "build":
        assert request["command"] == "python3 build.py" and request["cwd"] == "project"
        process = subprocess.run(
            [sys.executable, "-I", "build.py"], cwd=root / "project",
            capture_output=True, timeout=10)
        result = {"stdout": process.stdout.decode(), "stderr": process.stderr.decode(),
                  "exit_code": process.returncode}
    elif mode == "bundle":
        source = base64.b64decode(request["source_base64"]).decode()
        process = subprocess.run(
            [sys.executable, "-I", "-c", source],
            input=json.dumps({"root": str(root), "path": request["path"],
                              "output_path": request["output_path"]}).encode(),
            capture_output=True, timeout=40)
        assert process.returncode == 0, process.stderr.decode()
        result = json.loads(process.stdout)
        assert "error" not in result, result
        output = root / result["path"]
        assert output.resolve().is_relative_to(root / "site-bundles")
        result["zip_base64"] = base64.b64encode(output.read_bytes()).decode()
    elif mode == "cleanup":
        # The exact temporary absolute root, parent and marker were checked above.
        shutil.rmtree(root)
        result = {"removed": not root.exists()}
    else:
        raise ValueError("unsupported fixture mode")
print(json.dumps(result, ensure_ascii=True))
