"""Synthetic, bounded, offline dependency/output check; this is not an E2B test."""
import argparse
import csv
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import resource
import runpy
import shutil
import subprocess
import sys
import tempfile
import time
import warnings
import zipfile


def run(parser=None):
    started = time.monotonic()
    os.environ['MPLBACKEND'] = 'Agg'
    os.environ['MPLCONFIGDIR'] = '/tmp/zeroagent-matplotlib'
    os.environ['OPENBLAS_NUM_THREADS'] = '1'
    os.environ['OMP_NUM_THREADS'] = '1'
    runpy.run_path(str(Path(__file__).with_name('check_environment.py')))['check']()
    import pandas as pd
    import matplotlib.pyplot as plt
    from matplotlib import font_manager, ft2font
    from PIL import Image
    from docx import Document
    from openpyxl import load_workbook
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Inches
    from pypdf import PdfReader
    import xlsxwriter

    assert os.getuid() == 1000, 'expected_user1000'
    work = Path(tempfile.mkdtemp(prefix='zeroagent-template-', dir='/home/user'))
    rows = [('Analysis', '19.50'), ('Report', '30.00'), ('Presentation', '75.25')]
    expected = sum(Decimal(value) for _, value in rows)
    assert expected == Decimal('124.75')
    with (work / 'input.csv').open('w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['work', 'amount'])
        writer.writerows(rows)
    frame = pd.read_csv(work / 'input.csv')
    assert Decimal(str(frame.amount.sum())) == expected

    chinese = '销售金额统计'
    default_font = font_manager.findfont(font_manager.FontProperties())
    font = ft2font.FT2Font(default_font)
    assert font.family_name == 'Noto Sans SC'
    assert all(ord(char) in font.get_charmap() for char in chinese), 'default_cjk_glyph_missing'
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter('always')
        fig, axes = plt.subplots(figsize=(6, 4), dpi=100)
        axes.bar(frame.work, frame.amount)
        # Deliberately no per-plot font override: commands must inherit the template default.
        axes.set_title(chinese + ' 124.75')
        fig.tight_layout()
        fig.savefig(work / 'chart.png')
        fig.savefig(work / 'report.pdf')
        plt.close(fig)
    missing_glyph_warnings = [str(item.message) for item in captured if 'glyph' in str(item.message).lower() and 'missing' in str(item.message).lower()]
    assert not missing_glyph_warnings, missing_glyph_warnings
    with Image.open(work / 'chart.png') as image:
        assert image.size == (600, 400)
        image.verify()
    pdf = PdfReader(work / 'report.pdf', strict=True)
    assert len(pdf.pages) == 1 and '124.75' in pdf.pages[0].extract_text()
    assert chinese in pdf.pages[0].extract_text(), 'pdf_chinese_text_missing'

    document = Document()
    document.add_heading('ZeroAgent 工作报告', 0)
    document.add_paragraph('Total 124.75')
    table = document.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text, table.rows[0].cells[1].text = 'Work', 'Amount'
    for name, value in rows:
        cells = table.add_row().cells
        cells[0].text, cells[1].text = name, value
    document.add_picture(str(work / 'chart.png'), width=Inches(4))
    document.save(work / 'report.docx')
    reopened = Document(work / 'report.docx')
    assert 'Total 124.75' in [paragraph.text for paragraph in reopened.paragraphs]
    assert sum(Decimal(row.cells[1].text) for row in reopened.tables[0].rows[1:]) == expected

    book = xlsxwriter.Workbook(work / 'report.xlsx')
    sheet = book.add_worksheet('Summary')
    sheet.write_row(0, 0, ['Work', 'Amount'])
    for index, (name, value) in enumerate(rows, 1):
        sheet.write(index, 0, name)
        sheet.write_number(index, 1, float(value))
    sheet.write(4, 0, 'Total')
    sheet.write_formula(4, 1, '=SUM(B2:B4)', None, float(expected))
    chart = book.add_chart({'type': 'column'})
    chart.add_series({'name': 'Amount', 'categories': '=Summary!$A$2:$A$4', 'values': '=Summary!$B$2:$B$4'})
    sheet.insert_chart('D2', chart)
    book.close()
    cached = load_workbook(work / 'report.xlsx', data_only=True, read_only=True)
    assert Decimal(str(cached['Summary']['B5'].value)) == expected
    cached.close()
    formulas = load_workbook(work / 'report.xlsx', data_only=False, read_only=True)
    assert formulas['Summary']['B5'].value == '=SUM(B2:B4)'
    formulas.close()

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    slide.shapes.title.text = 'ZeroAgent total 124.75'
    chart_data = CategoryChartData()
    chart_data.categories = [name for name, _ in rows]
    chart_data.add_series('Amount', [float(value) for _, value in rows])
    slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(2), Inches(7), Inches(4), chart_data)
    presentation.save(work / 'report.pptx')
    reopened_pptx = Presentation(work / 'report.pptx')
    assert reopened_pptx.slides[0].shapes.title.text == 'ZeroAgent total 124.75'
    reopened_chart = next(shape.chart for shape in reopened_pptx.slides[0].shapes if shape.has_chart)
    assert Decimal(str(sum(reopened_chart.series[0].values))) == expected
    for name in ['report.docx', 'report.xlsx', 'report.pptx']:
        with zipfile.ZipFile(work / name) as archive:
            assert archive.testzip() is None

    parsed = {}
    if parser:
        for kind, locator in [('pdf', 'page'), ('docx', 'paragraph'), ('xlsx', 'cell'), ('pptx', 'slide')]:
            source = work / ('report.' + kind)
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            scope = {'owner_scope': 'template-local-test', 'workspace_ref': 'template-acceptance'}
            payload = {'root': str(work), 'path': source.name, 'output_path': kind + '.segments.json',
                       'format': kind, 'source_sha256': digest, 'scope': scope, 'sandbox_id': 'local-not-e2b'}
            completed = subprocess.run([sys.executable, '-IB', str(parser)], input=json.dumps(payload),
                                       capture_output=True, text=True, timeout=50, check=True)
            assert len(completed.stdout) < 16384 and len(completed.stderr) < 16384
            receipt = json.loads(completed.stdout)
            assert 'error' not in receipt, receipt
            content = (work / payload['output_path']).read_bytes()
            assert len(content) == receipt['bytes'] and hashlib.sha256(content).hexdigest() == receipt['sha256']
            result = json.loads(content)
            assert result['scope'] == scope and result['source_sha256'] == digest
            assert result['segments'] and any(locator in item['locator'] for item in result['segments'])
            assert '124.75' in ' '.join(item['text'] for item in result['segments'])
            parsed[kind] = {'segments': len(result['segments']), 'locator': locator, 'sha256': receipt['sha256']}

    artifacts = {}
    for file in sorted(work.iterdir()):
        data = file.read_bytes()
        assert 0 < len(data) <= 2 * 1024 * 1024
        artifacts[file.name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    assert sum(item['bytes'] for item in artifacts.values()) <= 8 * 1024 * 1024
    return {'format': 1, 'local_only': True, 'e2b_allocations': 0, 'network': 'none-required',
            'sum': str(expected), 'artifacts': artifacts, 'parsed': parsed,
            'chinese_font': {'family': font.family_name, 'path': default_font, 'text': chinese,
                             'required_glyphs': len(chinese), 'missing_glyphs': 0,
                             'missing_glyph_warnings': 0, 'pdf_text_verified': True},
            'elapsed_seconds': round(time.monotonic() - started, 3), 'output_directory': str(work)}


if __name__ == '__main__':
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    arguments = argparse.ArgumentParser()
    arguments.add_argument('--parser', type=Path)
    arguments.add_argument('--report', type=Path)
    args = arguments.parse_args()
    result = run(args.parser)
    encoded = json.dumps(result, indent=2)
    if args.report:
        shutil.copytree(result['output_directory'], args.report.parent / 'outputs')
        args.report.write_text(encoded + '\n')
    print(encoded)
