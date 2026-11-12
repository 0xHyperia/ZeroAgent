import {
  defaultKeymap,
  history,
  historyKeymap,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  type Range,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { type Ref, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import type { ProjectToolTextGenerationClient } from "../../lib/ai/projectToolTextGeneration";
import { normalizeQuoteText } from "../../lib/chat/transcriptQuote";
import { copyTextToClipboard } from "../../lib/shared/clipboard";
import { Check, Copy } from "../IconSet";
import { MarkdownMermaidBlock } from "../markdown/MarkdownMermaidBlock";
import {
  MarkdownSelectionToolbar,
  type MarkdownToolbarSelection,
} from "../resource-preview/MarkdownSelectionToolbar";
import type { MarkdownSelectionActions } from "../resource-preview/PreviewChrome";
import { TooltipButton } from "../ui/tooltip-button";
import {
  markdownSelectionEditField,
  useWorkspaceMarkdownSelectionEdit,
} from "./useWorkspaceMarkdownSelectionEdit";
import WorkspaceMarkdownSelectionReview from "./WorkspaceMarkdownSelectionReview";
import { workspaceMarkdownHeadingSlug } from "./workspaceMarkdownAssets";
import {
  applyWorkspaceMarkdownEdits,
  type MarkdownSourceEdit,
  workspaceMarkdownEditorText,
} from "./workspaceMarkdownDocument";
import { type WorkspaceMermaidHost, workspaceMarkdownMermaid } from "./workspaceMarkdownMermaid";
import { MARKDOWN_EDIT_TEXT_LIMIT } from "./workspaceMarkdownSelectionEdit";
import "./workspace-markdown-editor.css";

export type WorkspaceMarkdownEditorHandle = {
  getValue: () => string;
  find: () => void;
  revealLine: (line: number, column?: number, endLine?: number) => void;
  undo: () => void;
  redo: () => void;
};

const inlineMarker = new Set(["EmphasisMark", "StrikethroughMark"]);
const styledNodes: Record<string, string> = {
  Emphasis: "za-md-emphasis",
  StrongEmphasis: "za-md-strong",
  Strikethrough: "za-md-strikethrough",
  InlineCode: "za-md-code",
  Link: "za-md-link",
  Autolink: "za-md-link",
};

class ListBullet extends WidgetType {
  toDOM() {
    const bullet = document.createElement("span");
    bullet.textContent = "•";
    bullet.className = "za-md-list-bullet";
    bullet.setAttribute("aria-hidden", "true");
    return bullet;
  }
}

class EmptyTableCell extends WidgetType {
  toDOM(view: EditorView) {
    const cell = view.dom.ownerDocument.createElement("span");
    cell.className = "za-md-table-cell";
    cell.setAttribute("aria-hidden", "true");
    return cell;
  }
}

const emptyTableCell = new EmptyTableCell();

function liveDecorations(view: EditorView) {
  const { state } = view;
  const decorations: Range<Decoration>[] = [];
  const concealed: Range<Decoration>[] = [];
  const styledLines = new Set<string>();
  const selections = view.hasFocus ? state.selection.ranges : [];
  const showSource = (from: number, to: number) =>
    selections.some((selection) =>
      selection.empty
        ? from <= selection.head && selection.head <= to
        : selection.from < to && from < selection.to,
    );
  const hide = (from: number, to: number, widget?: WidgetType) => {
    if (from >= to) return;
    const item = Decoration.replace({ widget }).range(from, to);
    decorations.push(item);
    concealed.push(item);
  };
  const styleLines = (
    from: number,
    to: number,
    className: string,
    visible: { from: number; to: number },
  ) => {
    const first = state.doc.lineAt(Math.max(from, visible.from));
    const last = state.doc.lineAt(Math.min(to, visible.to));
    for (let index = first.number; index <= last.number; index++) {
      const key = `${index}:${className}`;
      if (styledLines.has(key)) continue;
      styledLines.add(key);
      decorations.push(Decoration.line({ class: className }).range(state.doc.line(index).from));
    }
  };
  // The parser owns node offsets. Decorations only change the view.
  const traversed = new Set<string>();
  for (const visible of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter: ({ name, from, to, node }) => {
        const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name)?.[1];
        if (heading) styleLines(from, to, `za-md-heading za-md-h${heading}`, visible);
        if (name === "Blockquote") styleLines(from, to, "za-md-quote", visible);
        if (name === "BulletList" || name === "OrderedList")
          styleLines(from, to, "za-md-list-line", visible);
        if (name === "FencedCode" || name === "CodeBlock") {
          const marks = node.getChildren("CodeMark");
          const first = state.doc.lineAt(from);
          const last = state.doc.lineAt(to);
          const completeFence = name === "FencedCode" && marks.length === 2;
          const info = completeFence ? node.getChild("CodeInfo") : null;
          const language = info ? state.sliceDoc(info.from, info.to).trim().split(/\s+/, 1)[0] : "";
          if (["mermaid", "mmd"].includes(language.toLowerCase())) return false;
          const start = state.doc.lineAt(Math.max(from, visible.from)).number;
          const end = state.doc.lineAt(Math.min(to, visible.to)).number;
          for (let index = start; index <= end; index++) {
            const line = state.doc.line(index);
            const edge = index === first.number || index === last.number;
            const key = `code:${index}`;
            if (styledLines.has(key)) continue;
            styledLines.add(key);
            const hideFence = completeFence && edge && !showSource(line.from, line.to);
            if (hideFence) {
              const fence = index === first.number ? marks[0] : marks[1];
              hide(fence.from, line.to);
            }
            const classes = [
              "za-md-code-line",
              index === first.number && "za-md-code-first",
              index === last.number && "za-md-code-last",
            ];
            decorations.push(
              Decoration.line({
                class: classes.filter(Boolean).join(" "),
                attributes:
                  hideFence && index === first.number && language
                    ? { "data-language": language }
                    : undefined,
              }).range(line.from),
            );
          }
          return false;
        }
        const identity = `${name}:${from}:${to}`;
        if (traversed.has(identity)) return;
        traversed.add(identity);
        if (name === "TableHeader" || name === "TableRow") {
          const delimiters = node.getChildren("TableDelimiter");
          // Keep the rendered cells while editing text. Reveal the row when editing its pipes.
          if (delimiters.some((pipe) => showSource(pipe.from, pipe.to))) return;
          const className =
            name === "TableHeader" ? "za-md-table-row za-md-table-head" : "za-md-table-row";
          decorations.push(
            Decoration.line({ class: className }).range(state.doc.lineAt(from).from),
          );
          for (const { from, to } of node.getChildren("TableCell"))
            decorations.push(Decoration.mark({ class: "za-md-table-cell" }).range(from, to));
          let cellStart = from;
          for (const pipe of delimiters) {
            if (pipe.from > from && !state.sliceDoc(cellStart, pipe.from).trim()) {
              decorations.push(
                Decoration.widget({ widget: emptyTableCell, side: -1 }).range(pipe.from),
              );
            }
            hide(pipe.from, pipe.to);
            cellStart = pipe.to;
          }
        }
        if (name === "TableDelimiter" && node.parent?.name === "Table" && !showSource(from, to)) {
          decorations.push(
            Decoration.line({ class: "za-md-table-separator" }).range(state.doc.lineAt(from).from),
          );
          hide(from, to);
        }
        if (name === "HorizontalRule" && !showSource(from, to)) {
          styleLines(from, to, "za-md-rule", visible);
          hide(from, to);
        }
        const mark = styledNodes[name];
        const destination = name === "Link" || name === "Autolink" ? node.getChild("URL") : null;
        if (mark && from < to) {
          const attributes = destination
            ? { "data-workspace-markdown-href": state.sliceDoc(destination.from, destination.to) }
            : undefined;
          decorations.push(Decoration.mark({ class: mark, attributes }).range(from, to));
        }
        if (name === "HeaderMark" || name === "QuoteMark") {
          const end = to + (/^[ \t]$/.test(state.sliceDoc(to, to + 1)) ? 1 : 0);
          if (!showSource(from, end)) hide(from, end);
        }
        const parent = node.parent;
        if (
          parent &&
          (inlineMarker.has(name) || (name === "CodeMark" && parent.name === "InlineCode")) &&
          !showSource(parent.from, parent.to)
        )
          hide(from, to);
        if (name === "HardBreak" && !showSource(from, to)) hide(from, to);
        if (
          name === "ListMark" &&
          !showSource(from, to) &&
          /^[*+-]$/.test(state.sliceDoc(from, to))
        )
          hide(from, to, new ListBullet());
        if ((name === "Link" || name === "Autolink") && destination && !showSource(from, to)) {
          const marks = node.getChildren("LinkMark");
          if (name === "Link" && marks.length >= 4) {
            hide(marks[0].from, marks[0].to);
            hide(marks[1].from, to);
          } else if (name === "Autolink") {
            for (const mark of marks) hide(mark.from, mark.to);
          }
        }
      },
    });
  }
  return {
    decorations: Decoration.set(decorations, true),
    concealed: Decoration.set(concealed, true),
  };
}

const renderedMarkdown = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    concealed: DecorationSet;
    constructor(view: EditorView) {
      ({ decorations: this.decorations, concealed: this.concealed } = liveDecorations(view));
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        ({ decorations: this.decorations, concealed: this.concealed } = liveDecorations(
          update.view,
        ));
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const liveMode = [
  renderedMarkdown,
  EditorView.atomicRanges.of((view) => view.plugin(renderedMarkdown)?.concealed ?? Decoration.none),
];
const sourceMode = [lineNumbers(), syntaxHighlighting(defaultHighlightStyle, { fallback: true })];

function markdownLinkAtClick(event: MouseEvent, view: EditorView) {
  const target = event.target instanceof Element ? event.target : null;
  const href = target
    ?.closest("[data-workspace-markdown-href]")
    ?.getAttribute("data-workspace-markdown-href");
  if (href) return href;
  if (!target || !view.contentDOM.contains(target)) return null;
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (position === null) return null;
  for (let node = syntaxTree(view.state).resolveInner(position, -1); ; ) {
    if (node.name === "Link" || node.name === "Autolink") {
      const url = node.getChild("URL");
      return url ? view.state.sliceDoc(url.from, url.to) : null;
    }
    if (!node.parent) return null;
    node = node.parent;
  }
}

type Props = {
  handle: Ref<WorkspaceMarkdownEditorHandle>;
  value: string;
  mode: "preview" | "source";
  active: boolean;
  readOnly: boolean;
  theme: "light" | "dark";
  selectionActions?: MarkdownSelectionActions;
  textGeneration?: ProjectToolTextGenerationClient;
  onOpenLink?: (href: string) => boolean;
  onChange: (value: string) => void;
  onHistory: (canUndo: boolean, canRedo: boolean) => void;
  onSave: () => void;
};

export default function WorkspaceMarkdownEditor(props: Props) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const editor = useRef<EditorView | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const content = useRef(props.value);
  const current = useRef(props);
  current.current = props;
  const selectionEdit = useWorkspaceMarkdownSelectionEdit({
    editor,
    rawDraft: content,
    generation: props.textGeneration,
    enabled: props.active && props.mode === "preview" && !props.readOnly,
    failureMessage: zh
      ? "无法生成此次修改。请调整要求后重试。"
      : "Could not generate this edit. Adjust the instruction and try again.",
  });
  const currentSelectionEdit = useRef(selectionEdit);
  currentSelectionEdit.current = selectionEdit;
  const [copied, setCopied] = useState(false);
  const [diagramHosts, setDiagramHosts] = useState<WorkspaceMermaidHost[]>([]);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeExtension = useRef(new Compartment());
  const previewExtensions = useRef<Extension>(liveMode);
  const writable = useRef(new Compartment());
  const undoHistory = useRef(new Compartment());
  const scrollTop = useRef({ preview: 0, source: 0 });
  const visibleMode = useRef(props.mode);
  useLayoutEffect(() => {
    if (!root.current) return;
    const hosts = new Map<HTMLElement, WorkspaceMermaidHost>();
    let scheduled = false;
    let disposed = false;
    const updateDiagramHosts = () => {
      if (disposed || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!disposed) setDiagramHosts([...hosts.values()]);
      });
    };
    previewExtensions.current = [
      liveMode,
      workspaceMarkdownMermaid(
        (host) => {
          hosts.set(host.element, host);
          updateDiagramHosts();
        },
        (element) => {
          hosts.delete(element);
          updateDiagramHosts();
        },
      ),
    ];
    // Refresh the portal targets even when a recreated editor has no visible diagrams.
    updateDiagramHosts();
    visibleMode.current = current.current.mode;
    const view = new EditorView({
      parent: root.current,
      state: EditorState.create({
        doc: workspaceMarkdownEditorText(content.current),
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownSelectionEditField,
          undoHistory.current.of(history()),
          search(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": zh ? "Markdown 文档正文" : "Markdown document",
          }),
          modeExtension.current.of(
            current.current.mode === "preview" ? previewExtensions.current : sourceMode,
          ),
          writable.current.of(EditorState.readOnly.of(current.current.readOnly)),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                current.current.onSave();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.domEventHandlers({
            click: (event, view) => {
              if (
                current.current.mode !== "preview" ||
                event.button !== 0 ||
                event.detail > 1 ||
                (event.shiftKey && !(event.ctrlKey || event.metaKey)) ||
                !view.state.selection.main.empty
              )
                return false;
              const href = markdownLinkAtClick(event, view);
              if (!href) return false;
              if (!href.startsWith("#")) return current.current.onOpenLink?.(href) ?? false;
              let match: number | null = null;
              syntaxTree(view.state).iterate({
                enter: ({ from, to, name }) => {
                  if (match !== null || !/^(?:ATX|Setext)Heading[1-6]$/.test(name)) return;
                  const heading = view.state
                    .sliceDoc(from, to)
                    .replace(/^#{1,6}\s+/, "")
                    .split("\n")[0];
                  if (workspaceMarkdownHeadingSlug(heading) === href.slice(1)) match = from;
                },
              });
              if (match === null) return false;
              view.dispatch({
                effects: EditorView.scrollIntoView(match, { y: "start", yMargin: 12 }),
              });
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            currentSelectionEdit.current.changed();
            if (!update.transactions.some((entry) => entry.annotation(externalUpdate))) {
              const changes: MarkdownSourceEdit[] = [];
              update.changes.iterChanges((from, to, _newFrom, _newTo, insert) =>
                changes.push({ from, to, insert: insert.toString() }),
              );
              content.current = applyWorkspaceMarkdownEdits(content.current, changes);
              current.current.onChange(content.current);
              current.current.onHistory(undoDepth(update.state) > 0, redoDepth(update.state) > 0);
            }
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      disposed = true;
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      editor.current = null;
      view.destroy();
    };
  }, [zh]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || props.value === content.current) return;
    content.current = props.value;
    const doc = workspaceMarkdownEditorText(props.value);
    if (doc === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
      annotations: [Transaction.addToHistory.of(false), externalUpdate.of(true)],
      effects: undoHistory.current.reconfigure([]),
    });
    view.dispatch({ effects: undoHistory.current.reconfigure(history()) });
    current.current.onHistory(false, false);
  }, [props.value]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || props.mode === visibleMode.current) return;
    scrollTop.current[visibleMode.current] = view.scrollDOM.scrollTop;
    visibleMode.current = props.mode;
    view.dispatch({
      effects: modeExtension.current.reconfigure(
        props.mode === "preview" ? previewExtensions.current : sourceMode,
      ),
    });
    view.scrollDOM.scrollTop = scrollTop.current[props.mode];
  }, [props.mode]);

  useLayoutEffect(() => {
    editor.current?.dispatch({
      effects: writable.current.reconfigure(EditorState.readOnly.of(props.readOnly)),
    });
  }, [props.readOnly]);

  useImperativeHandle(
    props.handle,
    () => ({
      getValue: () => content.current,
      find: () => {
        const view = editor.current;
        if (view) openSearchPanel(view);
      },
      revealLine: (requestedLine, column, endLine) => {
        const view = editor.current;
        if (!view) return;
        const doc = view.state.doc;
        const line = doc.line(Math.min(Math.max(1, requestedLine), doc.lines));
        const position = Math.min(line.to, line.from + Math.max(0, (column ?? 1) - 1));
        const end = endLine
          ? doc.line(Math.min(doc.lines, Math.max(line.number, endLine))).to
          : position;
        view.dispatch({
          selection: EditorSelection.range(position, end),
          effects: EditorView.scrollIntoView(position, { y: "center" }),
        });
        view.focus();
      },
      undo: () => {
        const view = editor.current;
        if (view) undo(view);
      },
      redo: () => {
        const view = editor.current;
        if (view) redo(view);
      },
    }),
    [],
  );

  const getSelection = (): MarkdownToolbarSelection | null => {
    const view = editor.current;
    if (!view?.hasFocus) return null;
    const { from, to } = view.state.selection.main;
    const text = normalizeQuoteText(view.state.sliceDoc(from, to));
    if (from === to || !text) return null;
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    if (!start || !end) return null;
    const line = view.state.doc.lineAt(from);
    const right = start.top === end.top ? end.right : start.right;
    return {
      text,
      source: "assistant",
      position: { line: line.number, column: from - line.from + 1 },
      editRange:
        to - from <= MARKDOWN_EDIT_TEXT_LIMIT
          ? { from, to, revision: selectionEdit.revision.current }
          : undefined,
      rect: {
        left: start.left,
        top: start.top,
        right,
        bottom: end.bottom,
        width: right - start.left,
        height: end.bottom - start.top,
      },
    };
  };

  const copyMarkdown = async () => {
    if (!(await copyTextToClipboard(content.current))) return;
    setCopied(true);
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1200);
  };
  const copyLabel = copied ? (zh ? "已复制" : "Copied") : zh ? "复制 Markdown" : "Copy Markdown";
  const activeEdit = selectionEdit.edit;
  const fullReview = activeEdit?.phase === "review" && !activeEdit.inline;
  const review = activeEdit && (
    <WorkspaceMarkdownSelectionReview
      edit={activeEdit}
      theme={props.theme}
      onAccept={selectionEdit.accept}
      onReject={() => selectionEdit.discard(true)}
      onEditInstruction={selectionEdit.editInstruction}
    />
  );
  return (
    <div className="za-workspace-markdown-editor" data-markdown-mode={props.mode}>
      <div ref={root} className="za-workspace-markdown-content" inert={fullReview} />
      {props.mode === "preview" &&
        diagramHosts.map(({ element, chart, id }) =>
          createPortal(
            <MarkdownMermaidBlock chart={chart} allowEdit={false} />,
            element,
            String(id),
          ),
        )}
      {fullReview ? (
        review
      ) : activeEdit?.phase === "pending" && !activeEdit.inline ? (
        <div className="za-md-edit-pending-floating">{review}</div>
      ) : (
        selectionEdit.inlineHost && review && createPortal(review, selectionEdit.inlineHost)
      )}
      {props.mode === "preview" && !fullReview && (
        <TooltipButton
          type="button"
          variant="ghost"
          size="icon-sm"
          className="za-workspace-markdown-copy"
          aria-label={copyLabel}
          tooltip={copyLabel}
          onClick={() => void copyMarkdown()}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </TooltipButton>
      )}
      {!activeEdit && props.active && props.mode === "preview" && props.selectionActions && (
        <MarkdownSelectionToolbar
          root={root}
          source={props.value}
          actions={props.selectionActions}
          resolveSelection={getSelection}
          onRequestEdit={selectionEdit.canEdit ? selectionEdit.request : undefined}
          resumeEdit={selectionEdit.resume}
        />
      )}
    </div>
  );
}

const externalUpdate = Annotation.define<boolean>();
