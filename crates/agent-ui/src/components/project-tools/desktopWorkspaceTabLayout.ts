import { useLayoutEffect, useState } from "react";

const MIN_TAB_WIDTH = 90;
const MAX_TAB_WIDTH = 240;

export function desktopWorkspaceTabWidths(
  availableWidth: number | null,
  actionWidths: readonly number[],
  lockedWidth?: number,
) {
  const minimums = actionWidths.map((width) => MIN_TAB_WIDTH + width);
  if (lockedWidth !== undefined || availableWidth === null) {
    return minimums.map((minimum) => Math.max(minimum, lockedWidth ?? MAX_TAB_WIDTH));
  }

  // Reserve wider action slots before sharing the remaining strip evenly.
  let remainingWidth = availableWidth;
  let remainingTabs = minimums.length;
  for (const minimum of [...minimums].sort((left, right) => right - left)) {
    if (minimum <= remainingWidth / remainingTabs) break;
    remainingWidth -= minimum;
    remainingTabs -= 1;
  }
  const shared = Math.min(
    MAX_TAB_WIDTH,
    Math.max(MIN_TAB_WIDTH, remainingWidth / Math.max(1, remainingTabs)),
  );
  return minimums.map((minimum) => Math.max(minimum, shared));
}

export function useDesktopWorkspaceTabMeasurements(track: HTMLDivElement | null) {
  const [measurements, setMeasurements] = useState<{
    availableWidth: number | null;
    actionWidths: Record<string, number>;
  }>({ availableWidth: null, actionWidths: {} });

  useLayoutEffect(() => {
    if (!track) return;
    const chrome = track.closest<HTMLElement>("[data-right-workspace-chrome]");
    const slot = track.closest<HTMLElement>("[data-right-workspace-tab-slot]");
    if (!chrome || !slot) return;

    const measure = () => {
      if (chrome.clientWidth <= 0) return;
      const style = getComputedStyle(chrome);
      const visibleItems = Array.from(chrome.children).filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.getClientRects().length > 0,
      );
      const fixedWidth = visibleItems.reduce((total, child) => {
        if (child === slot || child.hasAttribute("data-right-workspace-tab-spacer")) return total;
        return total + child.getBoundingClientRect().width;
      }, 0);
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const gaps = (parseFloat(style.columnGap) || 0) * Math.max(0, visibleItems.length - 1);
      const availableWidth = Math.max(
        0,
        Math.round(chrome.clientWidth - padding - gaps - fixedWidth),
      );
      const actionWidths: Record<string, number> = {};
      for (const title of track.querySelectorAll<HTMLElement>("[data-workspace-tab-label]")) {
        title.toggleAttribute("data-title-overflow", title.scrollWidth > title.clientWidth);
      }
      for (const action of track.querySelectorAll<HTMLElement>(
        "[data-desktop-workspace-tab-extra-action]",
      )) {
        const id = action.closest<HTMLElement>("[data-project-tools-tab-id]")?.dataset
          .projectToolsTabId;
        if (id) actionWidths[id] = (actionWidths[id] ?? 0) + action.offsetWidth;
      }
      setMeasurements((current) =>
        current.availableWidth === availableWidth &&
        Object.keys(current.actionWidths).length === Object.keys(actionWidths).length &&
        Object.entries(actionWidths).every(([id, width]) => current.actionWidths[id] === width)
          ? current
          : { availableWidth, actionWidths },
      );
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const observe = () => {
      resize?.disconnect();
      resize?.observe(chrome);
      for (const item of chrome.children) {
        if (item !== slot && !item.hasAttribute("data-right-workspace-tab-spacer"))
          resize?.observe(item);
      }
      for (const action of track.querySelectorAll(
        "[data-desktop-workspace-tab-extra-action], [data-workspace-tab-label]",
      ))
        resize?.observe(action);
      measure();
    };
    const children = new MutationObserver(observe);
    children.observe(chrome, { childList: true });
    children.observe(track, { childList: true, subtree: true, characterData: true });
    observe();
    return () => {
      resize?.disconnect();
      children.disconnect();
    };
  }, [track]);

  return measurements;
}
