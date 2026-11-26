---
name: pdf
description: 阅读、生成、填写、批注和检查 PDF，包括 AcroForms、扫描件、页面选区和敏感信息遮盖。核对页面外观、文本层与表单数据。
---

# PDF

## When To Use

- Read or review PDF content where layout and visuals matter.
- Create PDFs programmatically with reliable formatting.
- Fill and validate interactive PDF forms.
- Validate final rendering before delivery.

## File runtime

Use the ZeroAgent file runtime in the current execution workspace. The host provides the absolute paths RUNTIME_NODE, RUNTIME_PYTHON, RUNTIME_NODE_MODULES and ZEROAGENT_FILE_SKILL_ROOT. Package paths in this guide are relative to this skill. Locate executable helpers under the installed skill directory and run them from the writable work area with the configured interpreter.

Use the absolute runtime interpreter in the command examples below.
If a desktop tool task is missing RUNTIME_PYTHON or ZEROAGENT_FILE_TOOL, keep the requested work pending and direct the user to Settings → System Settings → Workspace tools on the executing computer.

On a device, open the source authorized in the current conversation. In CloudChat, materialize the exact attachment or artifact version with load_uploaded_file and use the returned workspace path. Match reader annotations to the source version and the format-specific anchors before editing. Create a working copy and preserve content outside the requested edits. Recheck the source version before any authorized write-back.

Keep drafts, intermediate renders, QA reports and final outputs separate. Deliver the verified device file through its workspace link. In CloudChat use publish_artifact and cite the ready immutable version. Pass the existing artifact family for a revision. Report any source mismatch or failed validation and preserve the original.

## Workflow

1. Prefer visual review: render PDF pages to PNGs and inspect them.
   - Use the bundled `pdftoppm` from the directory in `ZEROAGENT_FILE_POPPLER_BIN`.
2. Use `reportlab` to generate PDFs when creating new documents.
3. Use `pdfplumber` or `pypdf` for text extraction and quick checks; do not rely on text extraction for layout fidelity.
4. After each meaningful update, re-render pages and verify alignment, spacing, and legibility.

## Fill And Validate AcroForms

Visual review alone is not a correctness check for a fillable PDF. A page `/Widget` annotation can render a value from its appearance stream while the canonical `/AcroForm/Fields` tree is missing or contains a stale value.

1. Keep the result interactive by default; set `flatten=True` only when the user explicitly requests a completed, static form. Preserve the source PDF, and do not flatten a signed PDF without an explicit workflow decision.
2. Inspect both representations before filling: enumerate fields from `reader.get_fields()` and `/Widget` annotations from every page's `/Annots`, following `/Parent` and `/Kids`. If a widget and a canonical field have the same name but are distinct objects with no `/Parent` relationship, do not call `reattach_fields()` blindly: it can create a second top-level field with the same name. Report the ambiguity or produce a static result.
3. Recover genuinely orphaned widgets, fill all pages, and write the result with `pypdf`:

```python
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject

reader = PdfReader(input_pdf)
writer = PdfWriter()
writer.clone_document_from_reader(reader)

# Restores widgets that are missing from /AcroForm/Fields.
writer.reattach_fields()
fields = writer.get_fields() or {}
missing = set(expected_values) - set(fields)
if missing:
    raise ValueError(f"Form fields not found after repair: {sorted(missing)}")

values_to_write = dict(expected_values)
if flatten:
    # Paint every existing value before removing every widget.
    values_to_write = {
        name: field.get("/V", "/Off" if field.get("/FT") == "/Btn" else "")
        for name, field in fields.items()
    }
    values_to_write.update(expected_values)

writer.update_page_form_field_values(
    None, values_to_write, auto_regenerate=False, flatten=flatten
)

if flatten:
    # pypdf's flatten=True paints appearances but does not remove widgets.
    writer.remove_annotations(subtypes="/Widget")
    writer.root_object.pop(NameObject("/AcroForm"), None)

with open(output_pdf, "wb") as stream:
    writer.write(stream)
```

4. Reopen the written PDF before delivery. For an interactive result, require every expected field to be present in `get_fields()` with the expected `/V`, enumerate page widgets again, and confirm their effective `/V` (the widget value or inherited `/Parent` value) agrees. Confirm each updated widget has a non-empty `/AP` `/N` appearance and render the final pages to catch stale or clipped appearances. Do not rely on `/NeedAppearances` or a successful PNG render as proof that logical field data was updated.
5. For a flattened result, require zero `/Widget` annotations and no remaining `/AcroForm` field tree after reopening, then render the final pages. Keep an editable copy when the user may need to revise the form.

## Temp And Output Conventions

- Use `tmp/pdfs/` for intermediate files; delete them when done.
- Write final artifacts under `output/pdf/` inside the authorized workspace.
- Keep filenames stable and descriptive.

## Dependencies

Use the bundled Python packages reportlab, pdfplumber and pypdf. The runtime supplies Poppler for rendering and page metadata. Use Tesseract for a searchable text layer and verify the extracted text against the scanned page. In the shell, resolve pdftoppm and pdfinfo from ZEROAGENT_FILE_POPPLER_BIN.

## Rendering Command

```bash
"$ZEROAGENT_FILE_POPPLER_BIN/pdftoppm" -png "$INPUT_PDF" "$OUTPUT_PREFIX"
```

In PowerShell, use `& (Join-Path $env:ZEROAGENT_FILE_POPPLER_BIN 'pdftoppm.exe') -png $inputPdf $outputPrefix`.

## Quality Expectations

- Maintain polished visual design: consistent typography, spacing, margins, and section hierarchy.
- Avoid rendering issues: clipped text, overlapping elements, broken tables, black squares, or unreadable glyphs.
- Charts, tables, and images must be sharp, aligned, and clearly labeled.
- Use ASCII hyphens only. Avoid U+2011 and other Unicode dashes.
- Citations and references must be human-readable; never leave tool tokens or placeholder strings.

## Final Checks

- Do not deliver until the latest PNG inspection shows zero visual or formatting defects.
- Confirm headers, footers, page numbering, and section transitions look polished.
- Keep intermediate files organized or remove them after final approval.

## Final response

Deliver only the verified files the user requested. Link the resulting file or ready artifact version in the current conversation. For read-only work, answer directly and identify the file, page, worksheet and range, or slide supporting each important finding. Mention limitations that affect how the result can be used. Keep drafts and validation output private unless requested.
