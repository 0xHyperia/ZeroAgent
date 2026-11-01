import { forwardRef, type HTMLAttributes } from "react";
import { ScrollArea } from "../ui/scroll-area";

/** Keep format readers' existing viewport refs, observers and keyboard handlers. */
export const PreviewScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function PreviewScrollArea({ className, children, ...props }, ref) {
    return (
      <ScrollArea
        className="za-preview-scroll-root"
        viewportRef={ref}
        contentClassName="za-preview-scroll-content"
        viewportProps={{ ...props, className }}
        horizontal
      >
        {children}
      </ScrollArea>
    );
  },
);
