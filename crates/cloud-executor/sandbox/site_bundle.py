"""Package one selected build directory in an owned Linux guest; no code execution."""
import ctypes
import errno
import hashlib
import json
import os
import re
import resource
import secrets
import signal
import stat
import sys
import unicodedata
import zipfile

MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
MAX_ZIP = 32 * 1024 * 1024
MAX_ENTRIES = 2000
ALLOWED = set('html htm js mjs css json webmanifest wasm png jpg jpeg gif webp avif svg ico woff woff2 ttf otf txt csv tsv md pdf mp3 wav ogg mp4 webm'.split())


class Rejected(Exception):
    pass


def reject(code):
    raise Rejected(code)


def parts(value, resource_path=False):
    if not isinstance(value, str) or not value or len(value.encode('utf-8')) > (512 if resource_path else 1024):
        reject('invalid_path')
    names = value.split('/')
    if len(names) > 32 or value != unicodedata.normalize('NFC', value):
        reject('invalid_path')
    for name in names:
        if not name or name.startswith('.') or name.lower() in ('node_modules', 'credentials.json', 'id_rsa', 'id_ed25519'):
            reject('unsafe_site_entry')
        if any(c in '\\:%?#' or ord(c) < 32 or ord(c) == 127 or 0x202a <= ord(c) <= 0x202e or 0x2066 <= ord(c) <= 0x2069 for c in name):
            reject('invalid_path')
    if names[0] == 'site-bundles':
        reject('invalid_path')
    return names


def directory(parent, names):
    current = os.dup(parent)
    try:
        for name in names:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def fingerprint(info):
    return info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink


def inventory(source):
    files, folded = [], set()
    total, entries = 0, 0

    def visit(fd, prefix):
        nonlocal total, entries
        before = os.fstat(fd)
        for name in sorted(os.listdir(fd)):
            path = prefix + name
            parts(path, True)
            folded_path = path.lower()
            if folded_path in folded:
                reject('unsafe_site_entry')
            folded.add(folded_path)
            entries += 1
            if entries > MAX_ENTRIES:
                reject('site_entries_limit')
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    if fingerprint(os.fstat(child)) != fingerprint(info):
                        reject('file_changed')
                    visit(child, path + '/')
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                if '.' not in name or name.rsplit('.', 1)[1].lower() not in ALLOWED:
                    reject('unsafe_site_entry')
                if info.st_size > MAX_FILE:
                    reject('file_limit')
                total += info.st_size
                if total > MAX_TOTAL:
                    reject('site_expansion_limit')
                files.append((path, fingerprint(info)))
            else:
                reject('unsafe_site_entry')
        if fingerprint(os.fstat(fd)) != fingerprint(before):
            reject('file_changed')

    visit(source, '')
    if not any(path == 'index.html' and info[3] > 0 for path, info in files):
        reject('site_entry_missing')
    return sorted(files), total


def exclusive_rename(parent, old, new):
    library = ctypes.CDLL(None, use_errno=True)
    rename = getattr(library, 'renameat2', None)
    if rename is None:
        reject('site_atomic_publish_unavailable')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(parent, os.fsencode(old), parent, os.fsencode(new), 1) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            reject('site_destination_exists')
        if code in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
            reject('site_atomic_publish_unavailable')
        raise OSError(code, 'site_publish_failed')


class BoundedFile:
    def __init__(self, stream):
        self.stream = stream

    def write(self, data):
        if self.stream.tell() + len(data) > MAX_ZIP:
            reject('site_archive_limit')
        return self.stream.write(data)

    def __getattr__(self, name):
        return getattr(self.stream, name)


def run(p):
    if not isinstance(p, dict) or set(p) != {'root', 'path', 'output_path'} or not isinstance(p['root'], str) or not p['root'].startswith('/'):
        reject('invalid_request')
    names = parts(p['path'])
    if not isinstance(p['output_path'], str) or not re.fullmatch(r'site-bundles/[a-f0-9]{64}\.zip', p['output_path']):
        reject('invalid_path')
    root = os.open(p['root'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    source = target = None
    temporary = '.site-pending-' + secrets.token_hex(16)
    try:
        source = directory(root, names)
        files, total = inventory(source)
        try:
            os.mkdir('site-bundles', 0o700, dir_fd=root)
        except FileExistsError:
            pass
        target = directory(root, ['site-bundles'])
        destination = p['output_path'].split('/')[1]
        try:
            os.stat(destination, dir_fd=target, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            reject('site_destination_exists')
        fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target)
        with os.fdopen(fd, 'w+b', buffering=0) as output:
            with zipfile.ZipFile(BoundedFile(output), 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=False) as archive:
                for path, before in files:
                    components = path.split('/')
                    parent = directory(source, components[:-1])
                    try:
                        original = os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                    finally:
                        os.close(parent)
                    with os.fdopen(original, 'rb') as stream:
                        if fingerprint(os.fstat(stream.fileno())) != before:
                            reject('file_changed')
                        info = zipfile.ZipInfo(path, (1980, 1, 1, 0, 0, 0))
                        info.compress_type = zipfile.ZIP_DEFLATED
                        info.external_attr = (stat.S_IFREG | 0o644) << 16
                        count = 0
                        with archive.open(info, 'w', force_zip64=False) as member:
                            while True:
                                block = stream.read(64 * 1024)
                                if not block:
                                    break
                                count += len(block)
                                if count > before[3] or count > MAX_FILE:
                                    reject('file_changed')
                                member.write(block)
                        if count != before[3] or fingerprint(os.fstat(stream.fileno())) != before:
                            reject('file_changed')
            # Catch added/removed/replaced files and directory changes during packing.
            if inventory(source) != (files, total):
                reject('file_changed')
            output.flush()
            os.fsync(output.fileno())
            size = output.tell()
            if size < 1 or size > MAX_ZIP:
                reject('site_archive_limit')
            output.seek(0)
            digest = hashlib.sha256()
            while True:
                block = output.read(64 * 1024)
                if not block:
                    break
                digest.update(block)
        exclusive_rename(target, temporary, destination)
        os.fsync(target)
        return {'source_path': p['path'], 'path': p['output_path'], 'entry_point': 'index.html', 'size': size, 'sha256': digest.hexdigest(), 'file_count': len(files), 'expanded_bytes': total}
    finally:
        if target is not None:
            try:
                os.unlink(temporary, dir_fd=target)
            except FileNotFoundError:
                pass
            os.close(target)
        if source is not None:
            os.close(source)
        os.close(root)


def main():
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_ZIP, MAX_ZIP))
    signal.signal(signal.SIGALRM, lambda *_: reject('site_bundle_timeout'))
    signal.alarm(35)
    try:
        data = sys.stdin.buffer.read(16 * 1024 + 1)
        if len(data) > 16 * 1024:
            reject('input_limit')
        result = run(json.loads(data))
    except Rejected as error:
        result = {'error': str(error)}
    except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile, zipfile.LargeZipFile):
        result = {'error': 'site_bundle_failed', 'uncertain': True}
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    main()
