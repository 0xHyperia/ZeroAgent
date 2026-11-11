"""Synthetic round trips through the shipped command-line entry point."""

import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile

from docx import Document
from openpyxl import load_workbook
from pptx import Presentation
from pypdf import PdfReader


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def call(self, kind, action, success=True, **request):
        tool = Path(__file__).with_name("file_tool.py")
        result = subprocess.run([sys.executable, "-IB", str(tool), kind, action,
                                 "--workspace", str(self.root)], input=json.dumps(request),
                                text=True, encoding="utf-8", capture_output=True, timeout=30)
        self.assertEqual(result.stderr, "")
        body = json.loads(result.stdout)
        self.assertEqual(body["ok"], success, body)
        self.assertEqual(result.returncode, 0 if success else 1, body)
        return body

    def edit(self, kind, source, output, operations, **request):
        version = self.call(kind, "inspect", source=source)["source_version"]
        return self.call(kind, "edit", source=source, source_version=version, output=output,
                         operations=operations, **request)

    def run_skill_script(self, executable, script, *args):
        interpreter_flags = ["-B"] if Path(executable) == Path(sys.executable) else []
        result = subprocess.run(
            [str(executable), *interpreter_flags, str(script), *map(str, args)],
            cwd=self.root, encoding="utf-8", capture_output=True, timeout=90,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    @unittest.skipUnless(os.environ.get("ZEROAGENT_FILE_SKILL_ROOT"), "requires the installed file skills")
    def test_native_document_audit_and_page_render(self):
        skill = Path(os.environ["ZEROAGENT_FILE_SKILL_ROOT"]) / "documents"
        source = self.root / "draft.docx"
        doc = Document()
        doc.add_heading("Page heading", level=1)
        doc.add_paragraph("Review the exported page.")
        doc.save(source)
        audit = self.run_skill_script(sys.executable, skill / "scripts" / "heading_audit.py", source)
        self.assertIn("Heading 1: 1", audit)
        pages = self.root / "pages"
        self.run_skill_script(sys.executable, skill / "render_docx.py", source, "--output_dir", pages, "--emit_pdf")
        self.assertTrue((pages / "page-1.png").is_file())
        self.assertIn("Page heading", PdfReader(pages / "draft.pdf").pages[0].extract_text())

    @unittest.skipUnless(os.environ.get("ZEROAGENT_FILE_SKILL_ROOT"), "requires the installed file skills")
    def test_native_pdf_extraction_and_poppler_render(self):
        import pdfplumber

        source = self.root / "approved.pdf"
        self.call("pdf", "create", output=source.name, pages=[{"lines": ["Review approved"]}])
        with pdfplumber.open(source) as document:
            self.assertIn("Review approved", document.pages[0].extract_text())
        suffix = ".exe" if os.name == "nt" else ""
        poppler = Path(os.environ["ZEROAGENT_FILE_POPPLER_BIN"]) / f"pdftoppm{suffix}"
        self.run_skill_script(poppler, "-png", "-singlefile", source, self.root / "approved")
        self.assertTrue((self.root / "approved.png").is_file())

    @unittest.skipUnless(os.environ.get("ZEROAGENT_FILE_SKILL_ROOT") and os.environ.get("RUNTIME_NODE"),
                         "requires the installed file skills and Node")
    def test_native_presentation_render_uses_bundled_artifact_tool(self):
        skill = Path(os.environ["ZEROAGENT_FILE_SKILL_ROOT"]) / "presentations"
        self.call("presentations", "create", output="template.pptx", slides=[
            {"objects": [{"type": "text", "text": "Editable object", "box": [1, 1, 4, 1]}]},
        ])
        output = self.root / "slides"
        self.run_skill_script(sys.executable, skill / "container_tools" / "render_slides.py",
                              self.root / "template.pptx", "--output_dir", output)
        self.assertTrue((output / "slide-1.png").is_file())
        self.assertEqual(Presentation(self.root / "template.pptx").slides[0].shapes[0].text, "Editable object")
        self.run_skill_script(os.environ["RUNTIME_NODE"], skill / "template_following_scripts" / "inspect_template_deck.mjs",
                              "--workspace", self.root, "--pptx", self.root / "template.pptx")
        self.assertTrue((self.root / "template-inspect" / "template-manifest.json").is_file())

    @unittest.skipUnless(os.environ.get("RUNTIME_NODE"), "requires the installed Node runtime")
    def test_native_workbook_api_exports_pivot_and_sensitivity_tables(self):
        loader = Path(__file__).with_name("artifact_tool.mjs").as_uri()
        script = self.root / "sensitivity.mjs"
        script.write_text(
            f'import {{ loadArtifactTool }} from {json.dumps(loader)};\n'
            'const { SpreadsheetFile, Workbook } = await loadArtifactTool();\n'
            'const workbook = Workbook.create();\n'
            'const sheet = workbook.worksheets.add("Sensitivity");\n'
            'sheet.getRange("B2:B3").values = [[2], [3]];\n'
            'sheet.getRange("B5").formulas = [["=B2*B3"]];\n'
            'sheet.getRange("E4").formulas = [["=B5"]];\n'
            'sheet.getRange("F4:G4").values = [[2, 4]];\n'
            'sheet.getRange("E5:E6").values = [[3], [5]];\n'
            'sheet.dataTables.add("E4:G6", {rowInput: "B2", columnInput: "B3"});\n'
            'workbook.recalculate();\n'
            'const data = workbook.worksheets.add("Data");\n'
            'data.getRange("A1:C5").values = [["Region","Product","Sales"], ["East","A",10],\n'
            '  ["East","B",20], ["West","A",30], ["West","B",40]];\n'
            'const summary = workbook.worksheets.add("Summary");\n'
            'const pivot = summary.pivotTables.add("SalesSummary", data.getRange("A1:C5"), summary.getRange("A1"));\n'
            'pivot.rowHierarchies.add(pivot.hierarchies.getItem("Region"));\n'
            'pivot.columnHierarchies.add(pivot.hierarchies.getItem("Product"));\n'
            'pivot.dataHierarchies.add(pivot.hierarchies.getItem("Sales")).summarizeBy = "Sum";\n'
            'const file = await SpreadsheetFile.exportXlsx(workbook);\n'
            'await file.save("sensitivity.xlsx");\n',
            encoding="utf-8",
        )
        self.run_skill_script(os.environ["RUNTIME_NODE"], script)
        from openpyxl.worksheet.formula import DataTableFormula

        workbook = self.root / "sensitivity.xlsx"
        formula = load_workbook(workbook).active["F5"].value
        self.assertIsInstance(formula, DataTableFormula)
        self.assertEqual((formula.r1, formula.r2), ("B2", "B3"))
        reopened = load_workbook(workbook, data_only=True)
        self.assertEqual(reopened.active["G6"].value, 20)
        self.assertEqual([pivot.name for pivot in reopened["Summary"]._pivots], ["SalesSummary"])
        self.assertEqual(reopened["Summary"]["D5"].value, 100)

    def test_documents_preserve_untouched_parts_and_reject_stale_edits(self):
        self.call("documents", "create", output="original.docx", blocks=[
            {"type": "heading", "text": "业务报告"},
            {"type": "table", "rows": [["名称", "旧文本"]]},
        ])
        self.edit("documents", "original.docx", "result.docx", [
            {"op": "replace_text", "paragraph": 2, "before": "旧文本", "after": "新文本"}])
        with ZipFile(self.root / "original.docx") as before, ZipFile(self.root / "result.docx") as after:
            changed = [name for name in before.namelist() if before.read(name) != after.read(name)]
            self.assertEqual(changed, ["word/document.xml"])
        self.assertEqual(Document(self.root / "result.docx").tables[0].cell(0, 1).text, "新文本")
        result = self.call("documents", "edit", False, source="original.docx", source_version="0" * 64,
                           output="conflict.docx", operations=[])
        self.assertEqual(result["code"], "source_changed")
        self.assertFalse((self.root / "conflict.docx").exists())

    def test_accept_and_reject_existing_document_revisions(self):
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn

        doc = Document()
        p = doc.add_paragraph()
        for name, value in [("del", "old"), ("ins", "new")]:
            edit = OxmlElement(f"w:{name}")
            edit.set(qn("w:id"), "1" if name == "del" else "2")
            run = OxmlElement("w:r")
            text = OxmlElement("w:delText" if name == "del" else "w:t")
            text.text = value
            run.append(text)
            edit.append(run)
            p._p.append(edit)
        doc.save(self.root / "tracked.docx")
        for action, expected in [("accept_revision", "new"), ("reject_revision", "old")]:
            output = action + ".docx"
            self.edit("documents", "tracked.docx", output, [{"op": action}])
            self.assertEqual(Document(self.root / output).paragraphs[0].text, expected)

    def test_native_comments_and_tracked_replacement_round_trip(self):
        self.call("documents", "create", output="source.docx", blocks=[
            {"type": "paragraph", "text": "下周提交"},
            {"type": "paragraph", "text": "审批负责人"},
        ])
        self.edit("documents", "source.docx", "reviewed.docx", [
            {"op": "track_replace_text", "paragraph": 0, "before": "下周提交", "after": "周四提交"},
            {"op": "add_comment", "paragraph": 1, "quote": "审批负责人", "text": "请确认负责人。"},
        ])
        checked = self.call("documents", "verify", source="reviewed.docx", baseline="source.docx",
                            audit=True, expected_parts=["word/document.xml", "word/comments.xml",
                                                       "word/_rels/document.xml.rels", "[Content_Types].xml"])
        self.assertEqual(checked["audit"]["comments"][0]["text"], "请确认负责人。")
        self.assertEqual(checked["audit"]["revision_count"], 2)
        self.edit("documents", "reviewed.docx", "clean.docx", [
            {"op": "accept_revision"}, {"op": "remove_comment", "id": "0"}])
        self.assertEqual(Document(self.root / "clean.docx").paragraphs[0].text, "周四提交")
        self.assertEqual(self.call("documents", "verify", source="clean.docx", audit=True)["audit"]["comments"], [])

    def test_document_authoring_sets_section_link_and_accessible_table_header(self):
        self.call("documents", "create", output="source.docx", blocks=[
            {"type": "heading", "text": "发布计划"},
            {"type": "link", "url": "https://example.com/docs", "text": "发布手册"},
            {"type": "section", "landscape": True, "margins": {"left": 0.75}},
            {"type": "table", "header": True, "rows": [["交付物"], ["文件"]]},
        ])
        result = self.call("documents", "verify", source="source.docx", audit=True)
        self.assertEqual(result["audit"]["warnings"], [])
        self.assertEqual(result["audit"]["sections"], 2)
        doc = Document(self.root / "source.docx")
        self.assertGreater(doc.sections[-1].page_width, doc.sections[-1].page_height)
        self.assertEqual(doc.sections[-1].left_margin.inches, 0.75)
        self.assertTrue(any(rel.target_ref == "https://example.com/docs" for rel in doc.part.rels.values()))

    @unittest.skipUnless(os.environ.get("ZEROAGENT_FILE_SOFFICE"), "requires a configured LibreOffice engine")
    def test_office_pdf_conversion_and_formula_recalculation(self):
        self.call("documents", "create", output="source.docx", blocks=[{"type": "heading", "text": "ZeroAgent 文档"}])
        self.call("documents", "convert", source="source.docx", output="source.pdf")
        self.call("pdf", "render", source="source.pdf", output="preview.png")
        self.call("spreadsheet", "create", output="calc.xlsx",
                  sheets=[{"name": "Sheet", "cells": {"A1": 6, "A2": 7, "A3": "=SUM(A1:A2)"}}])
        self.edit("spreadsheet", "calc.xlsx", "calc-result.xlsx",
                  [{"op": "set_cell", "sheet": "Sheet", "cell": "A1", "value": 9}])
        self.assertEqual(load_workbook(self.root / "calc-result.xlsx", data_only=True).active["A3"].value, 16)

    @unittest.skipUnless(os.environ.get("ZEROAGENT_FILE_TESSERACT"), "requires configured OCR engine and data")
    def test_ocr_adds_searchable_text_to_scanned_pages(self):
        self.call("pdf", "create", output="source.pdf", pages=[{"lines": ["Searchable archive"]}])
        self.edit("pdf", "source.pdf", "scanned.pdf",
                  [{"op": "redact", "page": 1, "region": {"left": 0.7, "top": 0.7, "width": 0.1, "height": 0.1}}],
                  allow_flatten=True)
        self.assertFalse(PdfReader(self.root / "scanned.pdf").pages[0].extract_text())
        self.edit("pdf", "scanned.pdf", "searchable.pdf", [{"op": "ocr"}], allow_flatten=True)
        self.assertIn("Searchable archive", PdfReader(self.root / "searchable.pdf").pages[0].extract_text())

    def test_spreadsheet_edits_keep_chart_and_style(self):
        self.call("spreadsheet", "create", output="source.xlsx", sheets=[
            {"name": "统计", "rows": [["合计"], [14], [20]], "number_formats": {"A2": "0.00"},
             "charts": [{"type": "bar", "range": "A2:A3", "anchor": "C2"}]},
        ])
        self.edit("spreadsheet", "source.xlsx", "result.xlsx", [
            {"op": "set_cell", "sheet": "统计", "cell": "A2", "value": 7},
            {"op": "set_cell", "sheet": "统计", "cell": "B6", "value": " 签收 "}])
        sheet = load_workbook(self.root / "result.xlsx")["统计"]
        self.assertEqual(sheet["A2"].value, 7)
        self.assertEqual(sheet["A2"].number_format, "0.00")
        self.assertEqual(sheet["B6"].value, " 签收 ")
        self.assertEqual(len(sheet._charts), 1)

    def test_slide_edits_keep_notes_layout_and_objects(self):
        self.call("presentations", "create", output="deck.pptx", slides=[{"notes": "演讲者备注",
                  "objects": [{"type": "text", "text": "旧标题", "box": [1, 1, 6, 1]}]}])
        detail = self.call("presentations", "inspect", source="deck.pptx")
        shape = next(item for item in detail["slides"][0]["shapes"] if item["text"] == "旧标题")
        self.edit("presentations", "deck.pptx", "result.pptx", [
            {"op": "replace_text", "slide": 1, "shape_id": shape["id"], "before": "旧标题", "after": "新标题"}])
        presentation = Presentation(self.root / "result.pptx")
        self.assertEqual(presentation.slides[0].shapes[0].text, "新标题")
        self.assertEqual(presentation.slides[0].notes_slide.notes_text_frame.text, "演讲者备注")
        with ZipFile(self.root / "deck.pptx") as before, ZipFile(self.root / "result.pptx") as after:
            self.assertEqual([name for name in before.namelist() if before.read(name) != after.read(name)],
                             ["ppt/slides/slide1.xml"])

    @unittest.skipUnless(os.environ.get("ZEROAGENT_FILE_ARTIFACT_ENTRY"), "requires the original Artifact Tool runtime")
    def test_artifact_tool_creates_and_renders_both_editable_formats(self):
        sheet = self.call("spreadsheet", "create", output="sheet.xlsx",
                          sheets=[{"name": "Data", "cells": {"A1": 7, "A2": "=A1*3"}}])
        self.assertEqual(sheet["engine"], "@oai/artifact-tool")
        self.assertEqual(load_workbook(self.root / "sheet.xlsx", data_only=True).active["A2"].value, 21)
        preview = self.call("spreadsheet", "render", source="sheet.xlsx", output="sheet.png",
                            sheet="Data", range="A1:A2")
        self.assertEqual(preview["engine"], "@oai/artifact-tool")
        self.assertGreater(preview["verification"]["width"], 0)
        deck = self.call("presentations", "create", output="deck.pptx",
                         slides=[{"objects": [{"type": "text", "text": "Review", "box": [1, 1, 4, 1]}]}])
        self.assertEqual(deck["engine"], "@oai/artifact-tool")
        self.assertEqual(Presentation(self.root / "deck.pptx").slides[0].shapes[0].text, "Review")
        preview = self.call("presentations", "render", source="deck.pptx", output="deck.png", page=1)
        self.assertEqual(preview["engine"], "@oai/artifact-tool")
        self.assertGreater(preview["verification"]["width"], 0)

    def test_pdf_forms_render_and_irreversible_raster_redaction(self):
        self.call("pdf", "create", output="form.pdf", pages=[{
            "lines": ["Approval"], "fields": [{"name": "approver", "x": 60, "y": 500, "width": 120, "height": 25}]}])
        self.edit("pdf", "form.pdf", "filled.pdf", [{"op": "fill", "fields": {"approver": "ZeroAgent"}}])
        self.assertEqual(PdfReader(self.root / "filled.pdf").get_fields()["approver"]["/V"], "ZeroAgent")
        self.call("pdf", "render", source="filled.pdf", output="form.png")
        self.call("pdf", "create", output="secret.pdf", pages=[{"lines": ["Sensitive original text"]}])
        result = self.edit("pdf", "secret.pdf", "redacted.pdf", [
            {"op": "redact", "page": 1, "region": {"left": 0.05, "top": 0.02, "width": 0.7, "height": 0.08}}],
            allow_flatten=True)
        self.assertTrue(result["flattened"])
        pdf = PdfReader(self.root / "redacted.pdf")
        self.assertEqual(pdf.pages[0].extract_text(), "")
        self.assertFalse(pdf.attachments)
        self.assertNotIn(b"Sensitive original text", (self.root / "redacted.pdf").read_bytes())

    def test_workspace_relative_and_existing_outputs(self):
        result = self.call("pdf", "inspect", False, source="../outside.pdf")
        self.assertEqual(result["code"], "invalid_reference")
        self.call("pdf", "create", output="result.pdf", pages=[{"lines": ["original"]}])
        result = self.call("pdf", "create", False, output="result.pdf", pages=[{"lines": ["overwrite"]}])
        self.assertEqual(result["code"], "output_exists")
        self.assertEqual(PdfReader(self.root / "result.pdf").pages[0].extract_text().strip(), "original")


if __name__ == "__main__":
    unittest.main()
