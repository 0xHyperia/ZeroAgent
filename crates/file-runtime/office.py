import csv
from copy import copy
import os
from pathlib import Path
import posixpath
import re
import shutil
from zipfile import ZipFile

from runtime_common import FileToolError, checked_zip, engine_path, run_engine


WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
SLIDE = "http://schemas.openxmlformats.org/presentationml/2006/main"
DRAW = "http://schemas.openxmlformats.org/drawingml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
MAIN_PART = {"documents": "word/document.xml", "spreadsheet": "xl/workbook.xml",
             "presentations": "ppt/presentation.xml"}


def tag(namespace, local):
    return f"{{{namespace}}}{local}"


def xml(data):
    from lxml import etree

    try:
        node = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError as error:
        raise FileToolError("invalid_xml", "The Office file contains an invalid XML part.") from error
    if node.getroottree().docinfo.doctype:
        raise FileToolError("invalid_xml", "Office XML cannot contain a document type declaration.")
    return node


def related_parts(archive, part, elements):
    folder, filename = posixpath.split(part)
    links = xml(archive.read(f"{folder}/_rels/{filename}.rels"))
    by_id = {item.get("Id"): item for item in links}
    for element in elements:
        link = by_id[element.get(tag(REL, "id"))]
        target = link.get("Target")
        if link.get("TargetMode") == "External":
            raise FileToolError("external_part", "An external Office part cannot be edited.")
        yield posixpath.normpath(posixpath.join(folder, target)).lstrip("/")


def rewrite(archive, output, changes):
    from lxml import etree

    with ZipFile(output, "w") as writer:
        for entry in archive.infolist():
            if entry.filename in changes:
                data = etree.tostring(changes[entry.filename], encoding="UTF-8", xml_declaration=True)
            else:
                data = archive.read(entry)
            writer.writestr(copy(entry), data)
        for name in changes.keys() - set(archive.namelist()):
            writer.writestr(name, etree.tostring(changes[name], encoding="UTF-8", xml_declaration=True))


def replace_text(nodes, before, after):
    if not isinstance(before, str) or not before or not isinstance(after, str):
        raise FileToolError("invalid_text", "Provide the exact original text and its replacement.")
    text = "".join(node.text or "" for node in nodes)
    if text.count(before) != 1:
        raise FileToolError("anchor_conflict", "The selected text does not uniquely match its anchor.")
    left = text.index(before)
    right = left + len(before)
    start = 0
    for node in nodes:
        value = node.text or ""
        end = start + len(value)
        if start < right and end > left:
            prefix = value[:max(0, left - start)]
            suffix = value[max(0, right - start):]
            node.text = prefix + (after if start <= left < end else "") + suffix
            if node.text != node.text.strip():
                node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        start = end


def office_convert(source, output, scratch, recalculate=False):
    if source.suffix == output.suffix and not recalculate:
        raise FileToolError("invalid_output_format", "Choose a different conversion format.")
    folder = scratch / "converted"
    folder.mkdir(exist_ok=True)
    profile = (scratch / "office-profile").as_uri()
    # Use a new profile for each job, with macro security at its highest setting.
    settings = scratch / "office-profile" / "user"
    settings.mkdir(parents=True, exist_ok=True)
    (settings / "registrymodifications.xcu").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
        '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
        '</item><item oor:path="/org.openoffice.Office.Calc/Content/Update">'
        '<prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>',
        encoding="utf-8")
    export_filter = {
        ".csv": "csv:Text - txt - csv (StarCalc):44,34,76,1",
        ".tsv": "tsv:Text - txt - csv (StarCalc):9,34,76,1",
    }.get(output.suffix, output.suffix[1:])
    source_filter = {
        ".csv": ["--infilter=Text - txt - csv (StarCalc):44,34,76,1,,0,false,false"],
        ".tsv": ["--infilter=Text - txt - csv (StarCalc):9,34,76,1,,0,false,false"],
    }.get(source.suffix, [])
    # LibreOffice starts its own Python interpreter for PyUNO.
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    run_engine([engine_path("ZEROAGENT_FILE_SOFFICE"), f"-env:UserInstallation={profile}",
                "--headless", "--nologo", "--norestore", *source_filter, "--convert-to", export_filter,
                "--outdir", str(folder), str(source)], scratch, env=env)
    converted = folder / (source.stem + output.suffix)
    if not converted.is_file():
        raise FileToolError("conversion_failed", "Office did not produce a converted file.")
    shutil.move(converted, output)


def create_document(workspace, request, output, source):
    from docx import Document
    from docx.enum.section import WD_ORIENT
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Inches

    document = Document(source)
    for block in request.get("blocks", []):
        kind = block.get("type", "paragraph")
        if kind == "paragraph":
            document.add_paragraph(block.get("text", ""), style=block.get("style"))
        elif kind == "heading":
            document.add_heading(block["text"], level=block.get("level", 1))
        elif kind == "section":
            section = document.add_section()
            if "landscape" in block:
                landscape = block["landscape"] is True
                section.orientation = WD_ORIENT.LANDSCAPE if landscape else WD_ORIENT.PORTRAIT
                short, long = sorted((section.page_width, section.page_height))
                section.page_width, section.page_height = (long, short) if landscape else (short, long)
            for margin, value in block.get("margins", {}).items():
                if margin not in ("top", "bottom", "left", "right") or not 0.25 <= value <= 3:
                    raise FileToolError("invalid_margin", "Specify margins from 0.25 to 3 inches.")
                setattr(section, margin + "_margin", Inches(value))
        elif kind in ("header", "footer"):
            section = document.sections[-1]
            getattr(section, kind).paragraphs[0].text = block["text"]
        elif kind == "page_break":
            document.add_page_break()
        elif kind == "image":
            image = document.add_picture(str(workspace.source(block["source"])), width=Inches(block.get("width", 4)))
            if "alt" in block:
                image._inline.docPr.set("descr", block["alt"])
        elif kind == "link":
            add_document_link(document.add_paragraph(style=block.get("style")), block)
        elif kind == "table":
            rows = block["rows"]
            table = document.add_table(rows=0, cols=len(rows[0]), style=block.get("style"))
            for index, row in enumerate(rows):
                table_row = table.add_row()
                if index == 0 and block.get("header") is True:
                    marker = OxmlElement("w:tblHeader")
                    marker.set(qn("w:val"), "true")
                    table_row._tr.get_or_add_trPr().append(marker)
                for cell, value in zip(table_row.cells, row, strict=True):
                    cell.text = str(value)
        else:
            raise FileToolError("unsupported_operation", f"Unknown document block: {kind}")
    document.save(output)


def add_document_link(paragraph, block):
    from urllib.parse import urlsplit

    from docx.opc.constants import RELATIONSHIP_TYPE
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    url = block["url"]
    parsed = urlsplit(url)
    if (parsed.scheme not in ("https", "http", "mailto")
            or (parsed.scheme != "mailto" and not parsed.hostname)):
        raise FileToolError("invalid_link", "Supply a web or email address for the link.")
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), paragraph.part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True))
    run = paragraph.add_run(block["text"])
    hyperlink.append(run._r)
    paragraph._p.append(hyperlink)


def create_workbook(request, output, source):
    from openpyxl import Workbook, load_workbook
    from openpyxl.chart import BarChart, LineChart, Reference
    from openpyxl.worksheet.datavalidation import DataValidation
    from openpyxl.worksheet.formula import DataTableFormula
    from openpyxl.worksheet.table import Table
    from openpyxl.workbook.defined_name import DefinedName

    workbook = load_workbook(source) if source else Workbook()
    if not source and request.get("sheets"):
        workbook.remove(workbook.active)
    for spec in request.get("sheets", []):
        name = spec["name"]
        sheet = workbook[name] if name in workbook.sheetnames else workbook.create_sheet(name)
        for row in spec.get("rows", []):
            sheet.append(row)
        for address, value in spec.get("cells", {}).items():
            sheet[address] = value
        for address, number_format in spec.get("number_formats", {}).items():
            sheet[address].number_format = number_format
        for address, formula in spec.get("data_tables", {}).items():
            sheet[address] = DataTableFormula(**formula)
        for table in spec.get("tables", []):
            sheet.add_table(Table(displayName=table["name"], ref=table["range"]))
        for validation in spec.get("validation", []):
            rule = DataValidation(type=validation["type"], formula1=validation["formula"])
            sheet.add_data_validation(rule)
            rule.add(validation["range"])
        for chart in spec.get("charts", []):
            graph = {"bar": BarChart, "line": LineChart}[chart["type"]]()
            graph.title = chart.get("title")
            graph.add_data(Reference(range_string=f"'{name.replace(chr(39), chr(39) * 2)}'!{chart['range']}"))
            sheet.add_chart(graph, chart["anchor"])
    for name, reference in request.get("names", {}).items():
        workbook.defined_names.add(DefinedName(name, attr_text=reference))
    workbook.save(output)


def create_presentation(workspace, request, output, source):
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.util import Inches

    deck = Presentation(source)
    for spec in request.get("slides", []):
        slide = deck.slides.add_slide(deck.slide_layouts[spec.get("layout", 6)])
        if "notes" in spec:
            slide.notes_slide.notes_text_frame.text = spec["notes"]
        for item in spec.get("objects", []):
            geometry = [Inches(value) for value in item["box"]]
            kind = item["type"]
            if kind == "text":
                shape = slide.shapes.add_textbox(*geometry)
                shape.text = item["text"]
                if "link" in item:
                    shape.text_frame.paragraphs[0].runs[0].hyperlink.address = item["link"]
            elif kind == "image":
                slide.shapes.add_picture(str(workspace.source(item["source"])), *geometry)
            elif kind == "shape":
                shape = slide.shapes.add_shape(MSO_SHAPE[item["shape"]], *geometry)
                shape.text = item.get("text", "")
            elif kind == "table":
                rows = item["rows"]
                table = slide.shapes.add_table(len(rows), len(rows[0]), *geometry).table
                for r, row in enumerate(rows):
                    for c, value in enumerate(row):
                        table.cell(r, c).text = str(value)
            elif kind == "chart":
                data = CategoryChartData()
                data.categories = item["categories"]
                for name, values in item["series"].items():
                    data.add_series(name, values)
                slide.shapes.add_chart(XL_CHART_TYPE[item["chart"]], *geometry, data)
            else:
                raise FileToolError("unsupported_operation", f"Unknown slide object: {kind}")
    deck.save(output)


def document_change(node, operation):
    name = operation["op"]
    if name in ("accept_revision", "reject_revision"):
        revisions = [item for item in node.iter()
                     if item.tag in (tag(WORD, "ins"), tag(WORD, "del"))
                     and ("id" not in operation or item.get(tag(WORD, "id")) == str(operation["id"]))]
        if not revisions:
            raise FileToolError("anchor_conflict", "The requested revision was not found.")
        for revision in reversed(revisions):
            parent = revision.getparent()
            keep = (name == "accept_revision") == (revision.tag == tag(WORD, "ins"))
            if keep:
                for child in list(revision):
                    if name == "reject_revision":
                        for value in child.iter(tag(WORD, "delText")):
                            value.tag = tag(WORD, "t")
                    revision.addprevious(child)
            parent.remove(revision)
        return
    if name in ("replace_text", "track_replace_text"):
        paragraphs = list(node.iter(tag(WORD, "p")))
        index = operation["paragraph"]
        if type(index) is not int or not 0 <= index < len(paragraphs):
            raise FileToolError("anchor_conflict", "The selected paragraph does not exist.")
        selected = paragraphs[index]
        nodes = [item for item in selected.iter(tag(WORD, "t"))
                 if next(item.iterancestors(tag(WORD, "p")), None) is selected]
        if name == "track_replace_text":
            track_document_replacement(node, nodes, operation)
        else:
            replace_text(nodes, operation["before"], operation["after"])
        return
    raise FileToolError("unsupported_operation", f"Unknown document operation: {name}")


def track_document_replacement(root, nodes, operation):
    from copy import deepcopy
    from lxml import etree

    before, after = operation["before"], operation["after"]
    if not isinstance(before, str) or not before or not isinstance(after, str):
        raise FileToolError("invalid_text", "Supply exact original and replacement text.")
    matches = [item for item in nodes if (item.text or "") == before]
    if len(matches) != 1:
        raise FileToolError("anchor_conflict", "A tracked replacement requires one complete text run.")
    run = matches[0].getparent()
    if run.tag != tag(WORD, "r") or any(child.tag not in (tag(WORD, "rPr"), tag(WORD, "t")) for child in run) \
            or len(run.findall(tag(WORD, "t"))) != 1 or any(
                parent.tag in (tag(WORD, "ins"), tag(WORD, "del")) for parent in run.iterancestors()):
        raise FileToolError("anchor_conflict", "The text run already has revisions or other content.")
    existing_ids = [int(raw) for item in root.iter()
                    if (raw := item.get(tag(WORD, "id"), "")).isdigit()]
    identity = max(existing_ids, default=0) + 1
    for offset, (action, value) in enumerate((("del", before), ("ins", after))):
        if not value:
            continue
        wrapper = etree.Element(tag(WORD, action), {
            tag(WORD, "id"): str(identity + offset),
            tag(WORD, "author"): "ZeroAgent",
        })
        copy = deepcopy(run)
        text = copy.find(tag(WORD, "t"))
        text.text = value
        if action == "del":
            text.tag = tag(WORD, "delText")
        if value.strip() != value:
            text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        wrapper.append(copy)
        run.addprevious(wrapper)
    run.getparent().remove(run)


def slide_change(node, operation):
    shape_id = str(operation["shape_id"])
    matches = [shape for item, shape in slide_objects(node) if item.get("id") == shape_id]
    if len(matches) != 1:
        raise FileToolError("anchor_conflict", "Select one editable slide object.")
    shape = matches[0]
    action = operation["op"]
    if action == "replace_text":
        replace_text(list(shape.iter(tag(DRAW, "t"))), operation["before"], operation["after"])
    elif action == "delete_object":
        shape.getparent().remove(shape)
    else:
        raise FileToolError("unsupported_operation", f"Unknown presentation operation: {action}")


def slide_objects(node):
    for item in node.iter(tag(SLIDE, "cNvPr")):
        shape = item.getparent().getparent()
        if shape.tag != tag(SLIDE, "spTree"):
            yield item, shape


def spreadsheet_change(node, operation):
    from lxml import etree
    from openpyxl.utils.cell import coordinate_to_tuple

    if operation["op"] != "set_cell":
        raise FileToolError("unsupported_operation", "Use set_cell to change a value or formula.")
    address = operation["cell"].upper()
    if not re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]{0,6}", address):
        raise FileToolError("anchor_conflict", "Use one exact A1 cell address.")
    row_number, column = coordinate_to_tuple(address)
    if row_number > 1048576 or column > 16384:
        raise FileToolError("anchor_conflict", "The cell is outside the spreadsheet.")
    sheet_data = node.find(tag(SHEET, "sheetData"))
    row = sheet_data.find(f"{{{SHEET}}}row[@r='{row_number}']")
    if row is None:
        row = etree.Element(tag(SHEET, "row"), r=str(row_number))
        following = next((item for item in sheet_data if int(item.get("r")) > row_number), None)
        if following is None:
            sheet_data.append(row)
        else:
            following.addprevious(row)
    cell = row.find(f"{{{SHEET}}}c[@r='{address}']")
    if cell is None:
        cell = etree.Element(tag(SHEET, "c"), r=address)
        following = next((item for item in row.iterchildren(tag(SHEET, "c"))
                          if coordinate_to_tuple(item.get("r"))[1] > column), None)
        if following is None:
            row.append(cell)
        else:
            following.addprevious(cell)
    formula = cell.find(tag(SHEET, "f"))
    if formula is not None and formula.attrib:
        raise FileToolError("unsupported_operation", "Shared, array and data-table formulas require a range operation.")
    for child in list(cell):
        if child.tag in (tag(SHEET, "f"), tag(SHEET, "v"), tag(SHEET, "is")):
            cell.remove(child)
    cell.attrib.pop("t", None)
    value = operation.get("value")
    if operation.get("formula") is not None:
        formula = operation["formula"]
        if not isinstance(formula, str) or not formula.startswith("=") or len(formula) < 2:
            raise FileToolError("invalid_formula", "A formula must start with '='.")
        etree.SubElement(cell, tag(SHEET, "f")).text = formula[1:]
    elif isinstance(value, str):
        cell.set("t", "inlineStr")
        inline = etree.SubElement(cell, tag(SHEET, "is"))
        text = etree.SubElement(inline, tag(SHEET, "t"))
        text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        text.text = value
    elif value is not None:
        if isinstance(value, bool):
            cell.set("t", "b")
            value = int(value)
        if not isinstance(value, (int, float)):
            raise FileToolError("invalid_value", "Supply a text, numeric, Boolean, or null cell value.")
        etree.SubElement(cell, tag(SHEET, "v")).text = str(value)


def edit_office(kind, source, output, operations, scratch):
    if not isinstance(operations, list) or not 0 < len(operations) <= 100:
        raise FileToolError("invalid_operations", "Supply between 1 and 100 changes.")
    with checked_zip(source) as archive:
        if any(name.startswith("_xmlsignatures/") for name in archive.namelist()):
            raise FileToolError("signed_file", "Editing would invalidate the document signature.")
        main = MAIN_PART[kind]
        root = xml(archive.read(main))
        changes = {}
        if kind == "spreadsheet":
            sheets = root.findall(f"./{tag(SHEET, 'sheets')}/{tag(SHEET, 'sheet')}")
            parts = dict(zip((item.get("name") for item in sheets), related_parts(archive, main, sheets), strict=True))
        elif kind == "presentations":
            slides = root.findall(f"./{tag(SLIDE, 'sldIdLst')}/{tag(SLIDE, 'sldId')}")
            parts = list(related_parts(archive, main, slides))
        for operation in operations:
            if kind == "presentations" and operation["op"] == "reorder_slides":
                order = operation["order"]
                if not isinstance(order, list) or any(type(n) is not int for n in order) or sorted(order) != list(range(1, len(slides) + 1)):
                    raise FileToolError("invalid_order", "Include every existing slide exactly once.")
                container = root.find(tag(SLIDE, "sldIdLst"))
                for number in order:
                    container.append(slides[number - 1])
                changes[main] = root
                continue
            if kind == "documents":
                part = operation.get("part", main)
                if not re.fullmatch(r"word/(?:document|header[0-9]+|footer[0-9]+|footnotes|endnotes)\.xml", part):
                    raise FileToolError("anchor_conflict", "The selected Word document part is unsupported.")
            elif kind == "spreadsheet":
                part = parts.get(operation["sheet"])
            else:
                number = operation["slide"]
                part = parts[number - 1] if type(number) is int and 0 < number <= len(parts) else None
            if part is None:
                raise FileToolError("anchor_conflict", "The selected sheet or slide does not exist.")
            if part not in changes:
                changes[part] = xml(archive.read(part))
            node = changes[part]
            if kind == "documents":
                if operation["op"] in ("add_comment", "update_comment", "remove_comment"):
                    from document_review import change_comment

                    if part != main:
                        raise FileToolError("unsupported_comment_part", "Select a comment in the main document.")
                    change_comment(archive, changes, node, operation)
                else:
                    document_change(node, operation)
            elif kind == "spreadsheet":
                spreadsheet_change(node, operation)
            else:
                slide_change(node, operation)
        rewrite(archive, output, changes)
        if kind == "spreadsheet":
            recalculate_workbook(output, parts, scratch)
    return {"modified_parts": sorted(changes), "applied_operations": len(operations)}


def recalculate_workbook(output, parts, scratch):
    from lxml import etree
    from openpyxl import load_workbook

    changes = {}
    recalculated = scratch / "recalculated.xlsx"
    with checked_zip(output) as archive:
        for sheet, part in parts.items():
            root = xml(archive.read(part))
            if any(cell.find(tag(SHEET, "f")) is not None for cell in root.iter(tag(SHEET, "c"))):
                changes[sheet] = (part, root)
        if not changes:
            return
        # Force the recalculation copy to compute formulas even when the input
        # producer marked all of its caches as current.
        input_path = scratch / "formula-check.xlsx"
        for _, root in changes.values():
            for cell in root.iter(tag(SHEET, "c")):
                if cell.find(tag(SHEET, "f")) is not None:
                    cached = cell.find(tag(SHEET, "v"))
                    if cached is not None:
                        cell.remove(cached)
        rewrite(archive, input_path, {part: root for part, root in changes.values()})
        office_recalculate(input_path, recalculated, scratch)
        computed = load_workbook(recalculated, read_only=True, data_only=True)
        try:
            replacements = {}
            for sheet, (part, root) in changes.items():
                values = computed[sheet]
                for cell in root.iter(tag(SHEET, "c")):
                    formula = cell.find(tag(SHEET, "f"))
                    if formula is None:
                        continue
                    if formula.attrib:
                        raise FileToolError("unverified_formula", "This workbook has formula ranges the engine cannot verify.")
                    candidate = values[cell.get("r")]
                    value = candidate.value
                    if candidate.data_type == "e" or not isinstance(value, (str, bool, int, float)):
                        raise FileToolError("unverified_formula", f"Unable to recalculate {sheet}!{cell.get('r')}.")
                    cell.attrib.pop("t", None)
                    if isinstance(value, bool):
                        cell.set("t", "b")
                        value = int(value)
                    elif isinstance(value, str):
                        cell.set("t", "str")
                    current = cell.find(tag(SHEET, "v"))
                    if current is None:
                        current = etree.SubElement(cell, tag(SHEET, "v"))
                    current.text = str(value)
                replacements[part] = root
            verified = scratch / "formula-verified.xlsx"
            rewrite(archive, verified, replacements)
        finally:
            computed.close()
    verified.replace(output)


def office_recalculate(source, output, scratch):
    # Different parent directory forces a fresh save even when both files are XLSX.
    office_convert(source, output, scratch, recalculate=True)


def office_inspect(kind, source, include_content, request):
    if source.suffix in (".csv", ".tsv"):
        with source.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.reader(stream, delimiter="," if source.suffix == ".csv" else "\t", strict=True)
            rows = []
            count = 0
            for row in reader:
                count += 1
                if include_content and count <= 40:
                    rows.append([value[:2000] for value in row[:50]])
        return {"format": source.suffix[1:], "row_count": count, **({"rows": rows} if include_content else {})}
    with checked_zip(source) as archive:
        main = MAIN_PART[kind]
        root = xml(archive.read(main))
        if kind == "documents":
            paragraphs = list(root.iter(tag(WORD, "p")))
            result = {"format": "docx", "paragraph_count": len(paragraphs)}
            if include_content:
                result["paragraphs"] = [{"paragraph": i, "text": "".join(n.text or "" for n in p.iter(tag(WORD, "t")))[:2000]}
                                        for i, p in enumerate(paragraphs[:100])]
            if request.get("audit") is True:
                from document_review import audit_document

                result["audit"] = audit_document(archive, root)
            return result
        if kind == "spreadsheet":
            sheets = root.findall(f"./{tag(SHEET, 'sheets')}/{tag(SHEET, 'sheet')}")
            names = [item.get("name") for item in sheets]
            result = {"format": "xlsx", "sheets": names}
            if include_content and "sheet" in request:
                from openpyxl import load_workbook
                from openpyxl.utils.cell import range_boundaries

                left, top, right, bottom = range_boundaries(request.get("range", "A1:J20"))
                if not all((left, top, right, bottom)) or not (1 <= left <= right <= 16384 and 1 <= top <= bottom <= 1048576
                        and (right - left + 1) * (bottom - top + 1) <= 1000):
                    raise FileToolError("invalid_range", "Inspect a bounded rectangular range of up to 1000 cells.")
                book = load_workbook(source, read_only=True, data_only=request.get("cached") is True)
                try:
                    selected = book[request["sheet"]]
                    result["rows"] = [[str(value)[:2000] if value is not None else None for value in row]
                                      for row in selected.iter_rows(min_row=top, max_row=bottom, min_col=left,
                                                                    max_col=right, values_only=True)]
                finally:
                    book.close()
            return result
        slides = root.findall(f"./{tag(SLIDE, 'sldIdLst')}/{tag(SLIDE, 'sldId')}")
        result = {"format": "pptx", "slide_count": len(slides)}
        if include_content:
            result["slides"] = []
            for index, part in enumerate(related_parts(archive, main, slides[:100]), 1):
                node = xml(archive.read(part))
                result["slides"].append({"slide": index, "shapes": [
                    {"id": item.get("id"), "name": item.get("name"),
                     "text": "".join(n.text or "" for n in shape.iter(tag(DRAW, "t")))[:2000]}
                    for item, shape in list(slide_objects(node))[:100]]})
        return result


def office_operation(workspace, kind, operation, source, output, request, scratch):
    if operation in ("inspect", "verify"):
        if source.suffix in (".doc", ".xls", ".ppt"):
            converted = scratch / {"documents": "legacy.docx", "spreadsheet": "legacy.xlsx",
                                   "presentations": "legacy.pptx"}[kind]
            office_convert(source, converted, scratch)
            source = converted
        result = office_inspect(kind, source, operation == "inspect", request)
        if operation == "verify" and kind == "documents" and "baseline" in request:
            from document_review import compare_parts

            baseline = workspace.source(request["baseline"])
            result["changed_parts"] = compare_parts(baseline, source)
            allowed = request.get("expected_parts")
            if allowed is not None and set(allowed) != set(result["changed_parts"]):
                raise FileToolError("unexpected_document_changes", "The modified Office parts differ from the requested set.")
        return result
    if operation == "create":
        if source:
            with checked_zip(source):
                pass
        if kind == "documents":
            create_document(workspace, request, output, source)
        elif kind == "spreadsheet":
            create_workbook(request, output, source)
        else:
            create_presentation(workspace, request, output, source)
        return {}
    if operation == "edit":
        if source.suffix not in (".docx", ".xlsx", ".pptx"):
            raise FileToolError("conversion_required", "Convert the original to its current Office format, then inspect it.")
        return edit_office(kind, source, output, request.get("operations"), scratch)
    if source.suffix in (".docx", ".xlsx", ".pptx"):
        with checked_zip(source):
            pass
    if operation == "convert":
        office_convert(source, output, scratch)
        return {}
    from pdf_tools import render_page

    rendered = scratch / "preview.pdf"
    office_convert(source, rendered, scratch)
    return render_page(rendered, output, request)
