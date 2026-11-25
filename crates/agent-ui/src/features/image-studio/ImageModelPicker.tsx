import "@liveagent/ui/i18n/namespaces/imageStudio";
import { useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Package } from "../../components/IconSet";
import { ModelPickerContent } from "../../components/models/ModelPickerContent";
import { Button } from "../../components/ui/button";
import { menuSurfaceClassName } from "../../components/ui/menu-surface";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { useLocale } from "../../i18n";
import type { ImageTarget } from "../../lib/imaging/types";
import { cn } from "../../lib/shared/utils";
import { splitTargetName, targetDisabledText } from "./studioModel";
import type { Translate } from "./studioText";

function modeBadges(target: ImageTarget, t: Translate) {
  const operations = target.capabilities.operations;
  return [
    operations.includes("generate") && t("imageStudio.textToImage"),
    (operations.includes("edit") || operations.includes("reference")) &&
      t("imageStudio.imageToImage"),
  ].filter((badge): badge is string => Boolean(badge));
}

export function ImageModelPicker({
  id,
  targets,
  value,
  onChange,
  onOpen,
  className,
}: {
  id: string;
  targets: ImageTarget[];
  value: string;
  onChange: (targetId: string) => void;
  onOpen?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useLocale();
  const searchRef = useRef<HTMLInputElement>(null);
  const options = targets.map((target) => {
    const { provider, model } = splitTargetName(target.name);
    return {
      value: target.id,
      label: model,
      model: target.modelId || target.remoteId || model,
      modelTypes: ["image"] as const,
      providerId: target.providerId ?? target.connectionId,
      providerName: provider ?? t("imageStudio.modelPicker.other"),
      disabledReason: target.enabled ? undefined : targetDisabledText(target, t),
      badges: modeBadges(target, t),
    };
  });
  const current = targets.find((target) => target.id === value);
  const missing = Boolean(value) && !current;
  const label = current
    ? splitTargetName(current.name).model
    : missing
      ? t("imageStudio.modelPicker.missing")
      : targets.length
        ? t("imageStudio.modelPicker.choose")
        : t("imageStudio.modelPicker.none");
  const warn = missing || (current && !current.enabled);
  const select = (targetId: string) => {
    onChange(targetId);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="ghost"
            title={current?.name ?? label}
            className={cn(
              "h-10 w-full min-w-0 justify-start gap-2 rounded-xl border border-border px-3 font-normal sm:w-64",
              open && "bg-muted/60",
              warn && "text-destructive",
              className,
            )}
          />
        }
      >
        {warn ? (
          <AlertTriangle className="size-4 shrink-0" />
        ) : (
          <Package className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            !current && !missing && "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        aria-label={t("imageStudio.modelPicker.choose")}
        initialFocus={(openType) => (openType === "touch" ? false : searchRef.current)}
        className={cn(
          "flex max-h-[min(380px,75dvh)] w-[300px] max-w-[calc(100vw-16px)] flex-col overflow-hidden",
          menuSurfaceClassName,
          "p-1.5 text-xs leading-5",
        )}
      >
        <ModelPickerContent
          key={open ? "open" : "closed"}
          options={options}
          modelType="image"
          value={value}
          revealSelected
          searchInputRef={searchRef}
          emptyLabel={targets.length ? undefined : t("imageStudio.modelPicker.noneHint")}
          onSelect={select}
        />
      </PopoverContent>
    </Popover>
  );
}
