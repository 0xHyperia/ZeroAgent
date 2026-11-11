"""Native DOCX comments and document-level structure checks."""

from runtime_common import FileToolError, checked_zip


def word_text(node, *names):
    from office import WORD, tag

    return "".join(item.text or "" for item in node.iter(*(tag(WORD, name) for name in names)))


def audit_document(archive, document):
    from office import DRAW, WORD, tag, xml

    headings, warnings = [], []
    for i, paragraph in enumerate(document.iter(tag(WORD, "p"))):
        style = paragraph.find(f"./{tag(WORD, 'pPr')}/{tag(WORD, 'pStyle')}")
        name = style.get(tag(WORD, "val"), "") if style is not None else ""
        if name.startswith("Heading") and name[7:].isdigit():
            level = int(name[7:])
            if not headings and level > 1 or headings and level > headings[-1]["level"] + 1:
                warnings.append({"code": "heading_level_jump", "paragraph": i})
            headings.append({"paragraph": i, "level": level, "text": word_text(paragraph, "t")[:250]})
    for index, table in enumerate(document.iter(tag(WORD, "tbl"))):
        first = table.find(f"./{tag(WORD, 'tr')}")
        if first is not None and first.find(f"./{tag(WORD, 'trPr')}/{tag(WORD, 'tblHeader')}") is None:
            warnings.append({"code": "table_header_missing", "table": index})
    for properties in document.iter("{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}docPr"):
        if not (properties.get("descr") or "").strip():
            warnings.append({"code": "image_alt_missing", "object": properties.get("id")})
    comments = []
    if "word/comments.xml" in archive.namelist():
        thread = xml(archive.read("word/comments.xml"))
        comments = [{"id": item.get(tag(WORD, "id")), "author": item.get(tag(WORD, "author")),
                     "text": word_text(item, "t")[:2000]} for item in thread.iterchildren(tag(WORD, "comment"))]
    return {
        "heading_outline": headings[:100],
        "warnings": warnings[:100],
        "sections": sum(1 for _ in document.iter(tag(WORD, "sectPr"))),
        "tables": sum(1 for _ in document.iter(tag(WORD, "tbl"))),
        "images": sum(1 for _ in document.iter(tag(DRAW, "blip"))),
        "comments": comments[:100],
        "revision_count": sum(1 for _ in document.iter(tag(WORD, "ins"), tag(WORD, "del"))),
    }


def compare_parts(before, after):
    with checked_zip(before) as original, checked_zip(after) as edited:
        left = {entry.filename: entry for entry in original.infolist()}
        right = {entry.filename: entry for entry in edited.infolist()}
        return sorted(name for name in left.keys() | right.keys()
                      if name not in left or name not in right
                      or left[name].file_size != right[name].file_size or left[name].CRC != right[name].CRC
                      or original.read(name) != edited.read(name))


def change_comment(archive, changes, document, operation):
    from lxml import etree
    from office import REL, WORD, tag, xml

    comment_part = "word/comments.xml"
    relationships = "word/_rels/document.xml.rels"
    content_types = "[Content_Types].xml"
    action = operation["op"]
    entries = set(archive.namelist())
    if comment_part not in entries and comment_part not in changes:
        if action != "add_comment":
            raise FileToolError("anchor_conflict", "There are no native comments in this document.")
        changes[comment_part] = etree.Element(tag(WORD, "comments"), nsmap={"w": WORD})
        rel_root = changes.setdefault(relationships, xml(archive.read(relationships)))
        rel_type = REL + "/comments"
        if any(item.get("Type") == rel_type for item in rel_root):
            raise FileToolError("unsupported_comment_part", "The comments use a nonstandard package relationship.")
        ids = {item.get("Id") for item in rel_root}
        index = 1
        while f"rId{index}" in ids:
            index += 1
        etree.SubElement(rel_root, tag(etree.QName(rel_root).namespace, "Relationship"), {
            "Id": f"rId{index}", "Type": rel_type, "Target": "comments.xml",
        })
        content_root = changes.setdefault(content_types, xml(archive.read(content_types)))
        etree.SubElement(content_root, tag(etree.QName(content_root).namespace, "Override"), {
            "PartName": "/" + comment_part,
            "ContentType": "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
        })
    if comment_part not in changes:
        changes[comment_part] = xml(archive.read(comment_part))
    comments = changes[comment_part]
    if action in ("update_comment", "remove_comment"):
        matches = [item for item in comments if item.get(tag(WORD, "id")) == str(operation["id"])]
        if len(matches) != 1:
            raise FileToolError("anchor_conflict", "The requested native comment was not found.")
        if any(path in entries for path in ("word/commentsExtended.xml", "word/commentsIds.xml", "word/commentsExtensible.xml")):
            raise FileToolError("unsupported_comment_thread", "This comment uses extended Word thread metadata.")
        comment = matches[0]
        if action == "update_comment":
            for paragraph in list(comment):
                comment.remove(paragraph)
            add_comment_text(comment, operation["text"])
            return
        for name in ("commentRangeStart", "commentRangeEnd", "commentReference"):
            for node in list(document.iter(tag(WORD, name))):
                if node.get(tag(WORD, "id")) == str(operation["id"]):
                    node.getparent().remove(node)
        comments.remove(comment)
        return
    paragraphs = list(document.iter(tag(WORD, "p")))
    index = operation["paragraph"]
    if type(index) is not int or not 0 <= index < len(paragraphs):
        raise FileToolError("anchor_conflict", "Select an existing paragraph for the comment.")
    paragraph = paragraphs[index]
    selected = operation["quote"]
    matches = [run for run in paragraph.iterchildren(tag(WORD, "r")) if word_text(run, "t") == selected]
    if not selected or len(matches) != 1:
        raise FileToolError("anchor_conflict", "The comment must match exactly one complete run in the selected paragraph.")
    identity = str(max((int(item.get(tag(WORD, "id"))) for item in comments), default=-1) + 1)
    comment = etree.SubElement(comments, tag(WORD, "comment"), {
        tag(WORD, "id"): identity, tag(WORD, "author"): operation.get("author", "ZeroAgent"),
    })
    add_comment_text(comment, operation["text"])
    run = matches[0]
    attributes = {tag(WORD, "id"): identity}
    run.addprevious(etree.Element(tag(WORD, "commentRangeStart"), attributes))
    end = etree.Element(tag(WORD, "commentRangeEnd"), attributes)
    run.addnext(end)
    reference = etree.Element(tag(WORD, "r"))
    etree.SubElement(reference, tag(WORD, "commentReference"), attributes)
    end.addnext(reference)


def add_comment_text(comment, value):
    from lxml import etree
    from office import WORD, tag

    if not isinstance(value, str) or not value.strip() or len(value) > 2000:
        raise FileToolError("invalid_comment", "Supply a comment of 1 to 2000 characters.")
    for line in value.split("\n"):
        paragraph = etree.SubElement(comment, tag(WORD, "p"))
        run = etree.SubElement(paragraph, tag(WORD, "r"))
        text = etree.SubElement(run, tag(WORD, "t"))
        text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        text.text = line
