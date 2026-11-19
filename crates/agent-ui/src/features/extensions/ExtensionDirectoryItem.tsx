import type { MouseEvent, ReactNode } from "react";
import { LabelTooltip } from "../../components/ui/label-tooltip";
import { useLocale } from "../../i18n";
import { extensionDescription, extensionDisplayName } from "../../lib/extensions/presentation";
import { ExtensionMark } from "./ExtensionMark";
import type { ExtensionPackage } from "./extensionTypes";

/** One browse row for plugins and independent skills; the host supplies available actions. */
export function ExtensionDirectoryItem({
  item,
  onOpen,
  children,
  summaryOnly,
}: {
  item: ExtensionPackage;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  summaryOnly?: boolean;
}) {
  const { locale } = useLocale();
  const name = extensionDisplayName(item, locale);
  const description = extensionDescription(item, locale);
  return (
    <li className="za-extension-row">
      <button
        type="button"
        data-extension-open={item.id}
        data-cloud-view-navigation={summaryOnly ? "" : undefined}
        aria-haspopup={summaryOnly ? "dialog" : undefined}
        className="za-extension-row-main"
        onClick={onOpen}
      >
        <ExtensionMark id={item.id} />
        <span>
          <LabelTooltip label={name} render={<strong>{name}</strong>} />
          <span title={description}>{description}</span>
        </span>
      </button>
      {children}
    </li>
  );
}
