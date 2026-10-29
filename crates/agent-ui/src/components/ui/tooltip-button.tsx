import { forwardRef, type ReactNode } from "react";
import { Button, type ButtonProps } from "./button";
import { LabelTooltip } from "./label-tooltip";

export type TooltipButtonProps = ButtonProps & {
  tooltip?: ReactNode;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  tooltipDescription?: ReactNode;
  tooltipShortcut?: string;
};

/** Opt-in title replacement. Keeps one real button and its host's event/ref contract. */
export const TooltipButton = forwardRef<HTMLElement, TooltipButtonProps>(
  ({ tooltip, tooltipSide, tooltipDescription, tooltipShortcut, title, ...props }, ref) => {
    const label = tooltip ?? title;
    if (!label) return <Button ref={ref} {...props} />;
    const expanded = props["aria-expanded"] === true || props["aria-expanded"] === "true";
    return (
      <LabelTooltip
        label={label}
        description={tooltipDescription}
        shortcut={tooltipShortcut ?? props["aria-keyshortcuts"]}
        side={tooltipSide}
        disabled={props.disabled || expanded}
        render={<Button ref={ref} {...props} />}
      />
    );
  },
);
TooltipButton.displayName = "TooltipButton";
