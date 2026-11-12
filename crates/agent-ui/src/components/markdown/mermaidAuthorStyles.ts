import { mermaidColorClasses } from "./mermaidColorClasses";

const shapeSelector = "rect,circle,ellipse,polygon,path";
const color = /^(?:#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|rgba?\([\d.%, /]+\))$/i;
const safeSelector = /^\.node\.[\w-]+ (?:rect|circle|ellipse|polygon|path|text|tspan)$/;
const legacyInit = /^%%\{\s*(?:init|initialize)\s*:\s*(\{[\s\S]*\})\s*\}%%$/i;

function safeCss(source: string) {
  // Reconstruct only CSS paint declarations. Never mount the author stylesheet.
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .flatMap(([, selector, body]) => {
      const scoped = selector.trim();
      if (!safeSelector.test(scoped)) return [];
      const paint = body
        .split(";")
        .map((declaration) => /^\s*(fill|stroke)\s*:\s*(.*?)\s*$/.exec(declaration))
        .flatMap((entry) => (entry && color.test(entry[2]) ? [`${entry[1]}:${entry[2]}`] : []))
        .join(";");
      return paint ? [`${scoped}{${paint}}`] : [];
    })
    .join("\n");
}

export function readMermaidAuthorStyle(directive: string) {
  const data = legacyInit.exec(directive)?.[1];
  if (!data) return;
  try {
    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(data);
    } catch {
      settings = JSON.parse(data.replaceAll("'", '"'));
    }
    if (
      !settings ||
      Object.keys(settings).some((key) => !["theme", "themeVariables", "themeCSS"].includes(key)) ||
      (settings.theme !== undefined && settings.theme !== "base")
    )
      return;
    const variables = settings.themeVariables as { sequenceNumberColor?: unknown } | undefined;
    if (variables && Object.keys(variables).some((key) => key !== "sequenceNumberColor")) return;
    const numberColor = variables?.sequenceNumberColor;
    return {
      sequenceNumberColor:
        typeof numberColor === "string" && numberColor.startsWith("#") && color.test(numberColor)
          ? numberColor
          : undefined,
      css: typeof settings.themeCSS === "string" ? safeCss(settings.themeCSS) : "",
    };
  } catch {
    return;
  }
}

export function applyMermaidAuthorStyles(
  svg: Element,
  dark: boolean,
  background: string,
  textColor: string,
) {
  for (const node of svg.querySelectorAll(".node")) {
    const palette = [...node.classList]
      .reverse()
      .find((name) => Object.hasOwn(mermaidColorClasses, name));
    const shade = palette && mermaidColorClasses[palette][dark ? 1 : 0];
    let labelColor = shade ? shade[2] : undefined;
    for (const shape of node.querySelectorAll<SVGElement>(shapeSelector)) {
      if (shape.closest(".label")) continue;
      const { style } = shape;
      if (!style) continue;
      if (shade) {
        if ((style.fill || shape.getAttribute("fill")) !== "none")
          style.setProperty("fill", shade[0], "important");
        if ((style.stroke || shape.getAttribute("stroke")) !== "none")
          style.setProperty("stroke", shade[1], "important");
      } else if (dark && style.fill && globalThis.CSS?.supports("color", style.fill)) {
        if (style.fill !== "transparent" && style.fill !== "none")
          style.setProperty(
            "fill",
            `color-mix(in oklab, ${style.fill} 22%, ${background})`,
            "important",
          );
        labelColor = textColor;
      }
    }
    if (labelColor) {
      for (const text of node.querySelectorAll<SVGElement>("text,tspan")) {
        text.style.setProperty("fill", labelColor, "important");
        text.style.setProperty("color", labelColor, "important");
      }
    }
  }
}
