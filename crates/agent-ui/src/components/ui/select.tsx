import { Select as SelectPrimitive } from "@base-ui/react";
import { Check, ChevronDown, ChevronUp } from "@liveagent/ui/components/IconSet";
import * as React from "react";
import { cn } from "../../lib/shared/utils";
import { floatingSurfaceClassName } from "./menu-surface";
import { useZoneFontScaleStyle } from "./zone-font-scale";

type SelectProps = Omit<
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Root>,
  "onValueChange"
> & {
  onValueChange?: (value: string) => void;
};

export function Select({ onValueChange, ...props }: SelectProps) {
  return (
    <SelectPrimitive.Root
      onValueChange={
        onValueChange
          ? (value) => {
              if (value != null) onValueChange(value as string);
            }
          : undefined
      }
      {...props}
    />
  );
}

type SelectValueProps = Omit<
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Value>,
  "children"
> & {
  placeholder?: React.ReactNode;
  children?: React.ReactNode | ((value: unknown) => React.ReactNode);
};

export const SelectValue = React.forwardRef<HTMLSpanElement, SelectValueProps>(
  ({ placeholder, children, ...props }, ref) => {
    return (
      <SelectPrimitive.Value ref={ref} placeholder={placeholder} {...props}>
        {children as React.ComponentPropsWithoutRef<typeof SelectPrimitive.Value>["children"]}
      </SelectPrimitive.Value>
    );
  },
);
SelectValue.displayName = "SelectValue";

export const SelectTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { variant?: "default" | "plain" }
>(({ className, children, variant = "default", ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-9 w-full items-center justify-between",
      "za-text-field border border-input bg-background px-3 py-2 text-sm",
      "placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
      "disabled:cursor-not-allowed disabled:opacity-50",
      variant === "plain" &&
        "border-0 bg-settings-tile-hover shadow-none focus-visible:ring-2 focus-visible:ring-ring/25",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon>
      <ChevronDown className="size-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

const SelectScrollUpButton = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpArrow>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpArrow
    ref={ref}
    // Base UI renders scroll arrows position:absolute (inline style); they
    // must be anchored and given a background or they float transparently
    // over the list items.
    className={cn(
      "left-0 top-0 z-10 flex w-full cursor-pointer items-center justify-center",
      "rounded-t-md bg-popover py-1",
      className,
    )}
    {...props}
  >
    <ChevronUp className="size-4" />
  </SelectPrimitive.ScrollUpArrow>
));
SelectScrollUpButton.displayName = "SelectScrollUpButton";

const SelectScrollDownButton = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownArrow>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownArrow
    ref={ref}
    className={cn(
      "bottom-0 left-0 z-10 flex w-full cursor-pointer items-center justify-center",
      "rounded-b-md bg-popover py-1",
      className,
    )}
    {...props}
  >
    <ChevronDown className="size-4" />
  </SelectPrimitive.ScrollDownArrow>
));
SelectScrollDownButton.displayName = "SelectScrollDownButton";

type SelectContentProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Popup> &
  Pick<
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Positioner>,
    "align" | "collisionPadding" | "side" | "sideOffset"
  > & {
    position?: "popper" | "item-aligned";
  };

export const SelectContent = React.forwardRef<HTMLDivElement, SelectContentProps>(
  (
    {
      align,
      children,
      className,
      collisionPadding,
      position = "popper",
      side,
      sideOffset = 4,
      ...props
    },
    ref,
  ) => {
    const zoneStyle = useZoneFontScaleStyle();
    return (
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align={align}
          collisionPadding={collisionPadding}
          side={side}
          sideOffset={sideOffset}
          alignItemWithTrigger={false}
          className="layer-popover"
          style={zoneStyle}
        >
          <SelectPrimitive.Popup
            ref={ref}
            className={cn(
              "max-h-96 min-w-32 overflow-hidden",
              floatingSurfaceClassName,
              "transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-reduce:transition-none",
              className,
            )}
            {...props}
          >
            <SelectScrollUpButton />
            <SelectPrimitive.List
              className={cn(
                "p-1 max-h-[inherit] overflow-y-auto",
                position === "popper" && "w-full min-w-(--anchor-width)",
              )}
            >
              {children}
            </SelectPrimitive.List>
            <SelectScrollDownButton />
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    );
  },
);
SelectContent.displayName = "SelectContent";

export const SelectItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
    /**
     * Optional secondary line rendered under the item label. Kept OUTSIDE
     * ItemText on purpose: ItemText must stay text-only (it feeds typeahead
     * and the trigger's value reflection), so rich item layouts go here.
     */
    description?: React.ReactNode;
  }
>(({ className, children, description, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "za-menu-item relative flex w-full cursor-pointer select-none items-center data-[disabled]:cursor-default",
      "py-1.5 pl-2 pr-8 text-sm outline-hidden",
      "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span
      className={cn(
        "absolute right-2 flex size-3.5 items-center justify-center",
        description != null && "top-1/2 -translate-y-1/2",
      )}
    >
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    {description == null ? (
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    ) : (
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        <span className="truncate text-tiny leading-tight text-muted-foreground/70">
          {description}
        </span>
      </span>
    )}
  </SelectPrimitive.Item>
));
SelectItem.displayName = "SelectItem";
