import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const HOT_ZONE =
  "[data-rail-item], [data-sidebar-hover-edge], [data-cloud-sidebar-hover-edge], [data-sidebar-open], [data-cloud-sidebar-open]";
const REGION = "[data-sidebar-preview-region]";
const UNAVAILABLE_CONTROL = "[hidden], [inert], [aria-hidden=true], [aria-disabled=true]";
const OPEN_LAYER =
  "[role=menu]:not([data-closed]), [data-slot=dialog-content]:not([data-closed]), [data-slot=sheet-content]:not([data-closed])";

function focusedPreviewControl(root: HTMLElement | null) {
  const active = root?.ownerDocument.activeElement;
  return active && root?.contains(active) && active.closest(REGION) ? active : null;
}

function focusPreviewControl(root: HTMLElement | null) {
  for (const region of root?.querySelectorAll(REGION) ?? []) {
    for (const control of region.querySelectorAll<HTMLElement>(
      "button, a[href], input:not([type=hidden]), [tabindex]",
    )) {
      if (
        control.tabIndex < 0 ||
        control.matches(":disabled") ||
        control.closest(UNAVAILABLE_CONTROL)
      )
        continue;
      control.focus({ preventScroll: true });
      if (document.activeElement === control) return;
    }
  }
}

/** A transient desktop preview never writes the pinned sidebar preference. */
export function useNavigationPreview<Destination extends string>(
  enabled: boolean,
  owner: string | number,
  {
    pinnedOpen = false,
    destination: committedDestination,
    destinations,
  }: { pinnedOpen?: boolean; destination: Destination; destinations: readonly Destination[] },
) {
  const canPreview = enabled && !pinnedOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  type Preview = { destination: Destination; trigger?: HTMLElement; owner: typeof owner };
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewRef = useRef<Preview | null>(null);
  const restoreFocusAfterDismiss = useRef<{ trigger: HTMLElement; owner: typeof owner } | null>(
    null,
  );
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismiss = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    const current = previewRef.current;
    if (current?.trigger && focusedPreviewControl(rootRef.current))
      restoreFocusAfterDismiss.current = { trigger: current.trigger, owner: current.owner };
    previewRef.current = null;
    setPreview(null);
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (preview) {
      if (canPreview && preview.owner === owner && preview.trigger) focusPreviewControl(root);
      return;
    }
    const restore = restoreFocusAfterDismiss.current;
    restoreFocusAfterDismiss.current = null;
    if (
      !canPreview ||
      !restore ||
      restore.owner !== owner ||
      !root?.contains(restore.trigger) ||
      restore.trigger.closest(UNAVAILABLE_CONTROL)
    )
      return;
    const document = root.ownerDocument;
    const active = document.activeElement;
    // Navigation may already have assigned focus to the new pane or opened a dialog.
    if (
      !document.querySelector(OPEN_LAYER) &&
      (active === document.body ||
        active === document.documentElement ||
        focusedPreviewControl(root)?.closest(UNAVAILABLE_CONTROL))
    )
      restore.trigger.focus({ preventScroll: true });
  }, [canPreview, owner, preview]);

  useEffect(() => {
    // Account, layout and pin changes invalidate the previous hover region.
    void owner;
    dismiss();
    if (!canPreview) return;
    let inside = false;
    let dismissedInside = false;
    let hoveredDestination = committedDestination;
    const focusInPreview = () => focusedPreviewControl(rootRef.current);
    const showPreview = (destination: Destination, trigger?: HTMLElement) => {
      const current = previewRef.current;
      if (!trigger && current?.destination === destination && !current.trigger) return;
      const next = { destination, trigger, owner };
      previewRef.current = next;
      setPreview(next);
    };
    const keepOpen = () =>
      inside ||
      Boolean(previewRef.current?.trigger && focusInPreview()) ||
      Boolean(rootRef.current?.querySelector(`${REGION} :focus-visible`)) ||
      Boolean(document.querySelector(OPEN_LAYER));
    const leave = () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => {
        if (!keepOpen()) dismiss();
      }, 220);
    };
    const enter = (next: Destination) => {
      clearTimeout(closeTimer.current);
      clearTimeout(openTimer.current);
      openTimer.current = setTimeout(() => showPreview(next), 120);
    };
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const target = event.target;
      inside =
        target instanceof Element &&
        Boolean(rootRef.current?.contains(target)) &&
        Boolean(target.closest(`${HOT_ZONE}, ${REGION}`));
      if (inside) {
        if (previewRef.current?.trigger && focusInPreview()) return;
        const rail = (target as Element).closest<HTMLElement>("[data-rail-item]")?.dataset.railItem;
        if (rail && !destinations.includes(rail as Destination)) {
          inside = false;
          leave();
          return;
        }
        if (rail && destinations.includes(rail as Destination))
          hoveredDestination = rail as Destination;
        else if (
          (target as Element).closest("[data-sidebar-open], [data-cloud-sidebar-open]") ||
          // The edge bridges the rail and the floating pane. Only a fresh
          // entry opens the current page; crossing it must keep the preview.
          (!previewRef.current &&
            (target as Element).closest(
              "[data-sidebar-hover-edge], [data-cloud-sidebar-hover-edge]",
            ))
        )
          hoveredDestination = committedDestination;
        if (!dismissedInside) enter(hoveredDestination);
      } else {
        dismissedInside = false;
        leave();
      }
    };
    const onExit = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && !event.relatedTarget) {
        inside = false;
        dismissedInside = false;
        leave();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        document.querySelector(OPEN_LAYER)
      )
        return;
      if (
        event.key === "ArrowRight" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        const trigger = document.activeElement?.closest<HTMLElement>("[data-rail-item]");
        const next = trigger?.dataset.railItem as Destination | undefined;
        if (
          !trigger ||
          !next ||
          !rootRef.current?.contains(trigger) ||
          !destinations.includes(next)
        )
          return;
        event.preventDefault();
        clearTimeout(openTimer.current);
        clearTimeout(closeTimer.current);
        hoveredDestination = next;
        showPreview(next, trigger);
        return;
      }
      if (event.key !== "Escape") return;
      // Closing moves the pane out from under the pointer. Its new target can
      // be the hover edge again; wait for a real leave before allowing a peek.
      dismissedInside = true;
      if (focusInPreview()) {
        const trigger = previewRef.current?.trigger;
        if (trigger && rootRef.current?.contains(trigger)) {
          event.preventDefault();
          trigger.focus({ preventScroll: true });
        } else {
          rootRef.current
            ?.querySelector<HTMLButtonElement>(
              "[data-app-header-navigation] button, [data-rail-item][aria-current=page]",
            )
            ?.focus();
        }
      }
      inside = false;
      dismiss();
    };
    let layerOpen = Boolean(document.querySelector(OPEN_LAYER));
    const observer = new MutationObserver(() => {
      const nextLayerOpen = Boolean(document.querySelector(OPEN_LAYER));
      if (layerOpen && !nextLayerOpen && !inside && !keepOpen()) leave();
      layerOpen = nextLayerOpen;
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-closed"],
    });
    document.addEventListener("pointerover", onPointer);
    document.addEventListener("pointerout", onExit);
    document.addEventListener("focusout", leave);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
      observer.disconnect();
      document.removeEventListener("pointerover", onPointer);
      document.removeEventListener("pointerout", onExit);
      document.removeEventListener("focusout", leave);
      window.removeEventListener("keydown", onKey);
    };
  }, [dismiss, canPreview, owner, committedDestination, destinations]);

  return {
    rootRef,
    open: canPreview && preview?.owner === owner,
    destination: preview?.owner === owner ? preview.destination : committedDestination,
    previewableIds: canPreview ? destinations : undefined,
    dismiss,
  };
}
