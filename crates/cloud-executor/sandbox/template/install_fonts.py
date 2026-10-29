"""Build-time only: fetch fixed public font/license bytes and verify before install."""
import hashlib
import json
from pathlib import Path
import re
import urllib.request


def install():
    lock = json.loads(Path(__file__).with_name('font-assets.lock.json').read_text())
    assert lock['format'] == 1 and lock['font_modified'] is False
    assert [asset['filename'] for asset in lock['assets']] == ['NotoSansSC-VF.ttf', 'OFL.txt']
    verified = []
    for asset in lock['assets']:
        assert re.fullmatch(r'https://raw\.githubusercontent\.com/(notofonts/noto-cjk|google/fonts)/[a-f0-9]{40}/[a-zA-Z0-9/_.-]+', asset['url'])
        assert re.fullmatch('[a-f0-9]{64}', asset['sha256']) and 0 < asset['bytes'] <= 20 * 1024 * 1024
        request = urllib.request.Request(asset['url'], headers={'User-Agent': 'ZeroAgent-template-font-build/1'})
        with urllib.request.urlopen(request, timeout=30) as response:
            assert response.geturl() == asset['url'], 'font_redirect_rejected'
            content = response.read(asset['bytes'] + 1)
        assert len(content) == asset['bytes'] and hashlib.sha256(content).hexdigest() == asset['sha256'], 'font_asset_integrity_failed'
        verified.append((asset, content))
    destination = Path('/usr/local/share/fonts/zeroagent')
    destination.mkdir(mode=0o755, parents=True, exist_ok=False)
    for asset, content in verified:
        target = destination / asset['filename']
        with target.open('xb') as stream:
            stream.write(content)
        target.chmod(0o644)
    # Only disposable Matplotlib font-list caches in this new build image are
    # invalidated. A subsequent process scans the newly installed system font.
    for cache in [Path('/root/.cache/matplotlib'), Path('/home/user/.cache/matplotlib')]:
        if cache.exists():
            assert cache.is_dir() and not cache.is_symlink()
            for file in cache.iterdir():
                if re.fullmatch(r'fontlist-v[0-9]+\.json', file.name):
                    assert file.is_file() and not file.is_symlink()
                    file.unlink()
    print(json.dumps({'installed': [asset['filename'] for asset, _ in verified], 'family': lock['family'], 'runtime_download': False, 'font_modified': False}))


if __name__ == '__main__':
    install()
