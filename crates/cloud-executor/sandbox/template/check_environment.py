"""Trusted template check. No network, installation, or user document parsing."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import pwd
import stat
import sys


def check(base_only=False):
    lock = json.loads(Path(__file__).with_name('base.lock.json').read_text())
    packages = dict(lock['inherited_packages'])
    if not base_only:
        packages.update(lock['additional_packages'])
    actual_packages = {}
    for name in packages:
        try:
            actual_packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            actual_packages[name] = None
    startup_hashes = {}
    if os.getuid() == 0:
        for name in lock['startup_files']:
            startup = Path(name)
            info = startup.lstat()
            assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 32768, 'unsafe_startup_file'
            startup_hashes[name] = hashlib.sha256(startup.read_bytes()).hexdigest()
    user = pwd.getpwnam(lock['user'])
    # Fixed non-secret inventory survives a fail-closed version assertion in provider build logs.
    print(json.dumps({'inventory': True, 'base_only': base_only, 'python': platform.python_version(),
                      'uid': os.getuid(), 'gid': os.getgid(), 'packages': actual_packages,
                      'startup_sha256': startup_hashes,
                      'user': {'uid': user.pw_uid, 'gid': user.pw_gid, 'home': user.pw_dir}}), flush=True)
    assert platform.python_version() == lock['python'], 'python_version_changed'
    assert sys.version_info >= (3, 10), 'python3_required'
    assert user.pw_uid == lock['uid'] and user.pw_gid == lock['gid'] and user.pw_dir == lock['workdir'], 'wrong_user_record'
    for name, version in packages.items():
        assert actual_packages[name] == version, 'dependency_changed: ' + name
    # Run as root only during the build, so the official private healthcheck is readable.
    if os.getuid() == 0:
        assert startup_hashes == lock['startup_files'], 'startup_changed'
    else:
        assert os.getuid() == lock['uid'] and os.getgid() == lock['gid'], 'wrong_user'
        assert os.access('/home/user', os.W_OK), 'workspace_not_writable'
    print(json.dumps({'checked': True, 'base_only': base_only, 'python': platform.python_version(),
                      'uid': os.getuid(), 'packages': packages, 'envd_checked': False}))


if __name__ == '__main__':
    check('--base-only' in sys.argv[1:])
