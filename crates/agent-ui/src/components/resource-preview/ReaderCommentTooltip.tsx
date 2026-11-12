import type { ComponentProps, ReactElement } from "react";
import { LabelTooltip } from "../ui/label-tooltip";
import { Tooltip, TooltipContent } from "../ui/tooltip";
import { READER_COMMENT_PREVIEW_DELAY } from "./readerInteraction";

const previewClass = "za-reader-comment-preview";

export function ReaderCommentTooltip(
  props:
    | { label: string; render: ReactElement; disabled?: boolean }
    | {
        label: string;
        anchor: NonNullable<ComponentProps<typeof TooltipContent>["anchor"]>;
        open: boolean;
        onClose: () => void;
      },
) {
  if ("anchor" in props) {
    return (
      <Tooltip
        open={props.open}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <TooltipContent anchor={props.anchor} className={previewClass}>
          {props.label}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <LabelTooltip
      label={props.label}
      contentClassName={previewClass}
      delay={READER_COMMENT_PREVIEW_DELAY}
      disabled={props.disabled}
      render={props.render}
    />
  );
}
