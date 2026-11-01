import type { ReactNode } from "react";
import "./preview-dock.css";

/** Quiet floating transport/tools surface shared by image and media readers. */
export function PreviewDock({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className={`za-preview-dock ${className}`} aria-label={label}>
      {children}
    </fieldset>
  );
}
