import { type RefObject, useLayoutEffect, useState } from "react";
import type { MentionComposerHandle } from "./MentionComposer";

/** Measures plain text, never clones or remounts the editor that owns the draft. */
export function useInlineComposerLayout({
  enabled,
  expanded,
  hasAttachments,
  isEmpty,
  cardRef,
  composerRef,
}: {
  enabled: boolean;
  expanded: boolean;
  hasAttachments: boolean;
  isEmpty: boolean;
  cardRef: RefObject<HTMLElement | null>;
  composerRef: RefObject<MentionComposerHandle | null>;
}) {
  const [singleLine, setSingleLine] = useState(true);
  // isEmpty also invalidates measurement after imperative clear/setText.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isEmpty is an intentional measurement signal.
  useLayoutEffect(() => {
    if (!enabled) return;
    const card = cardRef.current;
    const editor = card?.querySelector<HTMLElement>(".mention-composer");
    if (!card || !editor) return;
    if (expanded || hasAttachments) {
      setSingleLine(false);
      return;
    }
    const measure = document.createElement("span");
    measure.setAttribute("aria-hidden", "true");
    Object.assign(measure.style, {
      position: "fixed",
      visibility: "hidden",
      whiteSpace: "pre",
      pointerEvents: "none",
      insetInlineStart: "-100000px",
      top: "0",
    });
    document.body.append(measure);
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const text =
        composerRef.current?.getDraft().textWithoutLargePastes ?? editor.textContent ?? "";
      const style = getComputedStyle(editor);
      measure.style.font = style.font || `${style.fontSize} ${style.fontFamily}`;
      measure.style.letterSpacing = style.letterSpacing;
      measure.textContent = text;
      const leading = card.querySelector<HTMLElement>("[data-composer-leading]");
      const trailing = card.querySelector<HTMLElement>("[data-composer-trailing]");
      card.style.setProperty("--composer-leading-width", `${leading?.offsetWidth ?? 36}px`);
      card.style.setProperty("--composer-trailing-width", `${trailing?.offsetWidth ?? 160}px`);
      const available =
        card.clientWidth - (leading?.offsetWidth ?? 36) - (trailing?.offsetWidth ?? 160) - 32;
      const fits =
        !text.includes("\n") &&
        !editor.querySelector('[contenteditable="false"]') &&
        measure.getBoundingClientRect().width <= Math.max(0, available);
      setSingleLine(fits);
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    update();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(card);
    const trailing = card.querySelector<HTMLElement>("[data-composer-trailing]");
    if (trailing) resize?.observe(trailing);
    const mutation = new MutationObserver(schedule);
    mutation.observe(editor, { subtree: true, childList: true, characterData: true });
    editor.addEventListener("input", schedule);
    window.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation.disconnect();
      measure.remove();
      editor.removeEventListener("input", schedule);
      window.removeEventListener("resize", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
      card.style.removeProperty("--composer-leading-width");
      card.style.removeProperty("--composer-trailing-width");
    };
  }, [enabled, expanded, hasAttachments, isEmpty, cardRef, composerRef]);
  return enabled && !expanded && !hasAttachments && singleLine;
}
