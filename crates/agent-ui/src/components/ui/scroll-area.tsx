import * as React from "react";
import { cn } from "../../lib/shared/utils";
import "./scroll-area.css";

/** Layout wrapper only: refs, scroll events and browser gestures belong to the viewport. */
export const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div"> & {
    viewportRef?: React.Ref<HTMLDivElement>;
    contentClassName?: string;
    viewportProps?: React.ComponentPropsWithoutRef<"div">;
    horizontal?: boolean;
  }
>(function ScrollArea(
  { className, children, viewportRef, contentClassName, viewportProps, horizontal, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-scroll-area-root
      className={cn("scroll-area-root relative overflow-hidden", className)}
      {...props}
    >
      <div
        ref={viewportRef}
        role="region"
        aria-label="滚动内容"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: A scroll viewport needs keyboard focus for native PageUp/PageDown/Home/End in WebViews.
        tabIndex={0}
        {...viewportProps}
        className={cn(
          "za-native-scroll size-full rounded-inherit [overflow-anchor:none]",
          horizontal ? "overflow-auto" : "overflow-y-auto overflow-x-hidden",
          viewportProps?.className,
        )}
        data-scroll-viewport
      >
        <div className={cn("[overflow-anchor:none]", contentClassName)}>{children}</div>
      </div>
    </div>
  );
});
ScrollArea.displayName = "ScrollArea";
