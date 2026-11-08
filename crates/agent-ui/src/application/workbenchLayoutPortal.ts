import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Place a workbench surface in its host's layout without adding a DOM wrapper. */
export function mountWorkbenchLayout(
  surface: ReactNode,
  target: HTMLElement,
  slot: "account-content" | "account-sidebar" | "task-result" | "task-header" | "task-inspector",
) {
  return createPortal(surface, target, slot);
}
