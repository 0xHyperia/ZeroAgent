import "../../lib/monacoWorkers";
import { useContext, useEffect, useRef, useState } from "react";
import * as monaco from "../../lib/monacoEditor";
import { prepareSourceSyntax, refreshSourceSyntax } from "../../lib/sourceSyntax";
import { PreviewIdentityContext } from "./PreviewChrome";
import { bindReaderZoom } from "./readerZoom";
import { usePreviewReadingState } from "./readingSession";

export default function ResourceSourceEditor(props: {
  text: string;
  name: string;
  language: string;
  wrap: boolean;
  zoom: number;
  onZoom: (zoom: number) => void;
  assertCurrent: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [syntaxError, setSyntaxError] = useState(false);
  const [retry, setRetry] = useState(0);
  const identity = useContext(PreviewIdentityContext);
  const requestedLine = identity.sourceRange?.fromLine;
  const fromLine =
    Number.isSafeInteger(requestedLine) && (requestedLine ?? 0) > 0 ? requestedLine : undefined;
  const requestedEnd = identity.sourceRange?.toLine;
  const toLine =
    Number.isSafeInteger(requestedEnd) && (requestedEnd ?? 0) > 0 ? requestedEnd : undefined;
  const [line, setLine] = usePreviewReadingState("sourceLine", 1);
  const [left, setLeft] = usePreviewReadingState("sourceLeft", 0);
  const latest = useRef({ ...props, line, left, setLine, setLeft });
  latest.current = { ...props, line, left, setLine, setLeft };
  // Bytes, language and model lifetime are owned by the keyed ResourcePreview instance.
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    props.assertCurrent();
    const initial = latest.current;
    const model = monaco.editor.createModel(props.text, "plaintext");
    const instance = monaco.editor.create(node, {
      model,
      readOnly: true,
      readOnlyMessage: { value: "原文为只读视图" },
      domReadOnly: true,
      ariaLabel: `${props.name}原文（只读）`,
      automaticLayout: true,
      fontSize: (13 * initial.zoom) / 100,
      lineHeight: (21 * initial.zoom) / 100,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontLigatures: false,
      minimap: { enabled: false },
      folding: false,
      glyphMargin: false,
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 12,
      renderLineHighlight: "none",
      renderValidationDecorations: "off",
      renderWhitespace: "none",
      // Keep long/minified originals readable; only expensive tokenization is capped.
      stopRenderingLineAfter: -1,
      maxTokenizationLineLength: 20_000,
      wordWrap: initial.wrap ? "on" : "off",
      wrappingIndent: "none",
      wordWrapBreakAfterCharacters: "\t )}，。；：、,;",
      contextmenu: false,
      links: false,
      hover: { enabled: "off" },
      occurrencesHighlight: "off",
      selectionHighlight: false,
      codeLens: false,
      colorDecorators: false,
      stickyScroll: { enabled: false },
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      matchBrackets: "never",
      guides: { indentation: false, highlightActiveIndentation: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      mouseWheelZoom: false,
      scrollbar: {
        verticalScrollbarSize: 6,
        horizontalScrollbarSize: 6,
        useShadows: false,
        verticalHasArrows: false,
        horizontalHasArrows: false,
        alwaysConsumeMouseWheel: true,
      },
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      padding: { top: 8, bottom: 24 },
      tabSize: 2,
      unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false },
      theme: document.documentElement.classList.contains("dark") ? "vs-dark" : "vs",
    });
    editor.current = instance;
    const start = Math.min(model.getLineCount(), Math.max(1, fromLine ?? latest.current.line));
    instance.revealLineNearTop(start, monaco.editor.ScrollType.Immediate);
    instance.setScrollLeft(latest.current.left);
    if (fromLine !== undefined)
      instance.createDecorationsCollection([
        {
          range: new monaco.Range(
            start,
            1,
            Math.min(model.getLineCount(), Math.max(start, toLine ?? start)),
            model.getLineMaxColumn(
              Math.min(model.getLineCount(), Math.max(start, toLine ?? start)),
            ),
          ),
          options: { isWholeLine: true, className: "za-source-linked-line" },
        },
      ]);
    const theme = new MutationObserver(() => {
      refreshSourceSyntax(monaco);
      monaco.editor.setTheme(
        document.documentElement.classList.contains("dark") ? "vs-dark" : "vs",
      );
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const stopZoom = bindReaderZoom(
      node,
      () => latest.current.zoom,
      200,
      (value) => latest.current.onZoom(typeof value === "number" ? Math.max(75, value) : 100),
      { capture: true, readOnlyTextInput: true, minimum: 75 },
    );
    node.dataset.sourceReady = "true";
    return () => {
      const top = instance.getVisibleRanges()[0]?.startLineNumber ?? 1;
      latest.current.setLine(top);
      latest.current.setLeft(instance.getScrollLeft());
      delete node.dataset.sourceReady;
      stopZoom();
      theme.disconnect();
      instance.dispose();
      model.dispose();
      editor.current = null;
    };
  }, [props.text, props.name, props.assertCurrent, fromLine, toLine]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: also reapply after model replacement, range navigation or explicit retry.
  useEffect(() => {
    let current = true;
    const instance = editor.current;
    const model = instance?.getModel();
    if (!model) return;
    setSyntaxError(false);
    if (container.current) container.current.dataset.syntaxStatus = "loading";
    void prepareSourceSyntax(props.language, monaco)
      .then((language) => {
        if (!current || model.isDisposed()) return;
        props.assertCurrent();
        monaco.editor.setModelLanguage(model, language);
        if (container.current) container.current.dataset.syntaxStatus = "ready";
      })
      .catch(() => {
        if (!current || model.isDisposed()) return;
        if (container.current) container.current.dataset.syntaxStatus = "unavailable";
        setSyntaxError(true);
      });
    return () => {
      current = false;
    };
  }, [props.language, props.text, props.name, props.assertCurrent, fromLine, toLine, retry]);
  useEffect(() => {
    editor.current?.updateOptions({ wordWrap: props.wrap ? "on" : "off" });
  }, [props.wrap]);
  useEffect(() => {
    editor.current?.updateOptions({
      fontSize: (13 * props.zoom) / 100,
      lineHeight: (21 * props.zoom) / 100,
    });
  }, [props.zoom]);
  return (
    <div className="za-source-editor-frame">
      <div ref={container} className="za-source-editor" />
      {syntaxError ? (
        <div className="za-source-syntax-error" role="status">
          语法高亮加载失败，原文已保留。
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : null}
    </div>
  );
}
