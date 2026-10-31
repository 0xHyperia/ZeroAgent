/** Only the semantic fields used by docx-preview 0.4 are read here. Its public
 * WordDocument type is an `any` stub, so imported document data stays unknown. */
type ModelRecord = Record<string, unknown>;

export const DOCX_OUTLINE_LIMITS = {
  nodes: 60_000,
  depth: 64,
  headings: 200,
  styles: 2_000,
  styleDepth: 32,
  renderedNodes: 120_000,
  titleCharacters: 240,
} as const;

export type DocxOutlineEntry = { marker: string; level: number };

function record(value: unknown): ModelRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ModelRecord)
    : null;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function outlineLevel(value: unknown): number | null {
  // In Word, 0–8 are heading levels; 9 explicitly means body text.
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 8
    ? value
    : null;
}

function paragraphLevel(paragraph: ModelRecord, styles: Map<string, ModelRecord>) {
  if (paragraph.outlineLevel !== undefined && paragraph.outlineLevel !== null)
    return outlineLevel(paragraph.outlineLevel);
  let styleId = identifier(paragraph.styleName);
  const seen = new Set<string>();
  for (let depth = 0; styleId && depth < DOCX_OUTLINE_LIMITS.styleDepth; depth++) {
    if (seen.has(styleId)) return null;
    seen.add(styleId);
    const style = styles.get(styleId);
    if (!style) return null;
    const properties = record(style.paragraphProps);
    if (properties?.outlineLevel !== undefined && properties.outlineLevel !== null)
      return outlineLevel(properties.outlineLevel);
    styleId = identifier(style.basedOn);
  }
  return null;
}

/** Mark actual paragraph nodes before rendering. Style names, visual font sizes
 * and generated HTML tags never stand in for Word's outline semantics. */
export function prepareDocxOutline(document: unknown): DocxOutlineEntry[] {
  const model = record(document);
  const body = record(record(model?.documentPart)?.body);
  if (!body) throw new Error("此文件不是有效的 DOCX 文档。");
  const styleValues = record(model?.stylesPart)?.styles;
  const styles = new Map<string, ModelRecord>();
  if (Array.isArray(styleValues)) {
    if (styleValues.length > DOCX_OUTLINE_LIMITS.styles)
      throw new Error("文档样式较多，请下载原件查看。");
    for (const value of styleValues) {
      const style = record(value);
      const id = identifier(style?.id);
      if (style?.target === "p" && id) styles.set(id, style);
    }
  }
  const outline: DocxOutlineEntry[] = [];
  const seen = new WeakSet<object>();
  const pending = [{ node: body, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    const { node, depth } = item;
    if (
      ++visited > DOCX_OUTLINE_LIMITS.nodes ||
      depth > DOCX_OUTLINE_LIMITS.depth ||
      seen.has(node)
    )
      throw new Error("文档结构较复杂，请下载原件查看。");
    seen.add(node);
    if (node.type === "paragraph" && outline.length < DOCX_OUTLINE_LIMITS.headings) {
      const level = paragraphLevel(node, styles);
      if (level !== null) {
        const marker = `za-docx-outline-mark-${outline.length + 1}`;
        const previous = typeof node.className === "string" ? node.className.slice(0, 2048) : "";
        node.className = `${previous} ${marker}`.trim();
        outline.push({ marker, level });
      }
    }
    if (Array.isArray(node.children)) {
      if (visited + pending.length + node.children.length > DOCX_OUTLINE_LIMITS.nodes)
        throw new Error("文档内容较多，请下载原件查看。");
      for (let index = node.children.length - 1; index >= 0; index--) {
        const child = record(node.children[index]);
        if (child) pending.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return outline;
}

/** Runs on our detached renderer output, never on an installed iframe. Native
 * links and their destinations live together in the same sandboxed srcdoc. */
export function createDocxOutline(
  root: HTMLElement,
  outline: readonly DocxOutlineEntry[],
): HTMLDetailsElement | null {
  const doc = root.ownerDocument;
  const markers = new Set(outline.map((entry) => entry.marker));
  const paragraphs = new Map<string, HTMLElement>();
  const occupied = new Set<string>();
  const walker = doc.createTreeWalker(root, 0xffffffff);
  let count = 0;
  while (walker.nextNode()) {
    if (++count > DOCX_OUTLINE_LIMITS.renderedNodes)
      throw new Error("文档排版较复杂，请下载原件查看。");
    const node = walker.currentNode;
    if (node.nodeType !== 1) continue;
    const element = node as HTMLElement;
    if (element.id) occupied.add(element.id);
    if (element.localName === "p") {
      for (const marker of element.classList) {
        if (markers.has(marker) && !paragraphs.has(marker)) paragraphs.set(marker, element);
      }
    }
  }
  const list = doc.createElement("ol");
  for (const entry of outline.slice(0, DOCX_OUTLINE_LIMITS.headings)) {
    const paragraph = paragraphs.get(entry.marker);
    const title = paragraph?.textContent
      ?.slice(0, 4096)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, DOCX_OUTLINE_LIMITS.titleCharacters);
    if (!paragraph || !title) continue;
    const stem = `za-docx-section-${list.children.length + 1}`;
    let id = stem;
    for (let suffix = 2; occupied.has(id); suffix++) id = `${stem}-${suffix}`;
    occupied.add(id);
    if (paragraph.id) {
      // Existing bookmarks retain their original destination.
      const anchor = doc.createElement("span");
      anchor.id = id;
      anchor.className = "za-docx-outline-anchor";
      anchor.setAttribute("aria-hidden", "true");
      paragraph.before(anchor);
    } else paragraph.id = id;
    const item = doc.createElement("li");
    item.style.setProperty("--outline-level", String(entry.level));
    const link = doc.createElement("a");
    // A bare #fragment in srcdoc can inherit the embedding application's base URL.
    link.setAttribute("href", `about:srcdoc#${id}`);
    link.textContent = title;
    item.append(link);
    list.append(item);
  }
  if (!list.children.length) return null;
  const details = doc.createElement("details");
  details.className = "za-docx-outline";
  details.open = true;
  const summary = doc.createElement("summary");
  summary.textContent = "文档目录";
  const navigation = doc.createElement("nav");
  navigation.setAttribute("aria-label", "文档目录");
  navigation.append(list);
  details.append(summary, navigation);
  return details;
}
