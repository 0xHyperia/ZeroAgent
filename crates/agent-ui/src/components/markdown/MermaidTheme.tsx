import type { MermaidConfig } from "mermaid";
import { useSyncExternalStore } from "react";

function config(darkMode: boolean): MermaidConfig {
  const background = darkMode ? "#212121" : "#ffffff";
  const text = darkMode ? "#ececec" : "#202123";
  const line = darkMode ? "#a1a1aa" : "#52525b";
  const node = darkMode ? "#303036" : "#f4f4f5";
  const border = darkMode ? "#73737d" : "#b4b4be";
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
      primaryColor: node,
      primaryTextColor: text,
      primaryBorderColor: border,
      textColor: text,
      lineColor: line,
      nodeTextColor: text,
      mainBkg: node,
      edgeLabelBackground: background,
      actorBkg: node,
      actorBorder: border,
      actorTextColor: text,
      signalColor: line,
      signalTextColor: text,
      pie1: "#65a0ef",
      pie2: "#51bbab",
      pie3: "#bf95ef",
      pie4: "#eeb078",
      xyChart: { backgroundColor: background, plotColorPalette: "#65a0ef,#51bbab,#bf95ef,#eeb078" },
    },
    themeCSS: `
      .flowchart-link { stroke-linecap: round; stroke-linejoin: round; }
      .node rect.label-container { rx: 12px; ry: 12px; }
      .node .nodeLabel, .edgeLabel .label { font-weight: 600; }
    `,
    flowchart: { useMaxWidth: false, nodeSpacing: 35, rankSpacing: 48 },
  };
}

const configs = {
  light: config(false),
  dark: config(true),
};

const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    // Both hosts apply the effective theme (including system changes) to html.
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}

function snapshot() {
  return document.documentElement.classList.contains("dark");
}

export function useMermaidConfig() {
  const dark = useSyncExternalStore(subscribe, snapshot, () => false);
  return configs[dark ? "dark" : "light"];
}
