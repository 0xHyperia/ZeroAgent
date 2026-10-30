import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/shared/utils";

/** Both application bundles ship this canonical asset; hosts may supply their own URL. */
export const ZEROAGENT_BRAND_MARK = "/zeroagent-logo.png";

export function BrandMark({
  src = ZEROAGENT_BRAND_MARK,
  alt = "ZeroAgent",
  className,
  ...props
}: ComponentPropsWithoutRef<"img">) {
  return (
    <img
      {...props}
      src={src}
      alt={alt}
      draggable={false}
      className={cn("size-8 shrink-0 select-none object-contain", className)}
    />
  );
}
