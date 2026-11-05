import type { ReactNode } from "react";
import { LabelTooltip } from "../../components/ui/label-tooltip";
import { extensionDisplayName } from "../../lib/extensions/presentation";
import { ExtensionMark } from "./ExtensionMark";
import type { ExtensionPackage } from "./extensionTypes";

/** One browse row for plugins and independent skills; the host supplies available actions. */
export function ExtensionDirectoryItem({
  item,
  onOpen,
  children,
}: {
  item: ExtensionPackage;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <li className="za-extension-row">
      <button
        type="button"
        data-extension-open={item.id}
        className="za-extension-row-main"
        onClick={onOpen}
      >
        <ExtensionMark id={item.id} />
        <span>
          <LabelTooltip
            label={extensionDisplayName(item)}
            render={<strong>{extensionDisplayName(item)}</strong>}
          />
          <span title={item.description}>{item.description}</span>
        </span>
      </button>
      {children}
    </li>
  );
}
