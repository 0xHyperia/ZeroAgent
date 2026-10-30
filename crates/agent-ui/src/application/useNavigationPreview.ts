import { useCallback, useEffect, useRef, useState } from "react";

const HOT_ZONE =
  "[data-rail-item], [data-sidebar-hover-edge], [data-cloud-sidebar-hover-edge], [data-sidebar-open], [data-cloud-sidebar-open]";
const REGION = "[data-sidebar-preview-region]";
const OPEN_LAYER =
  "[role=menu]:not([data-closed]), [data-slot=dialog-content]:not([data-closed]), [data-slot=sheet-content]:not([data-closed])";

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
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState<Destination>(committedDestination);
  const previewOpenRef = useRef(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismiss = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    previewOpenRef.current = false;
    setOpen(false);
  }, []);

  useEffect(() => {
    // Account, layout and pin changes invalidate the previous hover region.
    void owner;
    dismiss();
    if (!canPreview) return;
    let inside = false;
    let dismissedInside = false;
    let hoveredDestination = committedDestination;
    const keepOpen = () =>
      inside ||
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
      openTimer.current = setTimeout(() => {
        previewOpenRef.current = true;
        setDestination(next);
        setOpen(true);
      }, 120);
    };
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const target = event.target;
      inside =
        target instanceof Element &&
        Boolean(rootRef.current?.contains(target)) &&
        Boolean(target.closest(`${HOT_ZONE}, ${REGION}`));
      if (inside) {
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
          (!previewOpenRef.current &&
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
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        document.querySelector(OPEN_LAYER)
      )
        return;
      // Closing moves the pane out from under the pointer. Its new target can
      // be the hover edge again; wait for a real leave before allowing a peek.
      dismissedInside = true;
      const active = document.activeElement;
      if (active instanceof Element && active.closest(REGION)) {
        rootRef.current
          ?.querySelector<HTMLButtonElement>("[data-app-header-navigation] button")
          ?.focus();
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

  return { rootRef, open: canPreview && open, destination, dismiss };
}
