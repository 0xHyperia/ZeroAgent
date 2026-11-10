import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../lib/shared/utils";

type DivProps = ComponentPropsWithRef<"div">;

/** Layout only. Hosts retain navigation, drafts, execution and account ownership. */
export function WorkbenchShell({
  layout = "panels",
  navigationRail,
  children,
  className,
  ...props
}: DivProps & { layout?: "panels" | "stacked-panels" | "page"; navigationRail?: ReactNode }) {
  return (
    <div
      {...props}
      data-workbench-layout={layout}
      className={cn(
        "app-workspace-shell workbench-shell relative flex size-full min-h-0 min-w-0 overflow-hidden",
        layout === "stacked-panels" && "flex-col",
        className,
      )}
    >
      {layout === "panels" ? (
        <>
          {navigationRail}
          <div
            data-workbench-frame=""
            className="app-workbench-layout relative min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {children}
          </div>
        </>
      ) : (
        children
      )}
    </div>
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
      data-workbench-page-canvas={mode === "page" ? "" : undefined}
      className={cn(
        mode === "sidebar-preview"
          ? "absolute inset-y-0 left-(--app-rail-width) z-30 flex w-0"
          : "relative flex min-h-0 min-w-0 flex-1",
        className,
      )}
    />
  );
}
