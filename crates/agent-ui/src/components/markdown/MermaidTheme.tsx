import type { MermaidConfig } from "mermaid";
import { useSyncExternalStore } from "react";

const series = {
  blue: ["#539af8", "#1f4e94"],
  green: ["#6bc67f", "#3a843f"],
  orange: ["#ef8b57", "#ac4f23"],
  yellow: ["#f8d45d", "#d9a337"],
  purple: ["#b897f4", "#7849d1"],
  pink: ["#f68ebc", "#ab4f7a"],
} as const;

const flowchartColors = {
  blue: [
    ["#e5f3ff", "#f5faff", "#004f99", "#cedbe5"],
    ["#00284d", "#000e1a", "#99ceff", "#1a3e5f"],
  ],
  green: [
    ["#d9f4e4", "#edfaf2", "#00692a", "#c3dccd", "#a6d3b8"],
    ["#003716", "#021c0c", "#8cdfad", "#1a4b2d"],
  ],
  orange: [
    ["#ffe7d9", "#fff5f0", "#6d2e0f", "#e5d0c3"],
    ["#4a2206", "#281105", "#ffb790", "#5c381f"],
  ],
  yellow: [
    ["#fff6d9", "#fffbed", "#6e5400", "#e5ddc3"],
    ["#4d3b00", "#271d00", "#ffe48c", "#5f4f1a"],
  ],
  purple: [
    ["#efe5fe", "#f9f5fe", "#6b3ab4", "#d7cee5"],
    ["#2c184a", "#170c26", "#ceb0fb", "#412f5c"],
  ],
  pink: [
    ["#ffe8f3", "#fff4f9", "#963c67", "#e5d1db"],
    ["#4d1f34", "#29101c", "#ffbada", "#5f3548"],
  ],
  neutral: [
    ["#f3f3f3", "#f9f9f9", "#414141", "#dbdbdb"],
    ["#181818", "#131313", "#e8e8e8", "#2f2f2f"],
  ],
} as const;

type FlowchartAccent = keyof typeof flowchartColors;
export type MermaidAccent = "auto" | FlowchartAccent;
export const mermaidAccents: MermaidAccent[] = [
  "auto",
  ...(Object.keys(flowchartColors) as FlowchartAccent[]),
];

function tint(color: string, surface: string, amount: number) {
  const foreground = Number.parseInt(color.slice(1), 16);
  const background = Number.parseInt(surface.slice(1), 16);
  const rgb = [16, 8, 0].map((shift) =>
    Math.round(
      ((foreground >> shift) & 255) * amount + ((background >> shift) & 255) * (1 - amount),
    ),
  );
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function seriesVariables(colors: string[]) {
  return Object.fromEntries(
    colors.flatMap((color, index) => [
      [`cScale${index}`, color],
      [`pie${index + 1}`, color],
      ...(index < 8
        ? [
            [`git${index}`, color],
            [`fillType${index}`, color],
          ]
        : []),
    ]),
  );
}

export function createMermaidConfig(darkMode: boolean, accent: MermaidAccent): MermaidConfig {
  const mode = darkMode ? 1 : 0;
  const background = darkMode ? "#181818" : "#ffffff";
  const secondary = darkMode ? "#303030" : background;
  const text = darkMode ? "#ececec" : "#202123";
  const line = darkMode ? "#a1a1aa" : "#8f8f8f";
  const border = darkMode ? "#55555b" : "#dedee1";
  const names = Object.keys(series) as (keyof typeof series)[];
  const offset = accent === "auto" || accent === "neutral" ? 0 : names.indexOf(accent);
  const colors = Array.from(
    { length: 12 },
    (_, i) => series[names[(offset + i) % names.length]][mode],
  );
  const base = colors[0];
  const node = tint(base, background, darkMode ? 0.3 : 0.18);
  const referenceSequence = !darkMode && accent === "auto";
  const actorFill = referenceSequence ? "#e3edfe" : node;
  const actorBorder = referenceSequence ? "#a7c5fa" : base;
  const noteBorder = referenceSequence ? "#bbe3c0" : colors[1];
  const [
    flowchartNodeColor,
    flowchartDecisionColor,
    flowchartTextColor,
    flowchartLineColor,
    edgeBorder,
  ] = flowchartColors[accent === "auto" ? "neutral" : accent][mode] as readonly [
    string,
    string,
    string,
    string,
    string?,
  ];
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    theme: "base",
    darkMode,
    fontFamily: "system-ui, sans-serif",
    maxTextSize: 50_000,
    maxEdges: 500,
    themeVariables: {
      darkMode,
      background,
      primaryColor: actorFill,
      primaryTextColor: text,
      primaryBorderColor: actorBorder,
      secondaryColor: secondary,
      secondaryTextColor: text,
      secondaryBorderColor: noteBorder,
      tertiaryColor: secondary,
      tertiaryTextColor: text,
      tertiaryBorderColor: border,
      textColor: text,
      titleColor: text,
      lineColor: line,
      arrowheadColor: line,
      mainBkg: actorFill,
      nodeBkg: actorFill,
      nodeBorder: actorBorder,
      nodeTextColor: text,
      clusterBkg: secondary,
      clusterBorder: darkMode ? border : "#ededed",
      edgeLabelBackground: background,
      flowchartNodeColor,
      flowchartNodeBorderColor: darkMode ? "#ffffff1a" : "#0000001a",
      flowchartDecisionColor,
      flowchartTextColor,
      flowchartLineColor,
      flowchartEdgeLabelColor:
        !darkMode && (accent === "auto" || accent === "neutral")
          ? "#fcfcfc"
          : flowchartDecisionColor,
      flowchartEdgeLabelBorderColor: edgeBorder ?? flowchartLineColor,
      actorBkg: actorFill,
      actorBorder,
      actorTextColor: text,
      actorLineColor: line,
      signalColor: line,
      signalTextColor: text,
      labelBoxBkgColor: background,
      labelBoxBorderColor: border,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: secondary,
      noteBorderColor: noteBorder,
      noteTextColor: text,
      sectionBkgColor: secondary,
      sectionBkgColor2: actorFill,
      taskBkgColor: actorFill,
      taskBorderColor: actorBorder,
      activeTaskBkgColor: actorFill,
      activeTaskBorderColor: actorBorder,
      doneTaskBkgColor: secondary,
      doneTaskBorderColor: border,
      critBkgColor: secondary,
      critBorderColor: noteBorder,
      taskTextColor: text,
      taskTextOutsideColor: text,
      pieTitleTextColor: text,
      pieSectionTextColor: text,
      pieLegendTextColor: text,
      pieStrokeColor: background,
      pieStrokeWidth: "2px",
      pieOuterStrokeColor: background,
      pieOuterStrokeWidth: "2px",
      quadrant1TextFill: text,
      quadrant2TextFill: text,
      quadrant3TextFill: text,
      quadrant4TextFill: text,
      quadrantPointTextFill: text,
      quadrantXAxisTextFill: text,
      quadrantYAxisTextFill: text,
      quadrantTitleFill: text,
      xyChart: {
        backgroundColor: background,
        titleColor: text,
        xAxisLabelColor: text,
        xAxisTitleColor: text,
        xAxisTickColor: line,
        xAxisLineColor: line,
        yAxisLabelColor: text,
        yAxisTitleColor: text,
        yAxisTickColor: line,
        yAxisLineColor: line,
        dataLabelColor: text,
        plotColorPalette: colors.join(","),
      },
      ...seriesVariables(colors),
    },
    flowchart: { useMaxWidth: false },
  };
}

const configs = new Map<string, MermaidConfig>();
const storageKey = "zeroagent.mermaid-accent";
const defaultAccent: MermaidAccent = "auto";
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;
let unsavedAccent: MermaidAccent | undefined;

function isAccent(value: string | null): value is MermaidAccent {
  return value === "auto" || (value !== null && Object.hasOwn(flowchartColors, value));
}

function notify() {
  for (const listener of listeners) listener();
}

function storageChanged(event: StorageEvent) {
  if (event.key === storageKey || event.key === null) notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(notify);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("storage", storageChanged);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
      window.removeEventListener("storage", storageChanged);
    }
  };
}

function accentSnapshot(): MermaidAccent {
  if (unsavedAccent) return unsavedAccent;
  try {
    const value = window.localStorage.getItem(storageKey);
    return isAccent(value) ? value : defaultAccent;
  } catch {
    return defaultAccent;
  }
}

function darkSnapshot() {
  return document.documentElement.classList.contains("dark");
}

export function setMermaidAccent(value: string) {
  if (!isAccent(value)) return;
  try {
    window.localStorage.setItem(storageKey, value);
    unsavedAccent = undefined;
  } catch {
    unsavedAccent = value;
  }
  notify();
}

export function useMermaidAccent() {
  return useSyncExternalStore(subscribe, accentSnapshot, () => defaultAccent);
}

export function useMermaidConfig() {
  const dark = useSyncExternalStore(subscribe, darkSnapshot, () => false);
  const accent = useMermaidAccent();
  const key = `${dark}:${accent}`;
  let config = configs.get(key);
  if (!config) {
    config = createMermaidConfig(dark, accent);
    configs.set(key, config);
  }
  return config;
}
