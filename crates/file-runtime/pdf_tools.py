import math

from runtime_common import FileToolError, engine_path, run_engine


def read_pdf(source):
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(source)
    except PdfReadError as error:
        raise FileToolError("invalid_pdf", "The selected PDF could not be opened.") from error
    if reader.is_encrypted:
        raise FileToolError("encrypted_file", "Open an authorized decrypted copy before processing this PDF.")
    if not 0 < len(reader.pages) <= 1000:
        raise FileToolError("page_limit", "The PDF must contain between 1 and 1000 pages.")
    return reader


def page_number(value, count):
    if type(value) is not int or not 1 <= value <= count:
        raise FileToolError("anchor_conflict", "Select an existing PDF page.")
    return value - 1


def bitmap(document, index, scale):
    page = document[index]
    try:
        width, height = page.get_size()
        if not isinstance(scale, (int, float)) or not 0.25 <= scale <= 4:
            raise FileToolError("invalid_scale", "Choose a render scale between 0.25 and 4.")
        if width <= 0 or height <= 0 or width * height * scale * scale > 24_000_000:
            raise FileToolError("page_too_large", "This page exceeds the raster pixel budget.")
        image = page.render(scale=scale, draw_annots=True)
        try:
            return image.to_pil().convert("RGB")
        finally:
            image.close()
    finally:
        page.close()


def render_page(source, output, request):
    from pypdfium2 import PdfDocument

    read_pdf(source)
    with PdfDocument(source) as document:
        document.init_forms()
        index = page_number(request.get("page", 1), len(document))
        bitmap(document, index, request.get("scale", 1.5)).save(output)
        return {"page": index + 1}


def create_pdf(output, request):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen.canvas import Canvas

    pages = request.get("pages", [])
    if not isinstance(pages, list) or not 0 < len(pages) <= 1000:
        raise FileToolError("invalid_pages", "Supply between 1 and 1000 pages.")
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    canvas = Canvas(str(output), pagesize=(595.28, 841.89))
    for page in pages:
        canvas.setFont("STSong-Light", 12)
        for i, line in enumerate(page.get("lines", [])):
            if i >= 43 or pdfmetrics.stringWidth(line, "STSong-Light", 12) > 500:
                raise FileToolError("text_overflow", "Split the text into shorter lines or add another page.")
            canvas.drawString(48, 790 - 17 * i, line)
        for field in page.get("fields", []):
            canvas.acroForm.textfield(name=field["name"], value=field.get("value", ""),
                                      x=field["x"], y=field["y"], width=field["width"], height=field["height"])
        canvas.showPage()
    canvas.save()


def get_region(operation, width, height):
    region = operation["region"]
    x, y, w, h = (region[key] for key in ("left", "top", "width", "height"))
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (x, y, w, h)):
        raise FileToolError("invalid_region", "Select a valid page region.")
    if not (0 <= x < x + w <= 1 and 0 <= y < y + h <= 1):
        raise FileToolError("invalid_region", "The normalized selection must fit on one page.")
    return (math.floor(x * width), math.floor(y * height),
            math.ceil((x + w) * width) - 1, math.ceil((y + h) * height) - 1)


def flattened_pdf(source, output, operations, scratch):
    from PIL import ImageDraw, ImageFont
    from pypdf import PdfWriter
    from pypdfium2 import PdfDocument
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen.canvas import Canvas

    reader = read_pdf(source)
    if len(reader.pages) > 60:
        raise FileToolError("page_limit", "Raster redaction or OCR accepts up to 60 pages per operation.")
    if reader.get_fields():
        raise FileToolError("form_would_be_flattened", "Use a separate form-free copy for raster redaction or OCR.")
    ocr = operations[0]["op"] == "ocr"
    if ocr and len(operations) != 1:
        raise FileToolError("invalid_operations", "Run OCR as a separate operation.")
    targets = {}
    if not ocr:
        for operation in operations:
            if operation["op"] not in ("redact", "replace_region"):
                raise FileToolError("invalid_operations", "Run redaction and raster replacement separately from other PDF edits.")
            index = page_number(operation["page"], len(reader.pages))
            targets.setdefault(index, []).append(operation)
    with PdfDocument(source) as document:
        canvas = None if ocr else Canvas(str(output))
        writer = PdfWriter() if ocr else None
        for index in range(len(document)):
            image = bitmap(document, index, 3)
            if ocr:
                image_path = scratch / "ocr-input.png"
                stem = scratch / f"ocr-{index + 1}"
                image.save(image_path)
                run_engine([engine_path("ZEROAGENT_FILE_TESSERACT"), str(image_path), str(stem),
                            "-l", "chi_sim+chi_tra+eng", "--dpi", "216", "pdf"], scratch)
                writer.append(str(stem.with_suffix(".pdf")))
                continue
            draw = ImageDraw.Draw(image)
            for operation in targets.get(index, []):
                box = get_region(operation, image.width, image.height)
                fill = "black" if operation["op"] == "redact" else "white"
                draw.rectangle(box, fill=fill)
                if operation["op"] == "replace_region":
                    text = operation["text"]
                    font = ImageFont.truetype(engine_path("ZEROAGENT_FILE_CJK_FONT"), operation.get("font_size", 32))
                    bounds = draw.textbbox((0, 0), text, font=font)
                    if bounds[2] - bounds[0] > box[2] - box[0] or bounds[3] - bounds[1] > box[3] - box[1]:
                        raise FileToolError("text_overflow", "The replacement does not fit in the selected PDF region.")
                    draw.text((box[0] - bounds[0], box[1] - bounds[1]), text, fill="black", font=font)
            canvas.setPageSize((image.width / 3, image.height / 3))
            canvas.drawImage(ImageReader(image), 0, 0, image.width / 3, image.height / 3)
            canvas.showPage()
        if ocr:
            writer.write(output)
            writer.close()
        else:
            canvas.save()
            verified = read_pdf(output)
            if (verified.attachments or verified.get_fields()
                    or any(page.extract_text().strip() or page.get("/Annots") for page in verified.pages)):
                raise FileToolError("unverified_redaction", "The regenerated PDF retains source objects.")
    return {"applied_operations": len(operations), "flattened": True,
            "modified_pages": list(range(1, len(reader.pages) + 1)) if ocr else [i + 1 for i in sorted(targets)]}


def edit_pdf(workspace, source, output, request, scratch):
    from pypdf import PdfWriter
    from pypdf.annotations import FreeText

    reader = read_pdf(source)
    if any(field.get("/FT") == "/Sig" for field in (reader.get_fields() or {}).values()):
        raise FileToolError("signed_file", "Editing would invalidate the PDF signature.")
    operations = request.get("operations", [])
    if not isinstance(operations, list) or not 0 < len(operations) <= 100:
        raise FileToolError("invalid_operations", "Supply between 1 and 100 changes.")
    if any(item["op"] in ("ocr", "redact", "replace_region") for item in operations):
        if request.get("allow_flatten") is not True:
            raise FileToolError("flatten_confirmation_required", "This operation rebuilds the PDF as rendered pages.")
        return flattened_pdf(source, output, operations, scratch)
    writer = PdfWriter(clone_from=reader)
    filled = {}
    replaced = []
    for operation in operations:
        action = operation["op"]
        if action == "rotate":
            angle = operation["degrees"]
            if type(angle) is not int or angle % 90:
                raise FileToolError("invalid_rotation", "Rotate pages in multiples of 90 degrees.")
            writer.pages[page_number(operation["page"], len(writer.pages))].rotate(angle)
        elif action == "fill":
            fields = operation["fields"]
            if not fields or any(name not in (reader.get_fields() or {}) for name in fields):
                raise FileToolError("anchor_conflict", "A named PDF form field was not found.")
            writer.update_page_form_field_values(None, fields, auto_regenerate=False)
            filled.update(fields)
        elif action == "pages":
            if reader.get_fields():
                raise FileToolError("unsupported_operation", "Page assembly would require rebuilding the form tree.")
            order = [page_number(value, len(writer.pages)) for value in operation["order"]]
            if not order:
                raise FileToolError("page_limit", "Keep at least one page.")
            replacement = PdfWriter()
            for index in order:
                replacement.add_page(writer.pages[index])
            writer.close()
            writer = replacement
        elif action == "append":
            addition = workspace.source(operation["source"])
            other = read_pdf(addition)
            if reader.get_fields() or other.get_fields():
                raise FileToolError("unsupported_operation", "Merge form-free copies to avoid changing form fields.")
            writer.append(other)
        elif action == "comment":
            index = page_number(operation["page"], len(writer.pages))
            page = writer.pages[index]
            if page.rotation:
                raise FileToolError("unsupported_operation", "Comment placement on rotated PDF pages requires an unrotated copy.")
            bounds = page.cropbox
            width, height = float(bounds.width), float(bounds.height)
            left, top, right, bottom = get_region(operation, width, height)
            rect = (float(bounds.left) + left, float(bounds.top) - bottom,
                    float(bounds.left) + right + 1, float(bounds.top) - top)
            writer.add_annotation(index, FreeText(text=operation["text"], rect=rect))
        elif action == "replace_text":
            index = page_number(operation["page"], len(writer.pages))
            replace_pdf_text(writer.pages[index], operation["before"], operation["after"])
            replaced.append((index, operation["before"], operation["after"]))
        else:
            raise FileToolError("unsupported_operation", f"Unknown PDF operation: {action}")
    writer.write(output)
    writer.close()
    if filled or replaced:
        verified = read_pdf(output)
        checked = verified.get_fields() or {}
        if any(str(checked.get(name, {}).get("/V")) != str(value) for name, value in filled.items()):
            raise FileToolError("unverified_form", "The saved PDF form does not match the requested values.")
        for index, before, after in replaced:
            text = verified.pages[index].extract_text()
            if before in text or (after and after not in text):
                raise FileToolError("unverified_text", "The saved PDF does not match the requested text replacement.")
    return {"applied_operations": len(operations)}


def replace_pdf_text(page, before, after):
    from pypdf.generic import ByteStringObject

    if not isinstance(before, str) or not before or not isinstance(after, str) or not before.isascii() or not after.isascii():
        raise FileToolError("unsupported_font", "Direct PDF text edits require a simple ASCII text object.")
    if before in after or page.extract_text().count(before) != 1:
        raise FileToolError("anchor_conflict", "The original text must occur exactly once on the selected page.")
    contents = page.get_contents()
    fonts = page["/Resources"].get("/Font")
    if not fonts or contents is None:
        raise FileToolError("anchor_conflict", "The page contains no editable text object.")
    fonts = fonts.get_object()
    selected_font = None
    matches = []
    for operands, operator in contents.operations:
        if operator == b"Tf":
            selected_font = fonts[operands[0]].get_object()
        elif operator in (b"q", b"Q"):
            # Font state can be restored from the graphics stack. Require an explicit next Tf.
            selected_font = None
        elif (operator == b"Tj" and len(operands) == 1 and selected_font is not None
                and selected_font.get("/Subtype") == "/Type1"
                and selected_font.get("/Encoding") == "/WinAnsiEncoding"
                and str(operands[0]) == before):
            matches.append(operands)
    if len(matches) != 1:
        raise FileToolError("anchor_conflict", "The selected text is split, encoded by an unsupported font, or inside an embedded object.")
    matches[0][0] = ByteStringObject(after.encode("ascii"))
    page.replace_contents(contents)


def pdf_operation(workspace, kind, operation, source, output, request, scratch):
    if operation == "render":
        return render_page(source, output, request)
    if operation == "create":
        if source:
            raise FileToolError("invalid_request", "Use edit for an existing PDF.")
        create_pdf(output, request)
        return {}
    if operation == "edit":
        return edit_pdf(workspace, source, output, request, scratch)
    if operation == "convert":
        reader = read_pdf(source)
        with output.open("w", encoding="utf-8", newline="\n") as stream:
            for index, page in enumerate(reader.pages):
                if index:
                    stream.write("\n\f\n")
                stream.write(page.extract_text())
        return {"page_count": len(reader.pages)}
    reader = read_pdf(source)
    result = {"format": "pdf", "page_count": len(reader.pages),
              "fields": {key: str(value.get("/V", "")) for key, value in (reader.get_fields() or {}).items()}}
    if operation == "inspect":
        start = page_number(request.get("page", 1), len(reader.pages))
        query = request.get("query")
        count = min(10, len(reader.pages) - start)
        result["pages"] = []
        for index in range(start, start + count):
            page = reader.pages[index]
            text = page.extract_text()
            result["pages"].append({"page": index + 1, "text": text[:8000],
                                    **({"matches": text.casefold().count(query.casefold())} if query else {})})
    return result
