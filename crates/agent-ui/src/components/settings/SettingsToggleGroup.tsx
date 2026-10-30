import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

export function SettingsToggleGroup({ className, ...props }: ComponentProps<typeof ToggleGroup>) {
  return <ToggleGroup className={cn("za-segmented gap-0.5 p-1", className)} {...props} />;
}

export function SettingsToggleGroupItem({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupItem>) {
  return (
    <ToggleGroupItem
      className={cn("za-segment h-7 min-w-9 px-2.5 text-xs font-normal", className)}
      {...props}
    />
  );
}
