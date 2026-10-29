"""Fixed, bounded ZIP extraction in an owned guest VM. Never executes archive code."""
import ctypes
import errno
import hashlib
import io
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

MAX_SOURCE = 32 * 1024 * 1024
MAX_ENTRIES = 128
MAX_FILE = 8 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_PATH_BYTES = 64 * 1024
MAX_RATIO = 100
MAX_RESULT = 192 * 1024


class Rejected(Exception):
    pass


def reject(code):
    raise Rejected(code)


def parts(value, entry=False):
    if not isinstance(value, str):
        reject('invalid_path')
    try:
        length = len(value.encode('utf-8'))
    except UnicodeError:
        reject('invalid_path')
    if not value or length > 1024 or any(unicodedata.category(c) == 'Cc' for c in value) or '\\' in value or ':' in value:
        reject('unsafe_archive' if entry else 'invalid_path')
    names = value.split('/')
    if len(names) > 32 or any(name in ('', '.', '..') for name in names) or names[0].startswith('.zeroagent-'):
        reject('unsafe_archive' if entry else 'invalid_path')
    if unicodedata.normalize('NFC', value) != value:
        reject('unsafe_archive' if entry else 'invalid_path')
    return names


def directory(parent, names, create=False):
    fd = os.dup(parent)
    try:
        for name in names:
            if create:
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def clean_directory(fd):
    # Never follow links, including if another process in this VM changed a path.
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                clean_directory(child)
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=fd)
        else:
            os.unlink(name, dir_fd=fd)


def exclusive_rename(parent, old, new):
    # A pre-check followed by os.rename could replace an existing empty directory.
    # Linux RENAME_NOREPLACE is required; unsupported guest platforms fail closed.
    library = ctypes.CDLL(None, use_errno=True)
    rename = getattr(library, 'renameat2', None)
    if rename is None:
        reject('archive_atomic_publish_unavailable')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(parent, os.fsencode(old), parent, os.fsencode(new), 1) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            reject('archive_destination_exists')
        if code in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
            reject('archive_atomic_publish_unavailable')
        raise OSError(code, 'archive_publish_failed')


def validate_entries(archive, destination):
    entries = archive.infolist()
    if len(entries) > MAX_ENTRIES:
        reject('zip_entries_limit')
    seen, directories, files = set(), set(), set()
    expanded, compressed, path_bytes = 0, 0, 0
    result = []
    for item in entries:
        # ZipInfo truncates filename at NUL, but retains the original string.
        name = item.orig_filename
        is_dir = name.endswith('/')
        names = parts(name[:-1] if is_dir else name, entry=True)
        normalized = '/'.join(names)
        if normalized in seen:
            reject('unsafe_archive')
        seen.add(normalized)
        mode = item.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if kind not in (0, stat.S_IFDIR if is_dir else stat.S_IFREG) or item.flag_bits & (1 | 64) or item.volume != 0:
            reject('unsafe_archive')
        if item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            reject('unsafe_archive')
        # Never interpret Unix link/device metadata or apply uid/mode attributes.
        offset = 0
        while offset < len(item.extra):
            if offset + 4 > len(item.extra):
                reject('unsafe_archive')
            tag = int.from_bytes(item.extra[offset:offset + 2], 'little')
            count = int.from_bytes(item.extra[offset + 2:offset + 4], 'little')
            offset += 4 + count
            if offset > len(item.extra) or tag not in (0x0001, 0x5455, 0x7875):
                reject('unsafe_archive')
        if is_dir and item.file_size != 0:
            reject('unsafe_archive')
        if item.file_size < 0 or item.file_size > MAX_FILE or item.file_size > max(1, item.compress_size) * MAX_RATIO:
            reject('zip_expansion_limit')
        expanded += item.file_size
        compressed += item.compress_size
        path_bytes += len((destination + '/' + normalized).encode('utf-8'))
        if expanded > MAX_EXPANDED or path_bytes > MAX_PATH_BYTES or len((destination + '/' + normalized).encode('utf-8')) > 1024:
            reject('zip_expansion_limit')
        (directories if is_dir else files).add(normalized)
        for index in range(1, len(names)):
            directories.add('/'.join(names[:index]))
        result.append((item, names, is_dir))
    if files & directories or expanded > max(1, compressed) * MAX_RATIO:
        reject('unsafe_archive')
    return result


def run(payload):
    source_names = parts(payload['path'])
    destination_names = parts(payload['destination'])
    expected = payload['source_sha256']
    if not isinstance(expected, str) or not re.fullmatch('[a-f0-9]{64}', expected):
        reject('invalid_digest')
    slash = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        root = directory(slash, payload['root'].strip('/').split('/'))
    finally:
        os.close(slash)
    try:
        source_parent = directory(root, source_names[:-1])
        try:
            source_fd = os.open(source_names[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_parent)
        finally:
            os.close(source_parent)
        with os.fdopen(source_fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_SOURCE:
                reject('source_limit')
            data = source.read(MAX_SOURCE + 1)
        if len(data) > MAX_SOURCE or hashlib.sha256(data).hexdigest() != expected:
            reject('digest_mismatch')
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = validate_entries(archive, payload['destination'])
            parent = directory(root, destination_names[:-1])
            temp = '.zeroagent-archive-' + secrets.token_hex(32)
            stage = None
            published = False
            try:
                try:
                    os.stat(destination_names[-1], dir_fd=parent, follow_symlinks=False)
                    reject('archive_destination_exists')
                except FileNotFoundError:
                    pass
                os.mkdir(temp, 0o700, dir_fd=parent)
                stage = directory(parent, [temp])
                stage_identity = os.fstat(stage)
                manifest, total = [], 0
                for item, names, is_dir in entries:
                    target = directory(stage, names if is_dir else names[:-1], create=True)
                    try:
                        if is_dir:
                            continue
                        fd = os.open(names[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target)
                        size, digest = 0, hashlib.sha256()
                        with os.fdopen(fd, 'wb') as output, archive.open(item) as content:
                            while True:
                                block = content.read(64 * 1024)
                                if not block:
                                    break
                                size += len(block)
                                total += len(block)
                                if size > item.file_size or size > MAX_FILE or total > MAX_EXPANDED:
                                    reject('zip_expansion_limit')
                                digest.update(block)
                                output.write(block)
                            if size != item.file_size:
                                reject('archive_invalid')
                            output.flush()
                            os.fsync(output.fileno())
                        manifest.append({'path': payload['destination'] + '/' + '/'.join(names), 'size': size, 'sha256': digest.hexdigest()})
                    finally:
                        os.close(target)
                manifest.sort(key=lambda item: item['path'])
                result = {'source_sha256': expected, 'destination': payload['destination'], 'files': manifest, 'file_count': len(manifest), 'total_bytes': total}
                if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > MAX_RESULT:
                    reject('output_limit')
                os.fsync(stage)
                exclusive_rename(parent, temp, destination_names[-1])
                published = True
                os.fsync(parent)
                return result
            finally:
                try:
                    if stage is not None and not published:
                        current = os.stat(temp, dir_fd=parent, follow_symlinks=False)
                        if current.st_dev != stage_identity.st_dev or current.st_ino != stage_identity.st_ino:
                            reject('archive_cleanup_unknown')
                        clean_directory(stage)
                        os.rmdir(temp, dir_fd=parent)
                        os.fsync(parent)
                except BaseException:
                    reject('archive_cleanup_unknown')
                finally:
                    if stage is not None:
                        os.close(stage)
                    os.close(parent)
    finally:
        os.close(root)


def main():
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE, MAX_FILE))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    signal.signal(signal.SIGALRM, lambda *_: reject('archive_timeout'))
    signal.alarm(30)
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            reject('input_limit')
        print(json.dumps(run(json.loads(raw)), ensure_ascii=False))
    except Rejected as error:
        # An alarm may arrive after atomic publication but before its receipt.
        # Do not claim that timeout proves the extraction did not take effect.
        print(json.dumps({'error': str(error), 'uncertain': str(error) in ('archive_cleanup_unknown', 'archive_timeout')}))
    except (zipfile.BadZipFile, NotImplementedError, UnicodeError):
        print(json.dumps({'error': 'archive_invalid', 'uncertain': False}))
    except BaseException:
        print(json.dumps({'error': 'archive_failed', 'uncertain': True}))
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    main()
