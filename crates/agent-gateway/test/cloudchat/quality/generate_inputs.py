"""Create synthetic quality inputs offline; never overwrites an evidence directory.

Run in the pinned local template image with an explicit, empty output path.
This generates inputs and independent expectations, not model acceptance results.
"""
import argparse
import csv
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import zipfile


def generate(output):
    output.mkdir(exist_ok=False)
    os.environ.setdefault('MPLBACKEND', 'Agg')
    os.environ.setdefault('MPLCONFIGDIR', '/tmp/quality-mpl')
    import matplotlib.pyplot as plt
    from docx import Document
    from openpyxl import Workbook, load_workbook
    from pypdf import PdfReader
    from PIL import Image, ImageDraw, ImageFont
    from matplotlib import font_manager

    policies = {
        'policy-before.pdf': ['Policy A - synthetic', 'Effective: 2026-10-01',
                              'Upload limit: 10 MiB', 'Concurrent workers: 2',
                              'Objects remain available after a workspace stops.'],
        'policy-after.pdf': ['Policy B - synthetic', 'Effective: 2026-10-29',
                             'Upload limit: 32 MiB', 'Concurrent workers: 4',
                             'Objects remain available after a workspace stops.'],
    }
    for name, lines in policies.items():
        figure = plt.figure(figsize=(8.27, 11.69))
        for index, text in enumerate(lines):
            figure.text(0.12, 0.88 - index * 0.07, text, fontsize=13)
        figure.savefig(output / name, metadata={'CreationDate': None, 'ModDate': None})
        plt.close(figure)
        reader = PdfReader(output / name)
        assert len(reader.pages) == 1
        assert all(text in reader.pages[0].extract_text() for text in lines)

    # An informative image is needed for semantic vision acceptance; the tiny
    # protocol PNG only establishes that original bytes reached the model.
    font_path = font_manager.findfont(
        font_manager.FontProperties(family=['Noto Sans SC']), fallback_to_default=False)
    def chinese_font(size):
        font = ImageFont.truetype(font_path, size)
        axes = font.get_variation_axes()
        if axes:
            font.set_variation_by_axes([400 if axis['minimum'] <= 400 <= axis['maximum']
                                        else axis['default'] for axis in axes])
        return font
    image = Image.new('RGB', (960, 640), '#fafafa')
    draw = ImageDraw.Draw(image)
    draw.text((60, 35), '试点资源分配（合成数据）', font=chinese_font(36), fill='#182232')
    vision_rows = [('研发', '19.50'), ('运营', '30.00'), ('设计', '75.25')]
    for index, row in enumerate([('项目', '金额（元）'), *vision_rows, ('合计', '124.75')]):
        y = 120 + index * 80
        draw.line((60, y + 60, 900, y + 60), fill='#cbd1d9', width=2)
        draw.text((90, y), row[0], font=chinese_font(30), fill='#182232')
        draw.text((620, y), row[1], font=chinese_font(30), fill='#182232')
    draw.text((60, 560), '仅用于图像理解验收，不代表真实业务。',
              font=chinese_font(24), fill='#465369')
    image.save(output / 'resource-table.png')
    # This control deliberately has image pixels and no PDF text layer. A
    # parser must report its text-extraction limit instead of inventing text.
    image.save(output / 'scanned-table.pdf', resolution=150.0)
    scanned = PdfReader(output / 'scanned-table.pdf')
    assert len(scanned.pages) == 1 and not scanned.pages[0].extract_text().strip()
    with Image.open(output / 'resource-table.png') as reopened:
        assert reopened.size == (960, 640)
        reopened.verify()

    document = Document()
    document.add_heading('合成项目会议纪要', 0)
    for line in ['项目名称：北辰试点。', '负责人：合成人物甲；首批预算：5000 元。',
                 '验收日期：2026-11-15。', '限制：不得自动发送邮件，不得发布公开链接。',
                 '待确认：客户数量尚未确定，不能写成已经签约。']:
        document.add_paragraph(line)
    document.save(output / 'meeting.docx')
    assert Document(output / 'meeting.docx').paragraphs[-1].text.endswith('不能写成已经签约。')

    rows = [['A', '1', '19.50'], ['B', '2', '15.00'], ['B', '2', '15.00'],
            ['C', '', '8.00'], ['D', '1', '-5.25']]
    with (output / 'orders.csv').open('w', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['order_id', 'quantity', 'unit_price'])
        writer.writerows(rows)
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = '订单'
    sheet.append(['order_id', 'quantity', 'unit_price'])
    for row in rows:
        sheet.append(row)
    workbook.save(output / 'orders.xlsx')
    assert load_workbook(output / 'orders.xlsx', read_only=True).active.max_row == 6
    seen, amounts = set(), []
    for identifier, quantity, price in rows:
        if identifier not in seen and quantity:
            amounts.append(Decimal(quantity) * Decimal(price))
        seen.add(identifier)
    assert sum(amounts) == Decimal('44.25')

    code = '''from decimal import Decimal

def total(rows):
    # Deliberate fixture bug: duplicates count twice and blank quantities fail.
    return sum(Decimal(row['quantity']) * Decimal(row['unit_price']) for row in rows)
'''
    tests = '''import unittest
from decimal import Decimal
from total import total

class Totals(unittest.TestCase):
    def test_unique_valid_orders_and_refund(self):
        rows = [dict(order_id=i, quantity=q, unit_price=p) for i,q,p in
                [('A','1','19.50'),('B','2','15.00'),('B','2','15.00'),
                 ('C','','8.00'),('D','1','-5.25')]]
        self.assertEqual(total(rows), Decimal('44.25'))
    def test_empty(self):
        self.assertEqual(total([]), Decimal('0'))
'''
    with zipfile.ZipFile(output / 'code-task.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, text in {'total.py': code, 'test_total.py': tests,
                           'README.txt': 'Run: python3 -m unittest -v. All data is synthetic.\n'}.items():
            info = zipfile.ZipInfo(name, (2026, 10, 29, 0, 0, 0))
            archive.writestr(info, text)

    expected = {'format': 1, 'synthetic_only': True, 'model_acceptance': False,
                'document_diff': {'pages': [1, 1], 'upload_mib': [10, 32],
                                  'workers': [2, 4], 'durable_objects_unchanged': True},
                'orders': {'source_rows': 5, 'duplicate_rows': 1, 'missing_quantity_rows': 1,
                           'valid_unique_rows': 3, 'net_total': '44.25',
                           'exclude_refunds_total': '49.50'},
                'writing': {'budget_cny': 5000, 'deadline': '2026-11-15',
                            'customer_count_known': False, 'email_or_publication_authorized': False},
                'vision': {'file': 'resource-table.png', 'width': 960, 'height': 640,
                           'rows': dict(vision_rows), 'total': '124.75', 'largest': '设计'},
                'scanned_pdf': {'file': 'scanned-table.pdf', 'pages': 1,
                                'text_layer_empty': True, 'must_not_claim_text_extracted': True},
                'code': {'command': 'python3 -m unittest -v', 'original_expected_to_fail': True,
                         'fixed_tests': 2}}
    expected['inputs'] = {file.name: {'bytes': file.stat().st_size,
                         'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
                         for file in sorted(output.iterdir()) if file.is_file()}
    (output / 'expected.json').write_text(json.dumps(expected, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'created': len(expected['inputs']), 'model_acceptance': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('new_output_directory', type=Path)
    generate(parser.parse_args().new_output_directory)
