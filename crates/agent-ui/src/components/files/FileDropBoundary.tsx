import { FileText, Upload } from "@liveagent/ui/components/IconSet";
import { type ComponentPropsWithoutRef, useCallback, useEffect, useRef, useState } from "react";

type Props = Omit<
  ComponentPropsWithoutRef<"section">,
  "onDrop" | "onDragEnter" | "onDragOver" | "onDragLeave"
> & {
  active?: boolean;
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
    window.addEventListener("drop", clear, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("blur", clear);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("keydown", key);
    };
  }, [clear]);
  function classify(transfer: DataTransfer) {
    if (!active) return null;
    const types = Array.from(transfer.types);
    // Preserve existing workspace path and conversation-reference handlers, even for mixed payloads.
    if (types.some((type) => type.startsWith("application/x-liveagent-"))) return null;
    if (resourceMime && onResources && types.includes(resourceMime)) return "resources";
    return onFiles && types.includes("Files") ? "files" : null;
  }
  const reasonFor = (target: "files" | "resources" | null) =>
    target === "resources" && resourceDisabledReason !== undefined
      ? resourceDisabledReason
      : disabledReason;
  const visibleReason = reasonFor(kind);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: optional drag enhancement; all operations retain host-provided buttons.
    <section
      {...section}
      className={`${className ?? ""} za-file-drop-boundary`}
      data-file-drop-boundary=""
      onDragEnter={(event) => {
        const next = classify(event.dataTransfer);
        if (!next || event.defaultPrevented) return;
        event.preventDefault();
        depth.current++;
        setKind(next);
      }}
      onDragOver={(event) => {
        const next = classify(event.dataTransfer);
        if (!next || event.defaultPrevented) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = reasonFor(next) ? "none" : "copy";
        setKind(next);
      }}
      onDragLeave={(event) => {
        if (!classify(event.dataTransfer)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setKind(null);
      }}
      onDrop={(event) => {
        const next = classify(event.dataTransfer);
        if (!next || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        clear();
        const reason = reasonFor(next);
        if (reason) {
          onRejected(reason);
          return;
        }
        if (next === "resources") {
          onResources?.(event.dataTransfer);
          return;
        }
        let directories = 0;
        const files: File[] = [];
        for (const item of Array.from(event.dataTransfer.items ?? [])) {
          if (item.kind !== "file") continue;
          if (item.webkitGetAsEntry?.()?.isDirectory) {
            directories++;
            continue;
          }
          const file = item.getAsFile();
          if (file) files.push(file);
        }
        onFiles?.(
          files.length || directories ? files : Array.from(event.dataTransfer.files),
          directories,
        );
      }}
    >
      {children}
      {kind ? (
        <div className="za-file-drop-overlay" data-blocked={Boolean(visibleReason)} role="status">
          {kind === "resources" ? <FileText className="size-8" /> : <Upload className="size-8" />}
          <strong>{visibleReason || (kind === "resources" ? resourceLabel : fileLabel)}</strong>
          <span>{visibleReason ? "现有草稿和任务会保留" : hint}</span>
        </div>
      ) : null}
    </section>
  );
}
