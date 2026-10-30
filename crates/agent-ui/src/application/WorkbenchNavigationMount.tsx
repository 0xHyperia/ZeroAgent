import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Reuses the owning rail in settings without resizing the background workspace. */
export function WorkbenchNavigationMount({
  target,
  children,
}: {
  target?: HTMLElement | null;
  children: ReactNode;
}) {
  return target ? (
    <>
      <div data-navigation-rail-placeholder="" aria-hidden="true" />
      {createPortal(children, target)}
    </>
  ) : (
    children
  );
}
