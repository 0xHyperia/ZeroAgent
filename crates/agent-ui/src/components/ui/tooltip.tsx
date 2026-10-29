import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import * as React from "react";

import { cn } from "../../lib/shared/utils";
import { useZoneFontScaleStyle } from "./zone-font-scale";

export const TOOLTIP_OPEN_DELAY = 350;
export const TOOLTIP_CLOSE_DELAY = 80;
const TooltipDescriptionContext = React.createContext<{
  contentId: string;
  open: boolean;
  triggerId?: string | null;
} | null>(null);

export function TooltipProvider(props: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delay={TOOLTIP_OPEN_DELAY}
      closeDelay={TOOLTIP_CLOSE_DELAY}
      timeout={400}
      {...props}
    />
  );
}

export function Tooltip<Payload = unknown>(props: TooltipPrimitive.Root.Props<Payload>) {
  const contentId = React.useId();
  const [observed, setObserved] = React.useState({
    open: props.defaultOpen ?? false,
    triggerId: props.defaultTriggerId,
  });
  const description = React.useMemo(
    () => ({
      contentId,
      open: props.open ?? observed.open,
      triggerId: props.triggerId ?? observed.triggerId,
    }),
    [contentId, props.open, props.triggerId, observed],
  );
  return (
    <TooltipDescriptionContext.Provider value={description}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        {...props}
        onOpenChange={(open, details) => {
          props.onOpenChange?.(open, details);
          if (!details.isCanceled)
            setObserved((previous) =>
              previous.open === open && previous.triggerId === details.trigger?.id
                ? previous
                : { open, triggerId: details.trigger?.id },
            );
        }}
      />
    </TooltipDescriptionContext.Provider>
  );
}

/**
 * 分离式触发器：多个 TooltipTrigger 通过同一个 handle 共享一个 Tooltip 实例，
 * 列表类场景不必为每一行各挂一份弹层。
 */
export const createTooltipHandle = TooltipPrimitive.createHandle;

export function TooltipTrigger(
  props: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>,
) {
  const generatedId = React.useId();
  const description = React.useContext(TooltipDescriptionContext);
  const {
    render,
    title: _nativeTitle,
    delay = TOOLTIP_OPEN_DELAY,
    closeDelay = TOOLTIP_CLOSE_DELAY,
    ...triggerProps
  } = props;
  const renderedProps = React.isValidElement<{ id?: string; "aria-describedby"?: string }>(render)
    ? render.props
    : undefined;
  const triggerId = props.id ?? renderedProps?.id ?? generatedId;
  const describedBy =
    [
      props["aria-describedby"] ?? renderedProps?.["aria-describedby"],
      description?.open && (!description.triggerId || description.triggerId === triggerId)
        ? description.contentId
        : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  // A composed element's own props win in Base UI's render merge. Carry the
  // complete description onto that element too, preserving caller-owned help.
  const cleanRender = React.isValidElement<{
    title?: string;
    id?: string;
    "aria-describedby"?: string;
  }>(render)
    ? React.cloneElement(render, {
        title: undefined,
        id: triggerId,
        "aria-describedby": describedBy,
      })
    : render;
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      delay={delay}
      closeDelay={closeDelay}
      {...triggerProps}
      id={triggerId}
      aria-describedby={describedBy}
      render={cleanRender}
    />
  );
}

type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Popup> &
  Pick<
    React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Positioner>,
    "align" | "anchor" | "collisionPadding" | "side" | "sideOffset"
  >;

export const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  (
    {
      align = "center",
      anchor,
      className,
      collisionPadding = 8,
      side = "top",
      sideOffset = 6,
      ...props
    },
    ref,
  ) => {
    const zoneStyle = useZoneFontScaleStyle();
    const description = React.useContext(TooltipDescriptionContext);
    return (
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          align={align}
          anchor={anchor}
          collisionPadding={collisionPadding}
          side={side}
          sideOffset={sideOffset}
          className="layer-popover isolate data-[anchor-hidden]:invisible"
          style={zoneStyle}
        >
          <TooltipPrimitive.Popup
            ref={ref}
            data-slot="tooltip-content"
            className={cn(
              "app-tooltip-surface max-w-72 rounded-xl border px-3 py-1.5",
              "text-sm font-medium leading-4 outline-none transition-[transform,opacity] duration-150 origin-[var(--transform-origin)]",
              "data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 motion-reduce:transition-none",
              className,
            )}
            {...props}
            id={description?.contentId ?? props.id}
            role="tooltip"
          />
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    );
  },
);
TooltipContent.displayName = "TooltipContent";
