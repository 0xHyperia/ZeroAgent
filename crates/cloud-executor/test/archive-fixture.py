"""Synthetic guest fixture; no E2B API, no downloaded code, no user originals."""
import base64
import hashlib
import io
import json
import os
import pathlib
import stat
import struct
import subprocess
import sys
import tempfile
import warnings
import zipfile

source = base64.b64decode(sys.argv[1]).decode()


def archive(entries, compression=zipfile.ZIP_STORED):
    output = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        with zipfile.ZipFile(output, 'w', compression=compression) as bundle:
            for name, data in entries:
                bundle.writestr(name, data)
    return output.getvalue()


with tempfile.TemporaryDirectory(prefix='zeroagent-archive-fixture-') as temporary:
    root = pathlib.Path(temporary) / 'workspace'
    root.mkdir(mode=0o700)
    outside = pathlib.Path(temporary) / 'outside'
    outside.mkdir()
    (outside / 'secret').write_text('private')
    checked = []

    def call(name, data, expected=None, destination='extracted', digest=None, source_path=None, entry=None):
        path = source_path or name
        if source_path is None:
            (root / path).write_bytes(data)
        payload = {'root': str(root), 'path': path, 'destination': destination, 'source_sha256': digest or hashlib.sha256(data).hexdigest()}
        result = subprocess.run([sys.executable, '-I', '-c', entry or source], input=json.dumps(payload), text=True, capture_output=True, timeout=40)
        assert result.returncode == 0, (name, result.stderr)
        reply = json.loads(result.stdout)
        if expected:
            if isinstance(expected, tuple):
                assert reply.get('error') in expected, (name, reply)
            else:
                assert reply.get('error') == expected, (name, reply)
            assert not any(p.name.startswith('.zeroagent-archive-') for p in root.iterdir()), name
        else:
            assert 'error' not in reply, (name, reply)
            assert reply['source_sha256'] == payload['source_sha256'] and reply['destination'] == destination
            assert reply['file_count'] == len(reply['files'])
            assert reply['total_bytes'] == sum(item['size'] for item in reply['files'])
            for item in reply['files']:
                actual = (root / item['path']).read_bytes()
                assert item['sha256'] == hashlib.sha256(actual).hexdigest() and item['size'] == len(actual)
                assert stat.S_IMODE((root / item['path']).stat().st_mode) == 0o600
            assert stat.S_IMODE((root / destination).stat().st_mode) == 0o700
        if source_path is None:
            (root / path).unlink()
        checked.append(name)
        return reply

    code = archive([('project/', b''), ('project/main.py', b'def add(a,b):\n return a+b\n'), ('project/test_main.py', b'from main import add\ndef test_add():\n assert add(2,3)==5\n'), ('README.md', '代码作为数据，不自动执行'.encode())], zipfile.ZIP_DEFLATED)
    result = call('code-task.zip', code)
    assert result['file_count'] == 3 and (root / 'extracted/project/main.py').is_file()
    # The fixture intentionally never imports or executes an extracted script.
    call('same.zip', code, 'archive_destination_exists')
    (root / 'empty-existing').mkdir()
    call('empty-existing.zip', code, 'archive_destination_exists', 'empty-existing')
    assert list((root / 'empty-existing').iterdir()) == []
    (root / 'target-link').symlink_to(outside, target_is_directory=True)
    call('target-link.zip', code, 'archive_destination_exists', 'target-link')
    call('target-parent.zip', code, ('archive_failed',), 'target-link/new')
    assert not (outside / 'new').exists()
    call('bad-hash.zip', code, 'digest_mismatch', 'bad-hash', '0' * 64)
    (root / 'source-link').symlink_to(outside / 'secret')
    call('source-link.zip', b'private', ('archive_failed',), 'source-link-out', source_path='source-link')
    os.link(outside / 'secret', root / 'source-hard')
    call('source-hard.zip', b'private', 'source_limit', 'source-hard-out', source_path='source-hard')
    os.mkfifo(root / 'source-fifo')
    call('source-fifo.zip', b'', 'source_limit', 'fifo-out', source_path='source-fifo')
    assert (outside / 'secret').read_text() == 'private'
    for index, name in enumerate(['../escape.py', '/absolute.py', 'C:/drive.py', 'x' + chr(92) + 'evil.py', 'a/../../escape', 'a//empty', './dot', 'a/./dot', 'a\ncontrol', 'a:stream', '.zeroagent-transfers/x', 'e\u0301.txt', 'a' + chr(133) + 'control']):
        call('unsafe-' + str(index) + '.zip', archive([(name, b'bad')]), 'unsafe_archive', 'unsafe-' + str(index))
    duplicate = archive([('same.txt', b'one'), ('same.txt', b'two')])
    call('duplicate.zip', duplicate, 'unsafe_archive', 'duplicate')
    call('collision.zip', archive([('file', b'x'), ('file/nested', b'y')]), 'unsafe_archive', 'collision')
    call('dir-duplicate.zip', archive([('dir/', b''), ('dir/', b'')]), 'unsafe_archive', 'dir-duplicate')
    call('file-dir.zip', archive([('a/', b''), ('a', b'x')]), 'unsafe_archive', 'file-dir')
    symlink = zipfile.ZipInfo('symlink')
    symlink.create_system = 3
    symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
    call('symlink.zip', archive([(symlink, b'../outside/secret')]), 'unsafe_archive', 'symlink')
    device = zipfile.ZipInfo('device')
    device.external_attr = (stat.S_IFCHR | 0o600) << 16
    call('device.zip', archive([(device, b'')]), 'unsafe_archive', 'device')
    hardlink = zipfile.ZipInfo('hardlink')
    hardlink.extra = struct.pack('<HH', 0x000d, 0)
    call('hardlink-extra.zip', archive([(hardlink, b'')]), 'unsafe_archive', 'hardlink-extra')
    encrypted = bytearray(archive([('encrypted', b'x')]))
    for signature, offset in [(b'PK\x03\x04', 6), (b'PK\x01\x02', 8)]:
        at = encrypted.index(signature) + offset
        struct.pack_into('<H', encrypted, at, struct.unpack_from('<H', encrypted, at)[0] | 1)
    call('encrypted.zip', bytes(encrypted), 'unsafe_archive', 'encrypted')
    nul = bytearray(archive([('nulXname', b'x')]))
    start = 0
    while True:
        at = nul.find(b'nulXname', start)
        if at < 0:
            break
        nul[at + 3] = 0
        start = at + 8
    call('nul.zip', bytes(nul), 'unsafe_archive', 'nul')
    call('entries.zip', archive([(str(i), b'x') for i in range(129)]), 'zip_entries_limit', 'entries')
    call('bomb.zip', archive([('bomb', b'0' * (2 * 1024 * 1024))], zipfile.ZIP_DEFLATED), 'zip_expansion_limit', 'bomb')
    call('single-large.zip', archive([('large', b'x' * (8 * 1024 * 1024 + 1))]), 'zip_expansion_limit', 'single-large')
    # Stored 4x8 MiB plus central directory exceeds the source cap, so use a
    # compressible ratio-safe 5x7 MiB payload to isolate expanded-total rejection.
    block = os.urandom(3 * 1024 * 1024) + b'0' * (4 * 1024 * 1024)
    call('expanded.zip', archive([(str(i), block) for i in range(5)], zipfile.ZIP_DEFLATED), 'zip_expansion_limit', 'expanded')
    long_names = [('dir' + str(i) + '/' + ('x' * 235) + '/' + ('y' * 235) + '/' + ('z' * 235), b'x') for i in range(100)]
    call('paths.zip', archive(long_names), 'zip_expansion_limit', 'paths')
    call('deep.zip', archive([('/'.join(['a'] * 33), b'x')]), 'unsafe_archive', 'deep')
    # A CRC mismatch occurs after stage creation and a successful first member.
    broken = bytearray(archive([('first.txt', b'kept only in staging'), ('broken.txt', b'CRC_MARKER')]))
    offset = broken.index(b'CRC_MARKER')
    broken[offset] ^= 1
    call('crc.zip', bytes(broken), 'archive_invalid', 'crc')
    assert not (root / 'crc').exists()
    call('truncated.zip', code[:-30], 'archive_invalid', 'truncated')
    empty = call('empty.zip', archive([]), destination='empty')
    assert empty['files'] == [] and empty['total_bytes'] == 0
    # Inclusive entry limit and single-file limit, without executing contents.
    call('boundary-entries.zip', archive([(str(i), b'') for i in range(128)]), destination='boundary-entries')
    call('boundary-file.zip', archive([('file', b'x' * (8 * 1024 * 1024))]), destination='boundary-file')
    # Trusted fault injection sends a real SIGALRM immediately after publication,
    # before stdout. The effect exists, so timeout must remain unknown.
    wrapper = "import base64,os,signal;ns={'__name__':'archive_fixture'};exec(compile(base64.b64decode(" + repr(base64.b64encode(source.encode()).decode()) + "),'archive_extract.py','exec'),ns);original=ns['os'].fsync\ndef interrupted(fd):\n original(fd)\n if os.path.isdir(" + repr(str(root / 'timeout-after-publish')) + "):\n  os.kill(os.getpid(),signal.SIGALRM)\nns['os'].fsync=interrupted\nns['main']()"
    interrupted = call('timeout-after-publish.zip', code, 'archive_timeout', 'timeout-after-publish', entry=wrapper)
    assert interrupted['uncertain'] is True and (root / 'timeout-after-publish/project/main.py').is_file()
    print(json.dumps({'passed': True, 'cases': checked, 'python': sys.version.split()[0], 'executed_archive_code': False}))
