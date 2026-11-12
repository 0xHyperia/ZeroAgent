import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

export type WorkspaceMermaidHost = { id: number; element: HTMLElement; chart: string };

export function workspaceMarkdownMermaid(
  mount: (host: WorkspaceMermaidHost) => void,
  unmount: (element: HTMLElement) => void,
) {
  let nextId = 0;

  class DiagramWidget extends WidgetType {
    constructor(readonly chart: string) {
      super();
    }

    eq(other: DiagramWidget) {
      return this.chart === other.chart;
    }

    get estimatedHeight() {
      return 144;
    }

    toDOM(view: EditorView) {
      const element = view.dom.ownerDocument.createElement("div");
      element.className = "za-md-mermaid-widget";
      mount({ id: nextId++, element, chart: this.chart });
      return element;
    }

    destroy(element: HTMLElement) {
      unmount(element);
    }
  }

  function diagrams(state: EditorState) {
    const ranges: Range<Decoration>[] = [];
    syntaxTree(state).iterate({
      enter({ name, node, from, to }) {
        if (name !== "FencedCode") return;
        const info = node.getChild("CodeInfo");
        const language = info && state.sliceDoc(info.from, info.to).trim().split(/\s+/, 1)[0];
        if (
          (language?.toLowerCase() !== "mermaid" && language?.toLowerCase() !== "mmd") ||
          node.getChildren("CodeMark").length !== 2
        )
          return false;
        // The parser excludes list and quote markers from these slices and preserves line breaks.
        const chart = node
          .getChildren("CodeText")
          .map(({ from, to }) => state.sliceDoc(from, to))
          .join("");
        ranges.push(
          Decoration.replace({ widget: new DiagramWidget(chart), block: true }).range(from, to),
        );
        return false;
      },
    });
    return Decoration.set(ranges);
  }

  // CodeMirror requires block replacements to come from editor state, before viewport measurement.
  const field = StateField.define<DecorationSet>({
    create: diagrams,
    update(value, transaction) {
      return transaction.docChanged ||
        syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
        ? diagrams(transaction.state)
        : value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  return [field, EditorView.atomicRanges.of((view) => view.state.field(field))];
}
