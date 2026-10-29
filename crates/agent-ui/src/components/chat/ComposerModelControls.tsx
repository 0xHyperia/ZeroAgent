import {
  type ChatRuntimeControls,
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  type ExecutionMode,
  isAgentDevMode,
  isAgentExecutionMode,
  type ProviderId,
  type ReasoningLevel,
  type SelectedModel,
} from "@liveagent/app/lib/settings";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Layers,
  Lightbulb,
  LightbulbOff,
} from "@liveagent/ui/components/IconSet";
import { ModelPickerContent } from "@liveagent/ui/components/models/ModelPickerContent";
import { ProviderBrandIcon } from "@liveagent/ui/components/ProviderBrandIcon";
import { menuSurfaceClassName } from "@liveagent/ui/components/ui/menu-surface";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  COMPOSER_CONTROL_CHEVRON_CLASS,
  COMPOSER_CONTROL_LABEL_CLASS,
  COMPOSER_CONTROL_TRIGGER_CLASS,
} from "@liveagent/ui/lib/chat/composerControlStyles";
import type { SharedModelOption } from "@liveagent/ui/lib/models/modelOptions";
import { parseModelValue } from "@liveagent/ui/lib/models/modelValue";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, type ReactNode, useEffect, useId, useRef, useState } from "react";

const REASONING_I18N_KEYS: Record<ReasoningLevel, string> = {
  off: "settings.reasoning.off",
  minimal: "settings.reasoning.minimal",
  low: "settings.reasoning.low",
  medium: "settings.reasoning.medium",
  high: "settings.reasoning.high",
  xhigh: "settings.reasoning.xhigh",
  max: "settings.reasoning.max",
};

const REASONING_COMPACT_I18N_KEYS: Record<ReasoningLevel, string> = {
  off: "chat.runtime.reasoningCompact.off",
  minimal: "chat.runtime.reasoningCompact.minimal",
  low: "chat.runtime.reasoningCompact.low",
  medium: "chat.runtime.reasoningCompact.medium",
  high: "chat.runtime.reasoningCompact.high",
  xhigh: "chat.runtime.reasoningCompact.xhigh",
  max: "chat.runtime.reasoningCompact.max",
};

function RuntimeToggleChip(props: {
  pressed: boolean;
  disabled?: boolean;
  label: string;
  ariaLabel: string;
  pressedClassName: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  const { pressed, disabled = false, label, ariaLabel, pressedClassName, icon, onClick } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5",
        "text-xs font-medium outline-hidden transition-colors",
        "focus-visible:ring-2 focus-visible:ring-primary/35 disabled:pointer-events-none disabled:opacity-40",
        pressed
          ? pressedClassName
          : "bg-muted/60 text-muted-foreground hover:bg-settings-active/60/80 hover:text-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

export type ComposerModelControlsProps = {
  /** Compact chat shows effort; its accessible name still identifies the selected model. */
  compactLabel?: boolean;
  showProviderIcon?: boolean;
  executionMode: ExecutionMode;
  hasModels: boolean;
  currentModelLabel: string;
  modelOptions: SharedModelOption<ProviderId>[];
  selectedValue?: string;
  chatRuntimeControls: ChatRuntimeControls;
  reasoningOptions: ReasoningLevel[];
  thinkingAlwaysOn: boolean;
  disabled?: boolean;
  modelsRefreshing?: boolean;
  onRefreshModels?: () => void | Promise<void>;
  onSelectModel: (selection: SelectedModel) => void;
  onSelectExecutionMode: (mode: "text" | "tools") => void;
  onOpenSettings: (section?: "providers", providerId?: string) => void;
  onChatRuntimeControlsChange: (patch: Partial<ChatRuntimeControls>) => void;
  /** 受控开关（/model 指令从外部打开）；缺省时弹层自管开关。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

// Touch / coarse-pointer must not land on the search field: that opens the IME.
// Focus the popup itself, matching Base UI's default touch behavior.
const isCoarsePointer = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(hover: none) and (pointer: coarse)").matches;

export const ComposerModelControls = memo(function ComposerModelControls(
  props: ComposerModelControlsProps,
) {
  const {
    compactLabel = false,
    showProviderIcon = true,
    executionMode,
    hasModels,
    currentModelLabel,
    modelOptions,
    selectedValue,
    chatRuntimeControls,
    reasoningOptions,
    thinkingAlwaysOn,
    disabled = false,
    modelsRefreshing = false,
    onRefreshModels,
    onSelectModel,
    onSelectExecutionMode,
    onOpenSettings,
    onChatRuntimeControlsChange,
    open,
    onOpenChange,
  } = props;
  const nativeWebSearchSupported =
    modelOptions.find((option) => option.value === selectedValue)?.nativeWebSearchSupported ===
    true;
  const { t } = useLocale();
  const [uncontrolledModelPickerOpen, setUncontrolledModelPickerOpen] = useState(false);
  const isModelPickerOpen = open ?? uncontrolledModelPickerOpen;
  const setIsModelPickerOpen = (next: boolean) => {
    if (open === undefined) setUncontrolledModelPickerOpen(next);
    onOpenChange?.(next);
  };
  const [view, setView] = useState<"root" | "model" | "reasoning">("root");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const popoverContentRef = useRef<HTMLDivElement>(null);
  const executionModeRadioName = useId();

  useEffect(() => {
    if (!isModelPickerOpen) return;
    setView("root");
  }, [isModelPickerOpen]);

  // 恒开模型的 thinkingEnabled 纠偏。注意不得在此回写 reasoning:档位展示值
  // 由共享层按「模型桶 → 供应商桶 → 默认」解析并钳制,旧的「档位不在选项表
  // 就重置为默认档」自愈会把其他模型选的表外档从全局存储里抹掉,是跨会话
  // 串档/重置的写入口(按模型存储改造后已移除,见 ChatRuntimeControls)。
  useEffect(() => {
    if (!(thinkingAlwaysOn && !chatRuntimeControls.thinkingEnabled)) return;
    onChatRuntimeControlsChange({ thinkingEnabled: true });
  }, [chatRuntimeControls.thinkingEnabled, onChatRuntimeControlsChange, thinkingAlwaysOn]);

  const selectedOption = modelOptions.find((option) => option.value === selectedValue);
  const triggerLabel = selectedOption?.label ?? currentModelLabel;
  const isAgent = isAgentExecutionMode(executionMode);
  const isDev = isAgentDevMode(executionMode);
  const thinkingSupported = reasoningOptions.length > 0 || thinkingAlwaysOn;
  const selectedReasoning = reasoningOptions.includes(chatRuntimeControls.reasoning)
    ? chatRuntimeControls.reasoning
    : reasoningOptions.includes(DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning)
      ? DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning
      : (reasoningOptions[reasoningOptions.length - 1] ?? DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning);
  const thinkingOn = thinkingSupported && (thinkingAlwaysOn || chatRuntimeControls.thinkingEnabled);
  const showEffortBar = thinkingSupported && reasoningOptions.length > 1;
  const effortChoices: ReasoningLevel[] = showEffortBar
    ? thinkingAlwaysOn
      ? reasoningOptions.filter((level) => level !== "off")
      : ["off", ...reasoningOptions.filter((level) => level !== "off")]
    : [];
  const selectedEffort: ReasoningLevel = thinkingOn ? selectedReasoning : "off";
  const showView = (next: "root" | "model" | "reasoning") => {
    setView(next);
  };
  useEffect(() => {
    if (!isModelPickerOpen) return;
    // Model page: pointer users get the search field ready to type; touch
    // users land on the back button so the keyboard does not pop up.
    if (view === "model" && !isCoarsePointer() && searchInputRef.current) {
      searchInputRef.current.focus();
      return;
    }
    const selector = view === "root" ? "button" : "[data-model-back]";
    popoverContentRef.current?.querySelector<HTMLButtonElement>(selector)?.focus();
  }, [view, isModelPickerOpen]);
  const resolveModelPickerInitialFocus = (openType: string) => {
    const openedByTouch = openType === "touch";
    if (openedByTouch || isCoarsePointer()) {
      return popoverContentRef.current ?? false;
    }
    return popoverContentRef.current;
  };

  return (
    <Popover open={isModelPickerOpen} onOpenChange={setIsModelPickerOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            disabled={disabled || !hasModels}
            title={triggerLabel}
            aria-label={`${t("chat.selectModel")}: ${triggerLabel}`}
            className={cn(COMPOSER_CONTROL_TRIGGER_CLASS, isModelPickerOpen && "bg-muted/60")}
          />
        }
      >
        {showProviderIcon && selectedOption ? (
          <ProviderBrandIcon
            type={selectedOption.providerType}
            model={selectedOption.model}
            className="opacity-90"
          />
        ) : showProviderIcon ? (
          <Layers className="size-4 shrink-0" />
        ) : null}
        <span className={COMPOSER_CONTROL_LABEL_CLASS}>
          {compactLabel && thinkingSupported
            ? t(REASONING_COMPACT_I18N_KEYS[selectedEffort])
            : triggerLabel}
          {!compactLabel && thinkingOn
            ? ` · ${t(REASONING_COMPACT_I18N_KEYS[selectedEffort])}`
            : ""}
        </span>
        <ChevronDown
          className={cn(COMPOSER_CONTROL_CHEVRON_CLASS, isModelPickerOpen && "rotate-180")}
        />
      </PopoverTrigger>

      <PopoverContent
        ref={popoverContentRef}
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        initialFocus={resolveModelPickerInitialFocus}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (event.target instanceof HTMLInputElement && event.target.type === "radio") return;
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                view === "model"
                  ? "button[data-model-option], button[data-model-group]"
                  : "button:not(:disabled)",
              ),
            );
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
            if (next) {
              event.preventDefault();
              next.focus();
            }
          }
          if (event.key !== "Escape") event.stopPropagation();
        }}
        aria-label={t("chat.selectModel")}
        className={cn(
          "flex max-h-[min(380px,75dvh,var(--available-height,75dvh))] w-[324px] max-w-[calc(100vw-16px)] flex-col overflow-hidden",
          menuSurfaceClassName,
          "p-1.5 text-xs leading-5",
          "web:font-app web:text-xs web:leading-5",
        )}
      >
        {view === "root" ? (
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => showView("model")}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-lg px-2.5",
                "text-left hover:bg-settings-active/60 focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <span>{t("chat.selectModel")}</span>
              <span className="ml-auto min-w-0 truncate text-muted-foreground">{triggerLabel}</span>
              <ChevronRight className="size-3.5 shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => showView("reasoning")}
              disabled={!thinkingSupported}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-lg px-2.5",
                "text-left hover:bg-settings-active/60 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <span>{t("chat.runtime.reasoning")}</span>
              <span className="ml-auto text-muted-foreground">
                {thinkingSupported
                  ? t(REASONING_I18N_KEYS[selectedEffort])
                  : t("chat.runtime.thinkingUnavailable")}
              </span>
              <ChevronRight className="size-3.5 shrink-0" />
            </button>
            <div className="flex h-9 items-center justify-between gap-2 border-t border-border/40 px-2.5">
              <span className="text-xs text-muted-foreground">{t("settings.executionMode")}</span>
              <div
                role="radiogroup"
                aria-label={t("settings.executionMode")}
                title={t("settings.executionMode")}
                className="flex shrink-0 rounded-lg bg-muted/60 p-0.5"
              >
                <label
                  className={cn(
                    "relative cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-[color,background-color,box-shadow]",
                    "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                    isAgent
                      ? "text-muted-foreground hover:text-foreground"
                      : "bg-background text-foreground shadow-sm",
                  )}
                >
                  <input
                    type="radio"
                    name={executionModeRadioName}
                    value="text"
                    checked={!isAgent}
                    onChange={() => onSelectExecutionMode("text")}
                    className="sr-only"
                  />
                  Chat
                </label>
                <label
                  className={cn(
                    "relative cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-[color,background-color,box-shadow]",
                    "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                    isAgent
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <input
                    type="radio"
                    name={executionModeRadioName}
                    value="tools"
                    checked={isAgent}
                    onChange={() => onSelectExecutionMode("tools")}
                    className="sr-only"
                  />
                  {isDev ? "Agent·dev" : "Agent"}
                </label>
              </div>
            </div>
            <fieldset aria-label={t("chat.runtime.controls")} className="border-0 px-2.5">
              <label
                htmlFor={`${executionModeRadioName}-web`}
                className="flex h-8 cursor-pointer items-center justify-between gap-2"
              >
                <span>{t("chat.runtime.webSearch")}</span>
                <Switch
                  id={`${executionModeRadioName}-web`}
                  checked={nativeWebSearchSupported && chatRuntimeControls.nativeWebSearchEnabled}
                  disabled={disabled || !nativeWebSearchSupported}
                  aria-label={t("chat.runtime.webSearch")}
                  onCheckedChange={(checked) =>
                    onChatRuntimeControlsChange({ nativeWebSearchEnabled: checked })
                  }
                />
              </label>
            </fieldset>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="mb-1.5 shrink-0 border-b border-border/60 pb-1.5">
              <button
                type="button"
                data-model-back
                onClick={() => showView("root")}
                className={cn(
                  "flex h-7 w-full items-center gap-1.5 rounded-lg px-2",
                  "text-left text-[11px] text-muted-foreground",
                  "hover:bg-settings-active/60 hover:text-foreground",
                  "focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <ChevronRight className="size-3 shrink-0 rotate-180" />
                <span className="shrink-0 font-medium">
                  {t(view === "model" ? "chat.selectModel" : "chat.runtime.reasoning")}
                </span>
                {view === "reasoning" && (
                  <span className="ml-auto min-w-0 truncate">{triggerLabel}</span>
                )}
              </button>
            </div>
            {view === "model" ? (
              <ModelPickerContent
                options={modelOptions}
                value={selectedValue}
                searchInputRef={searchInputRef}
                onRefresh={onRefreshModels}
                refreshing={modelsRefreshing}
                onSelect={(value) => {
                  const parsed = parseModelValue(value);
                  if (!parsed) return;
                  onSelectModel(parsed);
                  showView("root");
                }}
                onOpenProvider={(providerId) => {
                  setIsModelPickerOpen(false);
                  onOpenSettings("providers", providerId);
                }}
              />
            ) : (
              <div className="space-y-1 overflow-y-auto">
                {showEffortBar ? (
                  <div
                    role="radiogroup"
                    aria-label={t("chat.runtime.reasoning")}
                    className="flex flex-col gap-0.5"
                  >
                    {effortChoices.map((level) => (
                      <label
                        key={level}
                        className={cn(
                          "flex h-8 cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5",
                          "hover:bg-settings-active/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                          selectedEffort === level && "bg-settings-active/60",
                        )}
                      >
                        <input
                          type="radio"
                          name={`${executionModeRadioName}-reasoning`}
                          value={level}
                          checked={selectedEffort === level}
                          className="sr-only"
                          onChange={() => {
                            if (level === "off")
                              onChatRuntimeControlsChange({ thinkingEnabled: false });
                            else
                              onChatRuntimeControlsChange({
                                thinkingEnabled: true,
                                reasoning: level,
                              });
                          }}
                        />
                        {t(REASONING_I18N_KEYS[level])}
                        {selectedEffort === level && <Check className="size-3.5" />}
                      </label>
                    ))}
                  </div>
                ) : (
                  <RuntimeToggleChip
                    pressed={thinkingOn}
                    disabled={disabled || !thinkingSupported || thinkingAlwaysOn}
                    label={t("chat.runtime.thinking")}
                    ariaLabel={
                      thinkingOn ? t("chat.runtime.thinkingOn") : t("chat.runtime.thinkingOff")
                    }
                    pressedClassName="bg-muted text-foreground"
                    icon={
                      thinkingOn ? (
                        <Lightbulb className="size-3.5" />
                      ) : (
                        <LightbulbOff className="size-3.5" />
                      )
                    }
                    onClick={() =>
                      onChatRuntimeControlsChange({
                        thinkingEnabled: !chatRuntimeControls.thinkingEnabled,
                      })
                    }
                  />
                )}
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});
