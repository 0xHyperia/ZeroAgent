import type { LayoutLoaderDefinition } from "mermaid";

const rectangularShapes = new Set([
  "rect",
  "squareRect",
  "proc",
  "process",
  "rectangle",
  "rounded",
  "roundedRect",
  "event",
]);
const decisionShapes = new Set(["diamond", "diam", "decision", "question"]);

export const flowchartLayoutName = "zeroagent-flowchart";

export function createFlowchartLayout(elk: LayoutLoaderDefinition): LayoutLoaderDefinition {
  return {
    ...elk,
    name: flowchartLayoutName,
    loader: async () => {
      const layout = await elk.loader();
      return {
        async render(data, svg, helpers, options, positions) {
          for (const node of data.nodes) {
            if (node.isGroup || !node.shape) continue;
            if (decisionShapes.has(node.shape)) {
              node.shape = "rect";
              node.cssClasses = [node.cssClasses, "mermaid-decision"].filter(Boolean).join(" ");
            }
            if (!rectangularShapes.has(node.shape)) continue;
            node.shape = "rect";
            node.padding = 16;
            node.labelPaddingX = 36;
            node.height = Math.max(node.height ?? 0, 60);
          }
          await layout.render(data, svg, helpers, options, positions);
          // The installed ELK measures and paints with its own helpers. Update
          // the label background around its already centered SVG text.
          for (const label of svg.node()?.querySelectorAll(".edgeLabel .label") ?? []) {
            const background = label.querySelector<SVGRectElement>("rect.background");
            const text = label.querySelector("text");
            if (!background || !text?.textContent?.trim()) continue;
            const box = text.getBBox();
            const height = Math.max(26, box.height + 8);
            background.setAttribute("x", String(box.x - 12));
            background.setAttribute("y", String(box.y - (height - box.height) / 2));
            background.setAttribute("width", String(box.width + 24));
            background.setAttribute("height", String(height));
            background.style.removeProperty("stroke");
          }

          for (const marker of svg.node()?.querySelectorAll("marker") ?? []) {
            const side = /-point(End|Start)(?:_|$)/.exec(marker.id)?.[1];
            const arrow = marker.querySelector("path");
            if (!side || !arrow) continue;
            const end = side === "End";
            marker.setAttribute("viewBox", "-5 -5 10 10");
            marker.setAttribute("markerWidth", "10");
            marker.setAttribute("markerHeight", "10");
            marker.setAttribute("refX", end ? "10" : "-10");
            marker.setAttribute("refY", "0");
            arrow.setAttribute(
              "d",
              end ? "M0 0H4 M.8 -3.2L4 0 .8 3.2" : "M0 0H-4 M-.8 -3.2L-4 0 -.8 3.2",
            );
            arrow.style.fill = "none";
            arrow.style.strokeWidth = "1";
            arrow.style.strokeDasharray = "none";
            arrow.style.strokeLinecap = "round";
            arrow.style.strokeLinejoin = "round";
          }
        },
      };
    },
  };
}
