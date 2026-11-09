import { type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConversationFocusComposer } from "./conversationReaderLayout";

/** Keep one React composer and move its portal container between the two layouts. */
export function ConversationComposerPlacement({ children }: { children: ReactNode }) {
  const focus = useContext(ConversationFocusComposer);
  const home = useRef<HTMLDivElement>(null);
  const animation = useRef<Animation | null>(null);
  const [mount] = useState(() => {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  const target = focus?.target;

  useLayoutEffect(() => {
    const next = target ?? home.current;
    if (!mount || !next || mount.parentNode === next) return;
    const composer = mount.firstElementChild;
    const card = composer?.querySelector("[data-composer-single-line]") ?? composer;
    // Read the visible position before cancelling a move that may still be in flight.
    const before = card?.isConnected ? card.getBoundingClientRect() : null;
    if (target && before?.width)
      target.style.setProperty("--za-image-composer-width", `${before.width}px`);
    animation.current?.cancel();
    const active = mount.contains(document.activeElement) ? document.activeElement : null;
    next.append(mount);
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    if (
      !before?.width ||
      !composer?.animate ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const after = card?.getBoundingClientRect();
    if (!after?.width) return;
    const x = before.left + before.width / 2 - after.left - after.width / 2;
    const y = before.bottom - after.bottom;
    if (Math.abs(x) < 1 && Math.abs(y) < 1) return;
    animation.current = composer.animate(
      [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }],
      { duration: 170, easing: "cubic-bezier(.2,.75,.3,1)" },
    );
  }, [mount, target]);

  useLayoutEffect(
    () => () => {
      animation.current?.cancel();
      mount?.remove();
    },
    [mount],
  );

  return (
    <div ref={home} style={{ display: "contents" }}>
      {mount ? createPortal(children, mount) : children}
    </div>
  );
}
