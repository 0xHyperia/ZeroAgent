import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { PanelRightClose, PanelRightOpen } from "../IconSet";
import { Button } from "../ui/button";
import { LabelTooltip } from "../ui/label-tooltip";

export function ProjectToolsPanelToggle(props: {
  isOpen: boolean;
  sessionCount: number;
  disabledMessage?: string;
  className?: string;
  onToggle: () => void;
}) {
  const { isOpen, sessionCount, disabledMessage, className = "", onToggle } = props;
  const { t } = useLocale();
  const label = isOpen
    ? t("projectTools.collapsePanel")
    : (disabledMessage ?? t("projectTools.expandPanel"));
  return (
    <LabelTooltip
      label={label}
      side="bottom"
      render={
        <Button
          variant="ghost"
          size="icon"
          onClick={(event) => {
            const group =
              !isOpen && event.detail === 0
                ? event.currentTarget.closest('[data-slot="resizable-panel-group"]')
                : null;
            onToggle();
            if (group) {
              requestAnimationFrame(() => {
                if (group.hasAttribute("data-workspace-tools-docked")) {
                  group.querySelector<HTMLButtonElement>("[data-workspace-close-docked]")?.focus();
                }
              });
            }
          }}
          disabled={Boolean(disabledMessage) && !isOpen}
          aria-expanded={isOpen}
          data-project-tools-toggle=""
          aria-label={label}
          className={cn(
            className,
            "relative size-8 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-95",
            isOpen ? "bg-muted text-foreground" : "",
          )}
        >
          {isOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          {sessionCount > 0 ? (
            <span
              className={cn(
                "absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center",
                "rounded-full bg-emerald-500 px-1",
                "text-tiny font-semibold leading-none text-white",
              )}
            >
              {sessionCount}
            </span>
          ) : null}
        </Button>
      }
    />
  );
}
