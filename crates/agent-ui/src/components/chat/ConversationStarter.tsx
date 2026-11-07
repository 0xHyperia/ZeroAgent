import type { ReactNode } from "react";

/** A suggestion fills the host's draft only; the host owns sending and execution. */
export function ConversationStarter({
  title,
  description,
  icon,
  actionLabel,
  layout = "stacked",
  onSelect,
}: {
  title: string;
  description?: string;
  icon: ReactNode;
  actionLabel?: string;
  layout?: "stacked" | "inline";
  onSelect: () => void;
}) {
  return (
    <button type="button" className="conversation-starter" data-layout={layout} onClick={onSelect}>
      <span className="conversation-starter-top" aria-hidden="true">
        {icon}
        {actionLabel ? <span className="conversation-starter-try">{actionLabel}</span> : null}
      </span>
      <span className="conversation-starter-title">{title}</span>
      {description ? <span className="conversation-starter-description">{description}</span> : null}
    </button>
  );
}
