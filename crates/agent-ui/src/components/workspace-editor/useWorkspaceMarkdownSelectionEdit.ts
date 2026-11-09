import { isolateHistory } from "@codemirror/commands";
import { type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ProjectToolTextGenerationClient } from "../../lib/ai/projectToolTextGeneration";
import type {
  MarkdownEditResume,
  MarkdownToolbarSelection,
} from "../resource-preview/MarkdownSelectionToolbar";
import { applyWorkspaceMarkdownEdits } from "./workspaceMarkdownDocument";
import {
  isInlineMarkdownEdit,
  markdownEditRequest,
  markdownEditWithinFileLimit,
  parseMarkdownEditReplacement,
  type WorkspaceMarkdownEditRange,
} from "./workspaceMarkdownSelectionEdit";

type EditSnapshot = {
  selection: MarkdownToolbarSelection;
  range: WorkspaceMarkdownEditRange;
  instruction: string;
  original: string;
};

export type MarkdownSelectionEdit =
  | (EditSnapshot & { phase: "pending"; inline: boolean })
  | (EditSnapshot & {
      phase: "review";
      replacement: string;
      inline: boolean;
      documentDiff?: { before: string; after: string };
    });

class MarkdownReviewWidget extends WidgetType {
  constructor(private readonly setHost: (host: HTMLElement | null) => void) {
    super();
  }

  eq(other: MarkdownReviewWidget) {
    return this.setHost === other.setHost;
  }

  toDOM(view: EditorView) {
    const host = view.dom.ownerDocument.createElement("div");
    host.className = "za-markdown-review-widget";
    queueMicrotask(() => {
      if (host.isConnected) this.setHost(host);
    });
    return host;
  }

  destroy(host: HTMLElement) {
    queueMicrotask(() => {
      if (!host.isConnected) this.setHost(null);
    });
  }
}

type EditDecoration = {
  from: number;
  to: number;
  phase: MarkdownSelectionEdit["phase"];
  widget?: MarkdownReviewWidget;
};

const showEdit = StateEffect.define<EditDecoration | null>();

export const markdownSelectionEditField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(previous, transaction) {
    let next = transaction.docChanged ? Decoration.none : previous;
    for (const effect of transaction.effects) {
      if (!effect.is(showEdit)) continue;
      const value = effect.value;
      if (!value || transaction.docChanged) {
        next = Decoration.none;
        continue;
      }
      const { from, to, phase, widget } = value;
      const decorations: Range<Decoration>[] = [
        Decoration.mark({ class: `za-md-selection-${phase}` }).range(from, to),
      ];
      if (widget) {
        const line = transaction.newDoc.lineAt(to - 1);
        decorations.push(Decoration.widget({ widget, block: true, side: 1 }).range(line.to));
      }
      next = Decoration.set(decorations, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function useWorkspaceMarkdownSelectionEdit({
  editor,
  rawDraft,
  generation,
  enabled,
  failureMessage,
}: {
  editor: RefObject<EditorView | null>;
  rawDraft: RefObject<string>;
  generation?: ProjectToolTextGenerationClient;
  enabled: boolean;
  failureMessage: string;
}) {
  const revision = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const [edit, setEdit] = useState<MarkdownSelectionEdit | null>(null);
  const currentEdit = useRef<MarkdownSelectionEdit | null>(null);
  const [resume, setResume] = useState<MarkdownEditResume>();
  const [inlineHost, setInlineHost] = useState<HTMLElement | null>(null);
  const canEdit = enabled && Boolean(generation && generation.status?.() !== "unconfigured");
  const allowed = useRef(canEdit);
  allowed.current = canEdit;

  const updateEdit = useCallback((next: MarkdownSelectionEdit | null) => {
    currentEdit.current = next;
    setEdit(next);
  }, []);
  const clear = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
    updateEdit(null);
    setResume(undefined);
  }, [updateEdit]);
  const discard = useCallback(
    (restoreFocus = false) => {
      clear();
      const view = editor.current;
      view?.dispatch({ effects: showEdit.of(null) });
      if (restoreFocus) view?.focus();
    },
    [clear, editor],
  );

  useLayoutEffect(() => {
    if (!canEdit && currentEdit.current) discard();
    else if (!canEdit) setResume(undefined);
  }, [canEdit, discard]);

  useLayoutEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useLayoutEffect(() => {
    if (!edit || !canEdit) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(event.target instanceof Node)) return;
      const surface = editor.current?.dom.closest(".za-workspace-markdown-editor");
      if (!surface?.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      discard(true);
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [canEdit, discard, edit, editor]);

  const changed = () => {
    revision.current++;
    if (currentEdit.current || pending.current) clear();
    else setResume(undefined);
  };

  const request = async (selection: MarkdownToolbarSelection, instruction: string) => {
    const view = editor.current;
    const range = selection.editRange;
    if (!generation || !allowed.current || !view || !range || range.revision !== revision.current)
      return;
    const payload = markdownEditRequest(view.state.doc.toString(), range, instruction);
    if (!payload) return;
    discard();
    const controller = new AbortController();
    pending.current = controller;
    const snapshot = { selection, range, instruction, original: payload.selected };
    const show = (state: MarkdownSelectionEdit, inline: boolean) => {
      view.dispatch({
        effects: showEdit.of({
          from: range.from,
          to: range.to,
          phase: state.phase,
          widget: inline ? new MarkdownReviewWidget(setInlineHost) : undefined,
        }),
      });
      updateEdit(state);
    };
    const inlinePending = isInlineMarkdownEdit(payload.selected, "");
    show({ ...snapshot, phase: "pending", inline: inlinePending }, inlinePending);
    view.focus();
    const sameDocument = () =>
      pending.current === controller &&
      !controller.signal.aborted &&
      allowed.current &&
      editor.current === view &&
      revision.current === range.revision;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
      const response = await generation.generate({ ...payload.request, signal });
      if (!sameDocument()) return;
      signal.throwIfAborted();
      const replacement = parseMarkdownEditReplacement(response, payload.selected);
      if (
        replacement === null ||
        !markdownEditWithinFileLimit(
          applyWorkspaceMarkdownEdits(rawDraft.current, [{ ...range, insert: replacement }]),
        )
      )
        throw new Error("Invalid Markdown selection edit");
      const inline = isInlineMarkdownEdit(payload.selected, replacement);
      const document = view.state.doc;
      const candidateLength = document.length - payload.selected.length + replacement.length;
      const showWholeFile =
        !inline &&
        document.length <= 262_144 &&
        candidateLength <= 262_144 &&
        document.lines <= 5_000;
      const documentDiff = showWholeFile
        ? {
            before: document.toString(),
            after: `${document.sliceString(0, range.from)}${replacement}${document.sliceString(range.to)}`,
          }
        : undefined;
      show({ ...snapshot, phase: "review", replacement, inline, documentDiff }, inline);
      pending.current = null;
    } catch {
      if (!sameDocument()) return;
      discard();
      setResume({ selection, instruction, error: failureMessage });
    }
  };

  const accept = () => {
    const view = editor.current;
    const active = currentEdit.current;
    if (!view || !allowed.current || active?.phase !== "review") return;
    const { range, original, replacement } = active;
    if (
      revision.current !== range.revision ||
      view.state.sliceDoc(range.from, range.to) !== original
    ) {
      discard();
      return;
    }
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: replacement },
      selection: { anchor: range.from + replacement.length },
      effects: showEdit.of(null),
      annotations: isolateHistory.of("full"),
      userEvent: "input.markdown-selection-edit",
    });
    view.focus();
  };

  const editInstruction = () => {
    const active = currentEdit.current;
    if (!active) return;
    discard();
    setResume({ selection: active.selection, instruction: active.instruction });
  };

  return {
    canEdit,
    revision,
    edit,
    inlineHost,
    resume,
    request,
    changed,
    accept,
    discard,
    editInstruction,
  };
}
