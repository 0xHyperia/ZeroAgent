"""Bounded descriptor-relative file transfer. Executed in an owned E2B VM only."""
import base64
import errno
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import sys
import time

MAX_TOTAL = 32 * 1024 * 1024
MAX_CHUNK = 1024 * 1024
MAX_MANIFESTS = 128
MAX_PENDING = 8
TRANSFER_TTL = 3600


class Rejected(Exception):
    pass


def reject(code):
    raise Rejected(code)


def components(path):
    parts = path.split('/')
    if not path or len(path) > 1024 or any(p in ('', '.', '..') or '\\' in p or '\0' in p for p in parts):
        reject('invalid_path')
    if parts[0] == '.zeroagent-transfers':
        reject('invalid_path')
    return parts


def directory(parent, parts, create=False):
    current = os.dup(parent)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=current)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def regular(parent, name, flags=os.O_RDONLY, limit=MAX_TOTAL):
    fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
        os.close(fd)
        reject('file_limit')
    return fd


def atomic(parent, name, data):
    temp = '.zeroagent-write-' + secrets.token_hex(16)
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try:
            os.unlink(temp, dir_fd=parent)
        except FileNotFoundError:
            pass


def digest(fd):
    h = hashlib.sha256()
    offset = 0
    while True:
        block = os.pread(fd, 64 * 1024, offset)
        if not block:
            return h.hexdigest()
        offset += len(block)
        if offset > MAX_TOTAL:
            reject('file_limit')
        h.update(block)


def read_json(parent, name):
    fd = regular(parent, name, limit=4096)
    with os.fdopen(fd, 'r') as stream:
        return json.load(stream)


def transfer(root, p):
    tid = p['transfer_id']
    if not re.fullmatch('[a-f0-9]{32,64}', tid) or not re.fullmatch('[a-f0-9]{64}', p['sha256']):
        reject('invalid_transfer')
    if not 0 <= p['total_bytes'] <= MAX_TOTAL:
        reject('file_limit')
    try:
        os.mkdir('.zeroagent-transfers', 0o700, dir_fd=root)
    except FileExistsError:
        pass
    stage = directory(root, ['.zeroagent-transfers'])
    try:
        fcntl.flock(stage, fcntl.LOCK_EX)
        name, part = tid + '.json', tid + '.part'
        try:
            manifest = read_json(stage, name)
        except FileNotFoundError:
            manifest = None
        expected = {key: p[key] for key in ('transfer_id', 'scope', 'sandbox_id', 'total_bytes', 'sha256')}
        if manifest:
            if any(manifest.get(key) != value for key, value in expected.items()) or ('path' in p and manifest['path'] != p['path']):
                reject('transfer_conflict')
            if not manifest['finalized']:
                try:
                    checked = regular(stage, part)
                    os.close(checked)
                except FileNotFoundError:
                    if manifest['received_bytes'] != p['total_bytes']:
                        reject('transfer_incomplete')
        if p['action'] == 'upload.begin':
            components(p['path'])
            if not manifest:
                manifests = [n for n in os.listdir(stage) if re.fullmatch('[a-f0-9]{32,64}\.json', n)]
                if len(manifests) >= MAX_MANIFESTS:
                    reject('transfer_capacity')
                pending = sum(not read_json(stage, n).get('finalized') for n in manifests)
                if pending >= MAX_PENDING:
                    reject('transfer_capacity')
                fd = os.open(part, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage)
                os.close(fd)
                manifest = dict(expected, path=p['path'], received_bytes=0, finalized=False, created_at=time.time())
                atomic(stage, name, json.dumps(manifest).encode())
            return dict(received_bytes=manifest['received_bytes'], finalized=manifest['finalized'])
        if not manifest:
            reject('transfer_not_found')
        if p['action'] == 'upload.abort':
            if manifest['finalized']:
                reject('transfer_finalized')
            try:
                fd = regular(stage, part)
                os.close(fd)
                os.unlink(part, dir_fd=stage)
            except FileNotFoundError:
                pass
            os.unlink(name, dir_fd=stage)
            os.fsync(stage)
            return {'aborted': True}
        if time.time() - manifest['created_at'] > TRANSFER_TTL and not manifest['finalized']:
            reject('transfer_expired')
        if p['action'] == 'upload.chunk':
            if manifest['finalized']:
                reject('transfer_finalized')
            data = base64.b64decode(p['data_base64'], validate=True)
            offset, received = p['offset'], manifest['received_bytes']
            if not data or len(data) > MAX_CHUNK or offset < 0 or offset + len(data) > p['total_bytes']:
                reject('file_limit')
            fd = regular(stage, part, os.O_RDWR)
            try:
                if offset < received:
                    if offset + len(data) > received or os.pread(fd, len(data), offset) != data:
                        reject('transfer_conflict')
                    return {'received_bytes': received, 'duplicate': True}
                if offset != received:
                    reject('transfer_out_of_order')
                written = 0
                while written < len(data):
                    count = os.pwrite(fd, data[written:], offset + written)
                    if count <= 0:
                        raise OSError('short_write')
                    written += count
                os.fsync(fd)
                manifest['received_bytes'] += len(data)
                atomic(stage, name, json.dumps(manifest).encode())
                return {'received_bytes': manifest['received_bytes'], 'duplicate': False}
            finally:
                os.close(fd)
        if p['action'] != 'upload.finalize':
            reject('unsupported_action')
        if manifest['received_bytes'] != p['total_bytes']:
            reject('transfer_incomplete')
        parts = components(p['path'])
        target = directory(root, parts[:-1], create=True)
        try:
            try:
                fd = regular(stage, part)
            except FileNotFoundError:
                fd = regular(target, parts[-1])  # Crash after rename, before manifest commit.
            try:
                if os.fstat(fd).st_size != p['total_bytes'] or digest(fd) != p['sha256']:
                    reject('digest_mismatch')
            finally:
                os.close(fd)
            try:
                os.rename(part, parts[-1], src_dir_fd=stage, dst_dir_fd=target)
            except FileNotFoundError:
                pass
            os.fsync(target)
            manifest['finalized'] = True
            atomic(stage, name, json.dumps(manifest).encode())
            return {'path': p['path'], 'total_bytes': p['total_bytes'], 'sha256': p['sha256'], 'finalized': True}
        finally:
            os.close(target)
    finally:
        os.close(stage)


def execute(p):
    slash = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        root = directory(slash, p['root'].strip('/').split('/'), p['action'] == 'init')
    finally:
        os.close(slash)
    try:
        if p['action'] == 'init':
            return {}
        if p['action'].startswith('upload.'):
            return transfer(root, p)
        parts = components(p['path'])
        parent = directory(root, parts[:-1], p['action'] == 'write')
        try:
            if p['action'] in ('read', 'download.chunk'):
                fd = regular(parent, parts[-1], limit=p['limit'] if p['action'] == 'read' else MAX_TOTAL)
                try:
                    if p['action'] == 'read':
                        data = os.pread(fd, p['limit'] + 1, 0)
                        if len(data) > p['limit']:
                            reject('file_limit')
                        return {'data_base64': base64.b64encode(data).decode(), 'bytes': len(data)}
                    info = os.fstat(fd)
                    sha = digest(fd)
                    if p.get('expected_sha256') and sha != p['expected_sha256']:
                        reject('digest_mismatch')
                    if not 0 <= p['offset'] <= info.st_size or not 1 <= p['max_bytes'] <= MAX_CHUNK:
                        reject('invalid_offset')
                    data = os.pread(fd, p['max_bytes'], p['offset'])
                    after = os.fstat(fd)
                    if (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                        reject('file_changed')
                    return {'offset': p['offset'], 'total_bytes': info.st_size, 'sha256': sha,
                            'data_base64': base64.b64encode(data).decode(), 'bytes': len(data),
                            'eof': p['offset'] + len(data) == info.st_size}
                finally:
                    os.close(fd)
            data = base64.b64decode(p['data'], validate=True)
            if len(data) > min(p['limit'], MAX_CHUNK):
                reject('file_limit')
            atomic(parent, parts[-1], data)
            return {'bytes': len(data)}
        finally:
            os.close(parent)
    finally:
        os.close(root)


try:
    raw = base64.b64decode(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin.buffer.read(1_500_001)
    if len(raw) > 1_500_000:
        reject('body_limit')
    print(json.dumps(execute(json.loads(raw))))
except Rejected as error:
    print(json.dumps({'error': str(error), 'uncertain': False}))
except OSError as error:
    print(json.dumps({'error': 'invalid_path' if error.errno in (errno.ELOOP, errno.ENOTDIR) else 'sandbox_file_error',
                      'uncertain': error.errno not in (errno.ELOOP, errno.ENOTDIR, errno.ENOENT)}))
except BaseException:
    print(json.dumps({'error': 'sandbox_file_error', 'uncertain': True}))
