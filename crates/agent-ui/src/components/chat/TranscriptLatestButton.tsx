import type { CSSProperties } from "react";
import { useLocale } from "../../i18n";
import { ArrowDown } from "../IconSet";
import { Button } from "../ui/button";
import { LabelTooltip } from "../ui/label-tooltip";

export function TranscriptLatestButton({
  bottom,
  left = "50%",
  viewport,
  onJump,
}: {
  bottom: CSSProperties["bottom"];
  left?: CSSProperties["left"];
  viewport: HTMLElement | null;
  onJump: () => void;
}) {
  const { t } = useLocale();
  const label = t("chat.transcript.scrollToBottom");

  return (
    <LabelTooltip
      label={label}
      side="top"
      render={
        <Button
          variant="outline"
          size="icon"
          className="chat-jump-to-bottom layer-raised absolute size-9 -translate-x-1/2 rounded-full border-border bg-background text-foreground shadow-sm max-sm:size-11 pointer-coarse:size-11"
          style={{ bottom, left }}
          aria-label={label}
          onClick={(event) => {
            if (
              event.detail === 0 &&
              event.currentTarget === event.currentTarget.ownerDocument.activeElement
            ) {
              viewport?.focus({ preventScroll: true });
            }
            onJump();
          }}
        >
          <ArrowDown className="size-4" aria-hidden="true" />
        </Button>
      }
    />
  );
}
