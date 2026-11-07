import type { ComponentPropsWithRef } from "react";
import { cn } from "../lib/shared/utils";

type DivProps = ComponentPropsWithRef<"div">;

/** Layout only. Hosts retain navigation, drafts, execution and account ownership. */
export function WorkbenchShell({
  layout = "panels",
  className,
  ...props
}: DivProps & { layout?: "panels" | "stacked-panels" | "page" }) {
  return (
    <div
      {...props}
      data-workbench-layout={layout}
      className={cn(
        "app-workspace-shell workbench-shell relative size-full min-h-0 min-w-0 overflow-hidden",
        layout === "panels" ? "app-workbench-layout" : "flex",
        layout === "stacked-panels" && "flex-col",
        className,
      )}
    />
  );
}

export function WorkbenchBody({ className, ...props }: DivProps) {
  return (
    <div
      {...props}
      data-app-workbench-body=""
      className={cn("relative flex min-h-0 min-w-0 flex-1 overflow-hidden", className)}
    />
  );
}

/** One rounded surface around contextual navigation and its content. */
export function WorkbenchCanvas({
  mode = "page",
  className,
  ...props
}: DivProps & { mode?: "page" | "embedded" | "sidebar-preview" }) {
  return (
    <div
      {...props}
      data-workbench-canvas={mode === "page" ? "" : undefined}
      className={cn(
        mode === "sidebar-preview"
          ? "absolute inset-y-0 left-(--app-rail-width) z-30 flex w-0"
          : "relative flex min-h-0 min-w-0 flex-1",
        className,
      )}
    />
  );
}
