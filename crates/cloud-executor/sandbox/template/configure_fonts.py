"""Apply trusted template defaults to commands and the official Jupyter server."""
import json
from pathlib import Path
import re
from fontTools.ttLib import TTFont

import matplotlib
from matplotlib import font_manager, ft2font


def configure():
    source = Path(__file__).parent
    lock = json.loads((source / 'base.lock.json').read_text())['matplotlib_defaults']
    font_path = Path(font_manager.findfont(font_manager.FontProperties(family=[lock['family']]), fallback_to_default=False))
    assert str(font_path) == lock['font_file'], 'unexpected_cjk_font'
    font = ft2font.FT2Font(str(font_path))
    assert font.family_name == lock['family'], 'unexpected_cjk_family'
    assert all(ord(char) in font.get_charmap() for char in lock['required_text']), 'required_cjk_glyph_missing'
    with TTFont(font_path) as parsed_font:
        assert 'glyf' in parsed_font and 'CFF ' not in parsed_font and 'CFF2' not in parsed_font, 'pdf_requires_true_type_outlines'
    policy = (source / 'matplotlibrc').read_text()
    keys = {line.split(':', 1)[0].strip() for line in policy.splitlines() if line and not line.startswith('#')}
    targets = [Path(matplotlib.get_data_path()) / 'matplotlibrc', Path('/root/.config/matplotlib/.matplotlibrc')]
    for target in targets:
        assert target.is_file() and not target.is_symlink(), 'unexpected_matplotlibrc'
        # The installed mpl-data/matplotlibrc is parsed twice: defaults strip
        # one leading '#', while normal rc parsing ignores comments. Remove
        # the matching commented defaults as well as active values, and use
        # double-# explanatory comments in the shared policy.
        original = target.read_text()
        lines = []
        for line in original.splitlines():
            key = re.match(r'^\s*#?\s*([a-z][a-z0-9_.-]*)\s*:', line)
            if not key or key.group(1) not in keys:
                lines.append(line)
        target.write_text('\n'.join(lines) + '\n' + policy)
    print(json.dumps({'default_font': font.family_name, 'required_glyphs': len(lock['required_text']),
                      'configured': [str(target) for target in targets], 'outlines': 'glyf'}))


if __name__ == '__main__':
    configure()
