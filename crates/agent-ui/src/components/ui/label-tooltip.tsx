import { type ComponentProps, type ReactElement, type ReactNode, useId } from "react";
import { cn } from "../../lib/shared/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * 纯文本标签气泡（Base UI）：composer 运行时控件与上下文用量环共用同一视觉。
 * 默认非受控（悬停展示）；触屏点按驱动的调用方（上下文用量环）传入
 * open/onOpenChange 受控，并禁用 closeOnClick——trigger 按压关闭发生在
 * pointerdown，早于调用方 click 阶段的开合裁决，保留会让二段点按判据失效。
 */
export function LabelTooltip(props: {
  label: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  closeOnClick?: boolean;
  /** 覆盖默认 18rem 宽度；仍受视口边缘约束，用于结构化多列内容。 */
  contentClassName?: string;
  children?: ReactNode;
  /** Direct composition keeps the actual control as the focus/description anchor. */
  render?: ReactElement;
  side?: ComponentProps<typeof TooltipContent>["side"];
  align?: ComponentProps<typeof TooltipContent>["align"];
  sideOffset?: number;
  delay?: number;
  disabled?: boolean;
  description?: ReactNode;
  shortcut?: string;
}) {
  const { onOpenChange } = props;
  const triggerId = useId();
  return (
    <Tooltip
      open={props.open}
      disabled={props.disabled}
      triggerId={props.open !== undefined ? triggerId : undefined}
      onOpenChange={onOpenChange ? (open) => onOpenChange(open) : undefined}
    >
      <TooltipTrigger
        id={props.open !== undefined ? triggerId : undefined}
        delay={props.delay}
        closeOnClick={props.closeOnClick ?? true}
        render={props.render ?? <span className="inline-flex shrink-0">{props.children}</span>}
      />
      <TooltipContent
        side={props.side}
        align={props.align}
        sideOffset={props.sideOffset}
        className={cn(props.contentClassName)}
      >
        {props.shortcut || props.description ? (
          <span className="flex min-w-0 flex-col gap-1">
            <span className="flex items-center gap-3">
              <span className="min-w-0">{props.label}</span>
              {props.shortcut ? (
                <kbd className="ml-auto shrink-0 font-app text-xs font-normal text-muted-foreground">
                  {props.shortcut}
                </kbd>
              ) : null}
            </span>
            {props.description ? (
              <span className="font-normal leading-relaxed text-muted-foreground">
                {props.description}
              </span>
            ) : null}
          </span>
        ) : (
          props.label
        )}
      </TooltipContent>
    </Tooltip>
  );
}
