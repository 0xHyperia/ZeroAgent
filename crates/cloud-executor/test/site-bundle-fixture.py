"""Synthetic Linux acceptance for the exact packaged guest, no user files."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

source = base64.b64decode(sys.argv[1]).decode()
cases = []


def invoke(root, path='dist', output_path=None):
    output_path = output_path or 'site-bundles/' + 'a' * 64 + '.zip'
    completed = subprocess.run([sys.executable, '-I', '-c', source], input=json.dumps({'root': str(root), 'path': path, 'output_path': output_path}), capture_output=True, text=True, timeout=45)
    assert completed.returncode == 0, (completed.returncode, completed.stderr)
    result = json.loads(completed.stdout)
    return result


def valid(root):
    (root / 'dist').mkdir()
    (root / 'dist/index.html').write_text('<!doctype html><p>中文站点</p><script src="assets/app.js"></script>')
    (root / 'dist/assets').mkdir()
    (root / 'dist/assets/app.js').write_text("console.log('client script; packaging must not execute it');")
    (root / 'private-outside.txt').write_text('unrelated synthetic data must not be included')


def rejected(name, mutate, path='dist', output=None):
    with tempfile.TemporaryDirectory(prefix='za-site-reject-') as directory:
        root = Path(directory)
        valid(root)
        mutate(root)
        result = invoke(root, path, output)
        assert result.get('error'), (name, result)
        destination = root / ('site-bundles/' + 'a' * 64 + '.zip')
        if name != 'existing output':
            assert not destination.exists(), name
        if (root / 'site-bundles').is_dir() and not (root / 'site-bundles').is_symlink():
            assert not list((root / 'site-bundles').glob('.site-pending-*')), name
        cases.append(name)


with tempfile.TemporaryDirectory(prefix='za-site-actual-') as directory:
    root = Path(directory)
    valid(root)
    (root / 'dist/中文.json').write_text('{"合成":true}')
    result = invoke(root)
    assert not result.get('error'), result
    data = (root / result['path']).read_bytes()
    assert result['sha256'] == hashlib.sha256(data).hexdigest()
    assert result['size'] == len(data)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert sorted(archive.namelist()) == ['assets/app.js', 'index.html', '中文.json']
        assert archive.testzip() is None
        assert result['expanded_bytes'] == sum(entry.file_size for entry in archive.infolist())
        assert result['file_count'] == len(archive.infolist())
    sample = base64.b64encode(data).decode()
    cases.append('actual HTML/JS/Unicode ZIP and full digest')

for path in ['.', '..', '../dist', '/dist', 'x//y', 'x'+chr(92)+'y', 'dist:stream', 'dist?query', 'dist#fragment', 'dist%2fescape', '.private', 'site-bundles', 'node_modules', 'x/../dist']:
    rejected('source path ' + path, lambda root: None, path)
for output in ['dist/output.zip', '../escape.zip', 'site-bundles/not-a-digest.zip', 'site-bundles/'+'b'*64+'.zip/other']:
    rejected('output path ' + output, lambda root: None, output=output)
for name in ['.env', '.npmrc', '.git/config', 'node_modules/a.js', 'credentials.json', 'id_rsa', 'server.py', 'application.exe', 'assets/app.js.map']:
    def create(root, name=name):
        file = root / 'dist' / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text('synthetic forbidden build entry')
    rejected('forbidden entry ' + name, create)
rejected('missing entry', lambda root: (root / 'dist/index.html').unlink())
rejected('empty entry', lambda root: (root / 'dist/index.html').write_bytes(b''))
rejected('file symlink', lambda root: (root / 'dist/link.txt').symlink_to(root / 'private-outside.txt'))
rejected('directory symlink', lambda root: (root / 'dist/link').symlink_to(root, target_is_directory=True))
rejected('source symlink', lambda root: (root / 'linked').symlink_to(root / 'dist', target_is_directory=True), path='linked')
rejected('file hardlink', lambda root: os.link(root / 'private-outside.txt', root / 'dist/link.txt'))
rejected('FIFO', lambda root: os.mkfifo(root / 'dist/fifo.txt'))
rejected('case collision', lambda root: (root / 'dist/assets/App.js').write_text('collision'))
rejected('oversized regular file', lambda root: (root / 'dist/big.js').open('wb').truncate(8 * 1024 * 1024 + 1))


def expanded(root):
    for index in range(9):
        with (root / f'dist/big-{index}.js').open('wb') as stream:
            stream.truncate(8 * 1024 * 1024)


def too_many(root):
    for index in range(2000):
        (root / f'dist/empty-{index}.txt').touch()


def existing(root):
    (root / 'site-bundles').mkdir()
    file = root / ('site-bundles/' + 'a' * 64 + '.zip')
    file.write_text('preserved synthetic prior output')


def compressed(root):
    for index in range(5):
        (root / f'dist/random-{index}.wasm').write_bytes(os.urandom(7 * 1024 * 1024))


rejected('expanded total', expanded)
rejected('entry count', too_many)
rejected('existing output', existing)
rejected('compressed archive bytes', compressed)
print(json.dumps({'passed': True, 'cases': cases, 'sample_zip_base64': sample, 'executes_build_code': False}))
