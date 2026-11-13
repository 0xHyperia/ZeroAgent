import { forwardRef, type ReactNode } from "react";
import { cn } from "../../lib/shared/utils";
import { ScrollArea } from "../ui/scroll-area";
import "./composer-attachments.css";

/** The viewport ref preserves the composer's existing scroll-to-new-attachment behavior. */
export const ComposerAttachmentList = forwardRef<
  HTMLDivElement,
  { children: ReactNode; className?: string; compact?: boolean }
>(function ComposerAttachmentList({ children, className, compact }, ref) {
  return (
    <ScrollArea
      className={cn("za-composer-attachment-scroll", className)}
      data-compact-attachments={compact ? "" : undefined}
      horizontal={compact}
      viewportRef={ref}
      viewportProps={{ className: "za-composer-attachment-viewport", "aria-label": "待发送附件" }}
      contentClassName="za-composer-attachment-list"
    >
      {children}
    </ScrollArea>
  );
});
