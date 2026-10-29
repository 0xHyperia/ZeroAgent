"""Text extraction inside a dedicated E2B VM; never run user originals on Gateway."""
import base64
import hashlib
import io
import json
import os
import posixpath
import re
import resource
import secrets
import signal
import stat
import sys
import zipfile

MAX_SOURCE = 32 * 1024 * 1024
MAX_OUTPUT = 2 * 1024 * 1024
MAX_TEXT = 1024 * 1024
MAX_PART = 8 * 1024 * 1024
MAX_EXPANDED = 64 * 1024 * 1024
MAX_PAGES = 200
MAX_CELLS = 100_000
MAX_SEGMENTS = 5000
MAX_PARAGRAPHS = 10_000
MAX_SHEETS = 64
MAX_NODES = 200_000


class Rejected(Exception):
    pass


class Full(Exception):
    pass


def reject(code):
    raise Rejected(code)


def parts(path):
    result = path.split('/')
    if not path or len(path) > 1024 or result[0] == '.zeroagent-transfers' or any(x in ('', '.', '..') or '\\' in x or '\0' in x for x in result):
        reject('invalid_path')
    return result


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


def xml(data):
    from defusedxml.ElementTree import fromstring
    tree = fromstring(data, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    stack = [(tree, 0)]
    count = 0
    while stack:
        element, depth = stack.pop()
        count += 1
        if depth > 128 or count > MAX_NODES:
            reject('xml_limit')
        stack.extend((child, depth + 1) for child in element)
    return tree


def local(element):
    return element.tag.rsplit('}', 1)[-1]


def descendants(element, name):
    return (item for item in element.iter() if local(item) == name)


def text(element):
    return ''.join(item.text or '' for item in descendants(element, 't'))


class Archive:
    def __init__(self, stream):
        self.zip = zipfile.ZipFile(stream)
        infos = self.zip.infolist()
        if len(infos) > 2048:
            reject('zip_entries_limit')
        names = set()
        expanded = 0
        for item in infos:
            name = item.filename
            if name in names or name.startswith('/') or '\\' in name or '..' in name.split('/') or item.flag_bits & 1:
                reject('unsafe_archive')
            if stat.S_ISLNK(item.external_attr >> 16):
                reject('unsafe_archive')
            names.add(name)
            expanded += item.file_size
            if item.file_size > MAX_PART or expanded > MAX_EXPANDED or item.file_size > max(item.compress_size, 1) * 100:
                reject('zip_expansion_limit')
        self.names = names

    def read(self, name):
        with self.zip.open(name) as source:
            data = source.read(MAX_PART + 1)
        if len(data) > MAX_PART:
            reject('zip_expansion_limit')
        return xml(data)

    def relationships(self, name, base):
        result = {}
        for element in self.read(name):
            if local(element) != 'Relationship' or element.get('TargetMode') == 'External':
                continue
            target = element.get('Target', '')
            if ':' in target or '\\' in target:
                reject('unsafe_relationship')
            target = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(base, target))
            if target.startswith('../') or target not in self.names:
                reject('unsafe_relationship')
            result[element.get('Id')] = target
        return result


class Segments:
    def __init__(self):
        self.items = []
        self.bytes = 0
        self.truncated = False

    def add(self, value, locator):
        for offset in range(0, len(value), 2000):
            fragment = value[offset:offset + 2000]
            size = len(fragment.encode('utf-8'))
            if len(self.items) >= MAX_SEGMENTS or self.bytes + size > MAX_TEXT:
                self.truncated = True
                raise Full()
            self.bytes += size
            self.items.append({'id': 's%05d' % (len(self.items) + 1), 'locator': dict(locator, char_start=offset), 'text': fragment})


def extract(stream, kind, segments):
    warnings = []
    if kind == 'pdf':
        import pypdf.filters
        from pypdf import PdfReader
        pypdf.filters.ZLIB_MAX_OUTPUT_LENGTH = MAX_PART
        reader = PdfReader(stream, strict=True)
        if reader.is_encrypted:
            reject('encrypted_pdf')
        if len(reader.pages) > MAX_PAGES:
            reject('page_limit')
        for index, page in enumerate(reader.pages, 1):
            content = page.get_contents()
            if content and len(content.get_data()) > MAX_PART:
                reject('pdf_stream_limit')
            segments.add(page.extract_text() or '', {'page': index})
        if not segments.items:
            warnings.append('no_text_layer; OCR is not included')
        return warnings
    archive = Archive(stream)
    if kind == 'docx':
        for index, paragraph in enumerate(descendants(archive.read('word/document.xml'), 'p'), 1):
            if index > MAX_PARAGRAPHS:
                reject('paragraph_limit')
            segments.add(text(paragraph), {'part': 'word/document.xml', 'paragraph': index})
        warnings.append('main document body only; headers, footnotes and embedded objects excluded')
    elif kind == 'xlsx':
        workbook = archive.read('xl/workbook.xml')
        relationships = archive.relationships('xl/_rels/workbook.xml.rels', 'xl')
        shared = []
        if 'xl/sharedStrings.xml' in archive.names:
            for item in descendants(archive.read('xl/sharedStrings.xml'), 'si'):
                shared.append(text(item))
                if len(shared) > MAX_CELLS:
                    reject('cell_limit')
        count = 0
        for sheet_index, sheet in enumerate(descendants(workbook, 'sheet'), 1):
            if sheet_index > MAX_SHEETS:
                reject('sheet_limit')
            rid = next((value for key, value in sheet.attrib.items() if key.endswith('}id')), None)
            if rid not in relationships:
                reject('invalid_workbook')
            for cell in descendants(archive.read(relationships[rid]), 'c'):
                count += 1
                if count > MAX_CELLS:
                    reject('cell_limit')
                ref = cell.get('r', '')
                if not re.fullmatch('[A-Z]{1,3}[1-9][0-9]{0,6}', ref):
                    reject('invalid_cell')
                column = 0
                for letter in re.match('[A-Z]+', ref).group():
                    column = column * 26 + ord(letter) - 64
                if column > 16384 or int(re.search('[0-9]+', ref).group()) > 1048576 or len(sheet.get('name', '')) > 31:
                    reject('invalid_cell')
                value = next((item.text or '' for item in cell if local(item) == 'v'), '')
                if cell.get('t') == 's':
                    if not value.isdigit() or int(value) >= len(shared):
                        reject('invalid_shared_string')
                    value = shared[int(value)]
                elif cell.get('t') == 'inlineStr':
                    value = text(cell)
                formula = next((item.text or '' for item in cell if local(item) == 'f'), '')
                if formula and not value:
                    value = '=' + formula
                segments.add(value, {'sheet': sheet.get('name', ''), 'sheet_index': sheet_index, 'cell': ref})
        warnings.append('formulas are never executed; cached/raw values only')
    elif kind == 'pptx':
        presentation = archive.read('ppt/presentation.xml')
        relationships = archive.relationships('ppt/_rels/presentation.xml.rels', 'ppt')
        for slide_index, slide in enumerate(descendants(presentation, 'sldId'), 1):
            if slide_index > MAX_PAGES:
                reject('page_limit')
            rid = next((value for key, value in slide.attrib.items() if key.endswith('}id')), None)
            if rid not in relationships:
                reject('invalid_presentation')
            for paragraph_index, paragraph in enumerate(descendants(archive.read(relationships[rid]), 'p'), 1):
                if paragraph_index > MAX_PARAGRAPHS:
                    reject('paragraph_limit')
                segments.add(text(paragraph), {'slide': slide_index, 'paragraph': paragraph_index})
        warnings.append('slide text only; notes, media and embedded objects excluded')
    else:
        reject('unsupported_format')
    return warnings


def run(p):
    source_parts, output_parts = parts(p['path']), parts(p['output_path'])
    if p['path'] == p['output_path'] or not re.fullmatch('[a-f0-9]{64}', p['source_sha256']):
        reject('invalid_request')
    slash = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        root = directory(slash, p['root'].strip('/').split('/'))
    finally:
        os.close(slash)
    try:
        parent = directory(root, source_parts[:-1])
        try:
            fd = os.open(source_parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        finally:
            os.close(parent)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_SOURCE:
                reject('source_limit')
            data = stream.read(MAX_SOURCE + 1)
            if len(data) > MAX_SOURCE or hashlib.sha256(data).hexdigest() != p['source_sha256']:
                reject('digest_mismatch')
        segments = Segments()
        warnings = []
        try:
            warnings = extract(io.BytesIO(data), p['format'], segments)
        except Full:
            warnings.append('text/segment limit reached; partial extraction')
        document = {'version': 1, 'format': p['format'], 'source_sha256': p['source_sha256'], 'scope': p['scope'],
                    'sandbox_id': p['sandbox_id'], 'segments': segments.items, 'truncated': segments.truncated, 'warnings': warnings}
        encoded = json.dumps(document, ensure_ascii=False, separators=(',', ':')).encode()
        if len(encoded) > MAX_OUTPUT:
            reject('output_limit')
        target = directory(root, output_parts[:-1], create=True)
        temp = '.zeroagent-parse-' + secrets.token_hex(16)
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.rename(temp, output_parts[-1], src_dir_fd=target, dst_dir_fd=target)
            os.fsync(target)
        finally:
            try:
                os.unlink(temp, dir_fd=target)
            except FileNotFoundError:
                pass
            os.close(target)
        return {'output_path': p['output_path'], 'bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest(),
                'segment_count': len(segments.items), 'truncated': segments.truncated, 'scope': p['scope']}
    finally:
        os.close(root)


def main():
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT + 65536, MAX_OUTPUT + 65536))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    signal.signal(signal.SIGALRM, lambda *_: reject('parse_timeout'))
    signal.alarm(45)
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            reject('input_limit')
        print(json.dumps(run(json.loads(raw))))
    except Rejected as error:
        print(json.dumps({'error': str(error), 'uncertain': False}))
    except ImportError:
        print(json.dumps({'error': 'parser_dependency_missing', 'uncertain': False}))
    except BaseException:
        print(json.dumps({'error': 'parse_failed', 'uncertain': True}))
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    main()
