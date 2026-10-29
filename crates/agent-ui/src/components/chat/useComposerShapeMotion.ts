import { type RefObject, useLayoutEffect, useRef } from "react";

/** Retarget the current height on rapid reversals; no queued animation or editor transform. */
export function useComposerShapeMotion(
  cardRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  shape: string,
) {
  const previousHeight = useRef(0);
  const animation = useRef<Animation | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: shape is the explicit post-layout measurement signal.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!enabled || !card) return;
    const from = animation.current ? card.getBoundingClientRect().height : previousHeight.current;
    animation.current?.cancel();
    animation.current = null;
    const to = card.getBoundingClientRect().height;
    previousHeight.current = to;
    if (
      !from ||
      Math.abs(from - to) < 1 ||
      !card.animate ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const current = card.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 300,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
    animation.current = current;
    current.onfinish = () => {
      if (animation.current === current) animation.current = null;
    };
  }, [cardRef, enabled, shape]);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!enabled || !card) return;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!animation.current) previousHeight.current = card.getBoundingClientRect().height;
          });
    observer?.observe(card);
    return () => {
      observer?.disconnect();
      animation.current?.cancel();
      animation.current = null;
      previousHeight.current = 0;
    };
  }, [cardRef, enabled]);
}
