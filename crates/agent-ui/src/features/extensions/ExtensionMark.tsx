import { Package } from "../../components/IconSet";
import { extensionImage } from "../../lib/extensions/presentation";
import { cn } from "../../lib/shared/utils";
import "./ExtensionMark.css";

export function ExtensionMark({ id, small = false }: { id: string; small?: boolean }) {
  const image = extensionImage(id);
  return (
    <span
      className={cn("za-extension-mark", small && "za-extension-mark-small")}
      data-brand={id}
      data-logo={image ? "true" : undefined}
    >
      {image ? (
        <img src={image} alt="" aria-hidden="true" draggable={false} />
      ) : (
        <Package className="size-5" aria-hidden="true" />
      )}
    </span>
  );
}
