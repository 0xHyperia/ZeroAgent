import { type ComponentPropsWithoutRef, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileDropPrompt } from "./FileDropPrompt";

type Props = Omit<
  ComponentPropsWithoutRef<"section">,
  "onDrop" | "onDragEnter" | "onDragOver" | "onDragLeave"
> & {
  active?: boolean;
  coverage?: "local" | "viewport";
  resetKey?: string;
  disabledReason?: string;
  resourceDisabledReason?: string;
  fileLabel: string;
  resourceLabel?: string;
  hint?: string;
  resourceMime?: string;
  onFiles?: (files: File[], directories: number) => void;
  onResources?: (transfer: DataTransfer) => void;
  onRejected: (reason: string) => void;
};

/** Only presentation and drag lifetime. The host owns authorization, uploads and drafts. */
export function FileDropBoundary({
  active = true,
  coverage = "local",
  resetKey,
  disabledReason,
  resourceDisabledReason,
  fileLabel,
  resourceLabel,
  hint,
  resourceMime,
  onFiles,
  onResources,
  onRejected,
  children,
  className,
  ...section
}: Props) {
  const [kind, setKind] = useState<"files" | "resources" | null>(null);
  const depth = useRef(0);
  const clear = useCallback(() => {
    depth.current = 0;
    setKind(null);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: active and identity changes retire the previous drag lifetime.
  useEffect(() => {
    clear();
  }, [active, resetKey, clear]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    window.addEventListener("blur", clear);
    window.addEventListener("dragend", clear);
    if (coverage !== "viewport") window.addEventListener("drop", clear, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("blur", clear);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("keydown", key);
    };
  }, [clear, coverage]);
  const classify = useCallback(
    (transfer: DataTransfer) => {
      if (!active) return null;
      const types = Array.from(transfer.types);
      // Preserve existing workspace path and conversation-reference handlers, even for mixed payloads.
      if (types.some((type) => type.startsWith("application/x-liveagent-"))) return null;
      if (resourceMime && onResources && types.includes(resourceMime)) return "resources";
      return onFiles && types.includes("Files") ? "files" : null;
    },
    [active, resourceMime, onResources, onFiles],
  );
  const reasonFor = useCallback(
    (target: "files" | "resources" | null) =>
      target === "resources" && resourceDisabledReason !== undefined
        ? resourceDisabledReason
        : disabledReason,
    [resourceDisabledReason, disabledReason],
  );
  const consume = useCallback(
    (transfer: DataTransfer, next: "files" | "resources") => {
      // Read while the native drop store is open, before retiring any portal/target.
      const reason = reasonFor(next);
      if (reason) onRejected(reason);
      else if (next === "resources") onResources?.(transfer);
      else {
        let directories = 0;
        const files: File[] = [];
        for (const item of Array.from(transfer.items ?? [])) {
          if (item.kind !== "file") continue;
          if (item.webkitGetAsEntry?.()?.isDirectory) directories++;
          else {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        }
        onFiles?.(files.length || directories ? files : Array.from(transfer.files), directories);
      }
      clear();
    },
    [reasonFor, onRejected, onResources, onFiles, clear],
  );
  useEffect(() => {
    if (!active || coverage !== "viewport") return;
    // One native owner spans the React root AND the body portal. In particular,
    // a window capture clear must not unmount the drop target before React sees drop.
    const over = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      const next = classify(event.dataTransfer);
      if (!next) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = reasonFor(next) ? "none" : "copy";
      setKind(next);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      const next = classify(event.dataTransfer);
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      consume(event.dataTransfer, next);
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget || !event.dataTransfer || !classify(event.dataTransfer)) return;
      // A portal hand-off can report (0,0). Only the document boundary denotes exit.
      if (
        (event.target === document.documentElement || event.target === document) &&
        (event.clientX <= 0 ||
          event.clientY <= 0 ||
          event.clientX >= window.innerWidth ||
          event.clientY >= window.innerHeight)
      )
        clear();
    };
    window.addEventListener("dragenter", over, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("drop", drop, true);
    return () => {
      window.removeEventListener("dragenter", over, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("drop", drop, true);
    };
  }, [active, coverage, classify, reasonFor, consume, clear]);
  const visibleReason = reasonFor(kind);
  const prompt = kind ? (
    <FileDropPrompt
      blocked={Boolean(visibleReason)}
      title={visibleReason || (kind === "resources" ? resourceLabel || fileLabel : fileLabel)}
      hint={visibleReason ? "现有草稿和任务会保留" : hint}
      viewport={coverage === "viewport"}
    />
  ) : null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: optional drag enhancement; all operations retain host-provided buttons.
    <section
      {...section}
      className={`${className ?? ""} za-file-drop-boundary`}
      data-file-drop-boundary=""
      onDragEnter={(event) => {
        if (coverage === "viewport") return;
        const next = classify(event.dataTransfer);
        if (!next || event.defaultPrevented) return;
        event.preventDefault();
        depth.current++;
        setKind(next);
      }}
      onDragOver={(event) => {
        if (coverage === "viewport") return;
        const next = classify(event.dataTransfer);
        if (!next || event.defaultPrevented) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = reasonFor(next) ? "none" : "copy";
        setKind(next);
      }}
      onDragLeave={(event) => {
        if (coverage === "viewport") return;
        if (!classify(event.dataTransfer)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setKind(null);
      }}
      onDrop={(event) => {
        if (coverage === "viewport") return;
        const next = classify(event.dataTransfer);
        if (!next || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        consume(event.dataTransfer, next);
      }}
    >
      {children}
      {coverage === "viewport" && prompt ? createPortal(prompt, document.body) : prompt}
    </section>
  );
}
