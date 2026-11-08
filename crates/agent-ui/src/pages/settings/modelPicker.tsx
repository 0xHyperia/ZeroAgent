import { ChevronDown } from "@liveagent/ui/components/IconSet";
import { ModelPickerContent } from "@liveagent/ui/components/models/ModelPickerContent";
import { ProviderBrandIcon } from "@liveagent/ui/components/ProviderBrandIcon";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import { useLocale } from "@liveagent/ui/i18n/index";
import { type ModelPickerOption, modelIdOf } from "@liveagent/ui/lib/models/modelPickerOptions";
import type { ModelType } from "@liveagent/ui/lib/models/modelTypes";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useRef, useState } from "react";

export type { ModelPickerOption } from "@liveagent/ui/lib/models/modelPickerOptions";

const TRIGGER_VARIANTS = {
  plain:
    "h-9 rounded-lg border-0 bg-settings-tile-hover text-sm shadow-none hover:bg-settings-active",
  default: "h-10 rounded-md border-input bg-background text-sm shadow-xs",
  compact: "h-9 rounded-md border-input bg-background text-sm shadow-xs hover:bg-accent/40",
  quiet:
    "h-9 rounded-lg border-foreground/10 bg-white/70 text-sm shadow-none dark:bg-background/40",
  dashed:
    "h-8 rounded-lg border-dashed border-foreground/[0.13] bg-transparent py-0 text-xs text-muted-foreground shadow-none hover:border-foreground/[0.24] hover:bg-foreground/[0.02]",
} as const;

export function ModelPicker({
  options,
  value,
  onChange,
  disabled,
  placeholder,
  noneLabel,
  ariaLabel,
  variant = "default",
  collapsibleGroups = true,
  searchPlaceholder,
  emptyLabel,
  selectionKind = "model",
  modelType,
  onRefresh,
  refreshing,
}: {
  options: ModelPickerOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
  noneLabel?: string;
  ariaLabel?: string;
  variant?: keyof typeof TRIGGER_VARIANTS;
  collapsibleGroups?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  selectionKind?: "model" | "provider";
  modelType?: ModelType;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const { t } = useLocale();
  const [isOpen, setIsOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedOption = options.find((option) => option.value === value);
  return (
    <div className="w-full min-w-0">
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              disabled={disabled}
              aria-label={ariaLabel}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between gap-2 border px-3 py-2 transition-colors",
                TRIGGER_VARIANTS[variant],
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              )}
            />
          }
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
            {selectedOption && (
              <ProviderBrandIcon
                type={selectedOption.providerType}
                model={selectionKind === "model" ? modelIdOf(selectedOption) : undefined}
                className="size-3.5"
              />
            )}
            <span className={cn("truncate", !selectedOption && "text-muted-foreground")}>
              {selectedOption?.label ?? placeholder}
            </span>
          </span>
          <ChevronDown
            className={cn("size-3.5 shrink-0 text-muted-foreground", isOpen && "rotate-180")}
          />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={8}
          aria-label={ariaLabel ?? t("chat.selectModel")}
          className="flex max-h-[min(75dvh,var(--available-height,75dvh))] w-(--anchor-width) min-w-72 max-w-[calc(100vw-32px)] flex-col overflow-hidden p-1.5"
          initialFocus={(openType) =>
            openType === "touch" ||
            (typeof window.matchMedia === "function" &&
              window.matchMedia("(hover: none) and (pointer: coarse)").matches)
              ? false
              : searchInputRef.current
          }
        >
          <ModelPickerContent
            key={isOpen ? "open" : "closed"}
            options={options}
            value={value}
            searchInputRef={searchInputRef}
            noneLabel={noneLabel}
            searchPlaceholder={searchPlaceholder}
            emptyLabel={emptyLabel}
            collapsibleGroups={collapsibleGroups}
            selectionKind={selectionKind}
            modelType={modelType}
            onRefresh={onRefresh}
            refreshing={refreshing}
            onSelect={(next) => {
              onChange(next);
              setIsOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
