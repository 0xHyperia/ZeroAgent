import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import type { CSSProperties } from "react";
import { cn } from "../../lib/shared/utils";

/** Controlled presentation. Changing a segment never creates or submits a task. */
export function SegmentedControl<Value extends string>({
  value,
  options,
  label,
  onChange,
  className,
}: {
  value: Value;
  options: readonly { value: Value; label: string; description?: string; disabled?: boolean }[];
  label: string;
  onChange: (value: Value) => void;
  className?: string;
}) {
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <fieldset
      aria-label={label}
      className={cn("za-segmented-control", className)}
      style={{ "--segment-count": options.length, "--segment-index": selected } as CSSProperties}
    >
      <span className="za-segment-indicator" aria-hidden="true" />
      {options.map((option) => (
        <TooltipButton
          key={option.value}
          type="button"
          variant="ghost"
          title={option.description}
          disabled={option.disabled}
          className="za-segment"
          data-segment={option.value}
          aria-pressed={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => {
            if (value !== option.value) onChange(option.value);
          }}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const enabled = options.filter((item) => !item.disabled);
            if (!enabled.length) return;
            event.preventDefault();
            const current = enabled.findIndex((item) => item.value === value);
            const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
            const step = (event.key === "ArrowRight" ? 1 : -1) * (rtl ? -1 : 1);
            const next =
              event.key === "Home"
                ? enabled[0]
                : event.key === "End"
                  ? enabled[enabled.length - 1]
                  : enabled[(current + step + enabled.length) % enabled.length];
            if (value !== next.value) onChange(next.value);
            const buttons =
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                "button[data-segment]",
              );
            [...(buttons ?? [])].find((button) => button.dataset.segment === next.value)?.focus();
          }}
        >
          {option.label}
        </TooltipButton>
      ))}
    </fieldset>
  );
}
