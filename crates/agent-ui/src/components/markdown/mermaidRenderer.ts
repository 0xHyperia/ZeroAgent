import type { MermaidConfig } from "mermaid";
import { parseMermaidViewBox } from "../../lib/mermaidViewBox";
import { loadMermaid, loadMermaidElk } from "./loadMermaid";
import { applyMermaidAuthorStyles, readMermaidAuthorStyle } from "./mermaidAuthorStyles";
import { createFlowchartLayout, flowchartLayoutName } from "./mermaidFlowchartLayout";

const CACHE_SIZE = 50;
const MAX_SOURCE_LENGTH = 50_000;
const FLOWCHART = /^(?:graph|flowchart)\b/i;
const GRAPH_LAYOUT = /^(?:graph|flowchart|classDiagram|stateDiagram(?:-v2)?|erDiagram)\b/i;
const FRONT_MATTER = /^\uFEFF?---[\t ]*\r?\n((?:[^\n]*\n)*?)---[\t ]*(?:\r?\n|$)/;
const SVG_NS = "http://www.w3.org/2000/svg";
const cache = new Map<string, Promise<string>>();
let queue = Promise.resolve();
let elkRegistered = false;
let flowchartLayoutRegistered = false;
let renderSequence = 0;

function prepareSource(source: string) {
  if (source.length > MAX_SOURCE_LENGTH) throw new Error("Diagram source is too large");
  // Host settings come from the renderer. Read only the supported author paint options.
  const input = source.trimStart();
  const header = FRONT_MATTER.exec(input);
  const title = header?.[1]
    .match(/^title:[\t ]+([^\r\n]{1,250})/m)?.[1]
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
  let sequenceNumberColor: string | undefined;
  const css: string[] = [];
  const chart = input
    .slice(header?.[0].length ?? 0)
    .replace(/%%\{[\s\S]*?\}%%/g, (directive) => {
      const paint = readMermaidAuthorStyle(directive);
      if (paint?.sequenceNumberColor) sequenceNumberColor = paint.sequenceNumberColor;
      if (paint?.css) css.push(paint.css);
      return "";
    })
    .replace(/^[\t ]*click\b[^\r\n]*/gim, "")
    .trim();
  // Mermaid flowchart image nodes can fetch during layout, before its SVG
  // sanitizer runs. Diagram previews have no network-resource permission.
  if (/@\{[^}]*\bimg\s*:/i.test(chart)) throw new Error("External diagram images are unsupported");
  return { chart, title, sequenceNumberColor, css };
}

function flowchartCss(colors: Record<string, unknown>) {
  return `
    .node text, .edgeLabel text {
      fill: ${colors.flowchartTextColor};
      font-weight: 600;
    }
    .node text { font-size: 14px; }
    .edgeLabel text { font-size: 13px; letter-spacing: -0.08px; }
    .node tspan[font-weight="normal"], .edgeLabel tspan[font-weight="normal"] { font-weight: 600; }
    .node .label-container {
      fill: ${colors.flowchartNodeColor};
      stroke: ${colors.flowchartNodeBorderColor};
      stroke-width: 1px;
    }
    .node rect.label-container { rx: 16px; ry: 16px; }
    .mermaid-decision .label-container, .node[data-shape="diamond"] .label-container {
      fill: ${colors.flowchartDecisionColor};
      stroke: ${colors.flowchartLineColor};
      stroke-dasharray: 2 2;
    }
    .edgeLabel .label rect {
      fill: ${colors.flowchartEdgeLabelColor};
      stroke: ${colors.flowchartEdgeLabelBorderColor};
      stroke-width: 1px;
      opacity: 1;
      rx: 13px;
      ry: 13px;
    }
    .flowchart-link { stroke: ${colors.lineColor}; stroke-width: 1px; stroke-linecap: round; stroke-linejoin: round; }
    .marker { fill: ${colors.lineColor}; stroke: ${colors.lineColor}; }
  `;
}

function healFlowchartLabels(source: string) {
  return source.replace(
    /(\b[\w-]+)(\[([^[\]\n]+)\]|\{([^{}\n]+)\})/g,
    (match, id: string, bracket: string, square?: string, diamond?: string) => {
      const label = (square ?? diamond ?? "").trim();
      if (!/[()|]/.test(label) || label.startsWith('"') || /["`<>]/.test(label)) return match;
      return `${id}${bracket[0]}"${label}"${bracket.at(-1)}`;
    },
  );
}

function hasExternalCss(value: string) {
  const css = value.replace(/\/\*[\s\S]*?\*\//g, "");
  return (
    /\\|@import|image-set\s*\(/i.test(css) ||
    [...css.matchAll(/url\(\s*([^)]*?)\s*\)/gi)].some(
      ([, target]) => !/^(['"]?)#[\w:.-]+\1$/.test(target),
    )
  );
}

function markFlowchartDecisions(svg: Element) {
  for (const polygon of svg.querySelectorAll(".node > polygon.label-container[points]")) {
    // The classic renderer emits the diamond's four cardinal points without a shape class.
    const points =
      polygon
        .getAttribute("points")
        ?.trim()
        .split(/[\s,]+/)
        .map(Number) ?? [];
    if (
      points.length === 8 &&
      points[0] === points[4] &&
      points[3] === points[7] &&
      (points[6] - points[0]) * (points[2] - points[0]) < 0 &&
      (points[1] - points[3]) * (points[5] - points[3]) < 0
    )
      polygon.parentElement?.classList.add("mermaid-decision");
  }
}

function validatedSvg(markup: string, config: MermaidConfig, flowchart: boolean) {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const svg = parsed.documentElement;
  if (
    svg.namespaceURI !== SVG_NS ||
    svg.localName !== "svg" ||
    parsed.querySelector("parsererror") ||
    !parseMermaidViewBox(svg.getAttribute("viewBox"))
  ) {
    throw new Error("Invalid diagram SVG");
  }
  if (flowchart) markFlowchartDecisions(svg);
  // Keep generated vector shapes and local marker/clip references. Never mount
  // links or remote resources from diagram content in the app document.
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    if (
      ["script", "image", "img", "iframe", "object", "embed", "link"].includes(element.localName)
    ) {
      element.remove();
      continue;
    }
    if (element.localName === "style" && hasExternalCss(element.textContent ?? "")) {
      element.remove();
      continue;
    }
    for (const attr of [...element.attributes]) {
      if (
        /^on|^src/i.test(attr.localName) ||
        (attr.localName === "href" && !attr.value.startsWith("#")) ||
        ((attr.localName === "style" || /url\(/i.test(attr.value)) && hasExternalCss(attr.value))
      ) {
        element.removeAttributeNode(attr);
      }
    }
  }
  applyMermaidAuthorStyles(
    svg,
    Boolean(config.darkMode),
    String(config.themeVariables?.background ?? "#181818"),
    String(config.themeVariables?.textColor ?? "#ececec"),
  );
  return new XMLSerializer().serializeToString(svg);
}

async function render(id: string, source: string, config: MermaidConfig) {
  const { chart, title, sequenceNumberColor, css } = prepareSource(source);
  const declaration =
    chart
      .split(/\r?\n/)
      .find((line) => line.trim() && !line.trimStart().startsWith("%%"))
      ?.trimStart() ?? "";
  const flowchart = FLOWCHART.test(declaration);
  const useElk = GRAPH_LAYOUT.test(declaration);
  const { default: mermaid } = await loadMermaid();
  if (useElk && !elkRegistered) {
    try {
      const { default: loaders } = await loadMermaidElk();
      const elk = loaders.find((loader) => loader.name === "elk");
      mermaid.registerLayoutLoaders(elk ? [...loaders, createFlowchartLayout(elk)] : loaders);
      flowchartLayoutRegistered = Boolean(elk);
      elkRegistered = true;
    } catch {
      // The built-in layout also works when the optional chunk is unavailable.
    }
  }
  const layout =
    useElk && elkRegistered
      ? flowchart && flowchartLayoutRegistered
        ? flowchartLayoutName
        : "elk"
      : useElk || /^mindmap\b/i.test(declaration)
        ? "dagre"
        : undefined;
  mermaid.initialize({
    ...config,
    themeVariables: {
      ...config.themeVariables,
      ...(sequenceNumberColor && { sequenceNumberColor }),
    },
    themeCSS: [flowchart ? flowchartCss(config.themeVariables ?? {}) : "", ...css]
      .filter(Boolean)
      .join("\n"),
  });
  const container = document.createElement("div");
  container.inert = true;
  container.setAttribute("aria-hidden", "true");
  container.style.cssText = "position:fixed;inset:0;visibility:hidden;pointer-events:none";
  document.body.append(container);
  // Mind maps choose their own layout unless the diagram has an explicit
  // override. Keep the title and supply only trusted layout settings.
  const layoutSource = (body: string, engine = layout) => {
    const header = [
      title && `title: ${JSON.stringify(title)}`,
      engine && `config:\n  layout: ${engine}`,
    ]
      .filter(Boolean)
      .join("\n");
    return header ? `---\n${header}\n---\n${body}` : body;
  };
  try {
    try {
      return validatedSvg(
        (await mermaid.render(id, layoutSource(chart), container)).svg,
        config,
        flowchart,
      );
    } catch (reason) {
      const healed = flowchart ? healFlowchartLabels(chart) : chart;
      const fallback = layout === "elk" || layout === flowchartLayoutName ? "dagre" : layout;
      if (healed === chart && fallback === layout) throw reason;
      container.replaceChildren();
      return validatedSvg(
        (await mermaid.render(id, layoutSource(healed, fallback), container)).svg,
        config,
        flowchart,
      );
    }
  } finally {
    container.remove();
  }
}

export function renderMermaid(id: string, chart: string, config: MermaidConfig) {
  const key = JSON.stringify([id, config, chart]);
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  // Mermaid uses shared configuration across renders. Initialize and render
  // under the same queue so simultaneous light/dark or file previews cannot race.
  const renderId = `${id}-${++renderSequence}`;
  const pending = queue.then(() => render(renderId, chart, config));
  queue = pending.then(
    () => undefined,
    () => undefined,
  );
  cache.set(key, pending);
  if (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return pending;
}
