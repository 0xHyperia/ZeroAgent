import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react";
import * as React from "react";

import { cn } from "../../lib/shared/utils";
import "./scroll-area.css";

export const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    viewportRef?: React.Ref<HTMLDivElement>;
    contentClassName?: string;
    viewportProps?: Omit<
      React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport>,
      "render"
    >;
    horizontal?: boolean;
  }
>(
  (
    { className, children, viewportRef, contentClassName, viewportProps, horizontal, ...props },
    ref,
  ) => (
    <ScrollAreaPrimitive.Root
      ref={ref}
      data-scroll-area-root
      className={cn("scroll-area-root relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        {...viewportProps}
        className={cn("size-full rounded-inherit [overflow-anchor:none]", viewportProps?.className)}
        data-scroll-viewport
      >
        <ScrollAreaPrimitive.Content className={cn("[overflow-anchor:none]", contentClassName)}>
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      {horizontal ? <ScrollBar orientation="horizontal" /> : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  ),
);
ScrollArea.displayName = "ScrollArea";

const ScrollBar = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Scrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.Scrollbar
    ref={ref}
    orientation={orientation}
    data-scroll-area-scrollbar
    className={cn(
      "scroll-area-scrollbar flex touch-none select-none transition-colors",
      orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent p-px",
      orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent p-px",
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.Thumb
      data-scroll-area-thumb
      className="scroll-area-thumb relative flex-1 rounded-full"
    />
  </ScrollAreaPrimitive.Scrollbar>
));
ScrollBar.displayName = "ScrollBar";
