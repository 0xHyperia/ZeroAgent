import { generateDiffFile } from "@git-diff-view/file";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import { Loader2 } from "../IconSet";
import { Button } from "../ui/button";
import type { MarkdownSelectionEdit } from "./useWorkspaceMarkdownSelectionEdit";

export default function WorkspaceMarkdownSelectionReview({
  edit,
  theme,
  onAccept,
  onReject,
  onEditInstruction,
}: {
  edit: MarkdownSelectionEdit;
  theme: "light" | "dark";
  onAccept: () => void;
  onReject: () => void;
  onEditInstruction: () => void;
}) {
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const pending = edit.phase === "pending";
  const full = edit.phase === "review" && !edit.inline;
  const before = pending ? edit.original : (edit.documentDiff?.before ?? edit.original);
  const preview = pending ? undefined : (edit.documentDiff?.after ?? edit.replacement);
  const [wrap, setWrap] = useState(true);
  const panel = useRef<HTMLElement>(null);
  const diffFile = useMemo(() => {
    if (
      preview === undefined ||
      before.split("\n", 5001).length > 5000 ||
      preview.split("\n", 5001).length > 5000
    )
      return null;
    try {
      const file = generateDiffFile(
        "selection.md",
        before,
        "selection.md",
        preview,
        "markdown",
        "markdown",
        {
          context: Infinity,
        },
      );
      file.initTheme(theme);
      file.init();
      file.buildUnifiedDiffLines();
      return file;
    } catch {
      return null;
    }
  }, [before, preview, theme]);
  useEffect(() => {
    if (full) panel.current?.focus({ preventScroll: true });
  }, [full]);

  if (pending) {
    return (
      <div data-workspace-markdown-edit="pending" className="za-md-edit-pending">
        <span role="status" className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          {copy("正在修改选区…", "Editing selection…")}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={onReject}>
          {copy("取消", "Cancel")}
        </Button>
      </div>
    );
  }

  return (
    <section
      ref={panel}
      tabIndex={full ? -1 : undefined}
      aria-label={copy("选区修改预览", "Selection edit review")}
      data-workspace-markdown-edit={full ? "full" : "inline"}
      className="za-md-edit-review"
    >
      <header className="za-md-edit-review-title">
        {copy("选区修改预览", "Selection edit review")}
      </header>
      <section
        className="za-md-edit-review-diff"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: A potentially long diff must remain keyboard-scrollable.
        tabIndex={0}
        aria-label={copy("修改差异", "Proposed changes")}
      >
        {diffFile ? (
          <DiffView
            diffFile={diffFile}
            diffViewMode={DiffModeEnum.Unified}
            diffViewTheme={theme}
            diffViewHighlight={false}
            diffViewWrap={wrap}
            diffViewFontSize={13}
          />
        ) : (
          <>
            <pre className="whitespace-pre-wrap bg-rose-500/10 p-2">{edit.original}</pre>
            <pre className="whitespace-pre-wrap bg-emerald-500/10 p-2">{edit.replacement}</pre>
          </>
        )}
      </section>
      <footer className="za-md-edit-review-actions">
        {full && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            {copy("自动换行", "Wrap lines")}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={onEditInstruction}>
          {copy("修改要求", "Edit instruction")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="text-destructive"
          onClick={onReject}
        >
          {copy("拒绝", "Reject")}
        </Button>
        <Button type="button" size="sm" onClick={onAccept}>
          {copy("接受", "Accept")}
        </Button>
      </footer>
    </section>
  );
}
