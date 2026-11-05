import {
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  isAgentDevMode,
  isAgentExecutionMode,
  type ReasoningLevel,
} from "@liveagent/app/lib/settings";
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Layers,
  RotateCcw,
  Settings2,
} from "@liveagent/ui/components/IconSet";
import { ModelPickerContent } from "@liveagent/ui/components/models/ModelPickerContent";
import { ProviderBrandIcon } from "@liveagent/ui/components/ProviderBrandIcon";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import { SwitchIndicator } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { parseModelValue } from "../../lib/models/modelValue";
import { TooltipButton } from "../ui/tooltip-button";
import type { ComposerModelControlsProps } from "./ComposerModelControls";
import { ReasoningSlider } from "./ReasoningSlider";

const effortCopy: Record<ReasoningLevel, readonly [string, string, string, string]> = {
  off: [
    "直接",
    "适合直接问答，不额外请求思考。",
    "Direct",
    "For direct answers, without additional reasoning.",
  ],
  minimal: [
    "轻快",
    "较少推敲，适合明确、简单的问题。",
    "Quick",
    "Less deliberation for simple, well-defined questions.",
  ],
  low: [
    "轻度",
    "适合日常整理、简短改写和明确的任务。",
    "Light",
    "For everyday tasks, short rewrites and clear requests.",
  ],
  medium: [
    "标准",
    "兼顾响应速度与分析，适合多数日常任务。",
    "Standard",
    "Balance response time and analysis for everyday work.",
  ],
  high: [
    "深入",
    "适合多步骤分析、比较方案和检查细节。",
    "Deep",
    "For multi-step analysis, comparing options and checking details.",
  ],
  xhigh: [
    "更深入",
    "投入更多思考，适合复杂推演，通常等待更久。",
    "Deeper",
    "More reasoning for complex analysis, usually with a longer wait.",
  ],
  max: [
    "最高",
    "请求最高档思考投入，通常等待更久。",
    "Maximum",
    "Request the highest reasoning level, usually taking longer.",
  ],
};

/** One visual control with two direct targets; model/runtime authority stays with its host. */
export function ComposerInlineModelControls(props: ComposerModelControlsProps) {
  const { t, locale } = useLocale();
  const zh = locale?.startsWith("zh") ?? true;
  const id = useId();
  const modelId = `${id}-model`;
  const effortId = `${id}-effort`;
  const descriptionId = `${id}-description`;
  const [localOpen, setLocalOpen] = useState(false);
  const [view, setView] = useState<"effort" | "models">("models");
  const [helpOpen, setHelpOpen] = useState(false);
  const open = props.open ?? localOpen;
  const triggerRequestedOpen = useRef(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const lastSurface = useRef<{ key: string; height: number } | null>(null);
  const option = props.modelOptions.find((item) => item.value === props.selectedValue);
  const modelLabel = option?.label ?? props.currentModelLabel;
  const supported = props.reasoningOptions.length > 0 || props.thinkingAlwaysOn;
  const reasoning = props.reasoningOptions.includes(props.chatRuntimeControls.reasoning)
    ? props.chatRuntimeControls.reasoning
    : props.reasoningOptions.includes(DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning)
      ? DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning
      : (props.reasoningOptions.at(-1) ?? DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning);
  const selected: ReasoningLevel =
    supported && (props.thinkingAlwaysOn || props.chatRuntimeControls.thinkingEnabled)
      ? reasoning
      : "off";
  const choices: ReasoningLevel[] = props.thinkingAlwaysOn
    ? props.reasoningOptions.filter((level) => level !== "off")
    : ["off", ...props.reasoningOptions.filter((level) => level !== "off")];
  const canAdjust = supported && choices.length > 1;
  const nativeSearchSupported = option?.nativeWebSearchSupported === true;
  const nativeSearchOn = nativeSearchSupported && props.chatRuntimeControls.nativeWebSearchEnabled;
  const [preview, setPreview] = useState<ReasoningLevel | null>(null);
  const previewRef = useRef<{ level: ReasoningLevel; model?: string } | null>(null);
  const displayed =
    previewRef.current?.model === props.selectedValue ? (preview ?? selected) : selected;
  const index = Math.max(0, choices.indexOf(displayed));
  const copy = (level: ReasoningLevel) => ({
    label: effortCopy[level][zh ? 0 : 2],
    description: effortCopy[level][zh ? 1 : 3],
  });
  const defaultLevel = choices.includes(DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning)
    ? DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning
    : (choices.at(-1) ?? selected);
  const modelView = !canAdjust || view === "models";
  const coarsePointer = () =>
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none) and (pointer: coarse)").matches;

  useEffect(() => {
    if (props.thinkingAlwaysOn && !props.chatRuntimeControls.thinkingEnabled)
      props.onChatRuntimeControlsChange({ thinkingEnabled: true });
  }, [
    props.thinkingAlwaysOn,
    props.chatRuntimeControls.thinkingEnabled,
    props.onChatRuntimeControlsChange,
  ]);
  useEffect(() => {
    if (props.open) {
      if (!triggerRequestedOpen.current) {
        setView("models");
      }
      triggerRequestedOpen.current = false;
    }
  }, [props.open]);
  useEffect(() => {
    if (!open) {
      previewRef.current = null;
      setPreview(null);
      setHelpOpen(false);
    }
  }, [open]);
  // A pending drag belongs to its original model. A late blur must never patch another model.
  useEffect(() => {
    if (previewRef.current?.model !== props.selectedValue) {
      previewRef.current = null;
      setPreview(null);
    }
  }, [props.selectedValue]);
  // The same surface changes height, never the scale of text. Cleanup samples an
  // interrupted animation so a fast reversal continues from the visible height.
  useLayoutEffect(() => {
    const surface = popupRef.current;
    if (!open || !surface) {
      lastSurface.current = null;
      return;
    }
    const key = `${modelView}:${helpOpen}`;
    const previous = lastSurface.current;
    const height = surface.getBoundingClientRect().height;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const animation =
      previous && previous.key !== key && !reduceMotion && surface.animate
        ? surface.animate([{ height: `${previous.height}px` }, { height: `${height}px` }], {
            duration: 180,
            easing: "cubic-bezier(0.23, 1, 0.32, 1)",
          })
        : undefined;
    lastSurface.current = { key, height };
    return () => {
      lastSurface.current = { key, height: surface.getBoundingClientRect().height };
      animation?.cancel();
    };
  }, [open, modelView, helpOpen]);

  function setOpen(next: boolean) {
    if (props.open === undefined) setLocalOpen(next);
    props.onOpenChange?.(next);
  }
  function selectEffort(level: ReasoningLevel) {
    if (props.disabled || level === selected) return;
    props.onChatRuntimeControlsChange(
      level === "off" ? { thinkingEnabled: false } : { thinkingEnabled: true, reasoning: level },
    );
  }
  function commitPreview() {
    const pending = previewRef.current;
    previewRef.current = null;
    setPreview(null);
    if (pending && pending.model === props.selectedValue && choices.includes(pending.level))
      selectEffort(pending.level);
  }
  function cancelPreview() {
    previewRef.current = null;
    setPreview(null);
  }
  function showView(next: "effort" | "models") {
    commitPreview();
    setView(next);
    setHelpOpen(false);
    requestAnimationFrame(() => {
      if (coarsePointer()) popupRef.current?.focus();
      else if (next === "models") searchRef.current?.focus();
      else sliderRef.current?.focus();
    });
  }

  return (
    <div className="composer-inline-model-controls" data-inline-model-controls="">
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          const trigger = details.trigger?.id;
          // Internal navigation can change the visible page without changing Base UI's
          // active trigger. Pressing that trigger again should still go to its page.
          if (!next && details.reason === "trigger-press" && open) {
            const nextView =
              trigger === effortId ? "effort" : trigger === modelId ? "models" : null;
            if (nextView && nextView !== (modelView ? "models" : "effort")) {
              details.cancel();
              showView(nextView);
              return;
            }
          }
          if (next && (trigger === modelId || trigger === effortId)) {
            triggerRequestedOpen.current = true;
            showView(trigger === effortId ? "effort" : "models");
          }
          if (!next && details.reason === "escape-key") cancelPreview();
          setOpen(next);
        }}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: This composite group contains two popup actions, not form fields; the div is also their shared positioning anchor. */}
        <div
          ref={anchorRef}
          className="composer-model-capsule"
          role="group"
          aria-label={zh ? "模型与思考程度" : "Model and reasoning"}
          data-open={open ? "true" : undefined}
        >
          <PopoverTrigger
            id={modelId}
            render={
              <TooltipButton
                variant="ghost"
                disabled={props.disabled || !props.hasModels}
                data-composer-model-trigger
                aria-label={`${t("chat.selectModel")}: ${modelLabel}`}
                title={open ? undefined : `${t("chat.selectModel")}: ${modelLabel}`}
                className="composer-inline-model-trigger"
              />
            }
          >
            {option ? (
              <ProviderBrandIcon type={option.providerType} model={option.model} />
            ) : (
              <Layers className="size-4" />
            )}
            <span className="composer-inline-model-label">{modelLabel}</span>
            {!canAdjust ? <ChevronDown className="composer-inline-chevron" /> : null}
          </PopoverTrigger>
          {canAdjust ? (
            <>
              <span className="composer-capsule-divider" aria-hidden="true" />
              <PopoverTrigger
                id={effortId}
                render={
                  <TooltipButton
                    variant="ghost"
                    disabled={props.disabled || !props.hasModels}
                    aria-label={`${t("chat.runtime.reasoning")}: ${copy(selected).label}`}
                    title={open ? undefined : t("chat.runtime.reasoning")}
                    className="composer-inline-effort-trigger"
                  />
                }
              >
                <span>{copy(selected).label}</span>
                <ChevronDown className="composer-inline-chevron" />
              </PopoverTrigger>
            </>
          ) : null}
        </div>
        <PopoverContent
          ref={popupRef}
          anchor={anchorRef.current ?? undefined}
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          aria-label={modelView ? t("chat.selectModel") : t("chat.runtime.reasoning")}
          className={`composer-config-popup ${modelView ? "composer-model-popup" : "composer-reasoning-popup"}`}
          data-view={modelView ? "models" : "effort"}
          initialFocus={(type) =>
            type === "touch" || coarsePointer()
              ? popupRef.current
              : modelView
                ? searchRef.current
                : sliderRef.current
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") cancelPreview();
            else event.stopPropagation();
          }}
        >
          {modelView ? (
            <>
              <div className="composer-model-popup-heading">
                <span>{t("chat.selectModel")}</span>
                {canAdjust ? (
                  <TooltipButton
                    variant="ghost"
                    className="composer-popup-effort-link"
                    title={t("chat.runtime.reasoning")}
                    aria-label={zh ? "调整思考程度" : "Adjust reasoning"}
                    onClick={() => showView("effort")}
                  >
                    <span>{copy(selected).label}</span>
                    <ChevronRight className="size-3" />
                  </TooltipButton>
                ) : null}
              </div>
              <ModelPickerContent
                options={props.modelOptions}
                value={props.selectedValue}
                revealSelected
                searchInputRef={searchRef}
                onRefresh={props.onRefreshModels}
                refreshing={props.modelsRefreshing}
                onSelect={(value) => {
                  const parsed = parseModelValue(value);
                  if (!parsed || props.disabled) return;
                  cancelPreview();
                  props.onSelectModel(parsed);
                  setOpen(false);
                }}
                onOpenProvider={(providerId) => {
                  setOpen(false);
                  props.onOpenSettings("providers", providerId);
                }}
              />
              <div className="composer-model-toolbar">
                <TooltipButton
                  variant="ghost"
                  className="composer-model-settings"
                  aria-label={zh ? "高级设置" : "Advanced settings"}
                  onClick={() => {
                    cancelPreview();
                    setOpen(false);
                    props.onOpenSettings("model-preferences");
                  }}
                >
                  <Settings2 className="size-3.5" />
                  <span>{zh ? "高级设置" : "Settings"}</span>
                </TooltipButton>
                {props.showExecutionControls ? (
                  <>
                    <div
                      role="radiogroup"
                      aria-label={t("settings.executionMode")}
                      className="composer-runtime-radio za-segmented"
                    >
                      <label
                        className="za-segment"
                        data-segment="text"
                        title={zh ? "对话" : "Chat"}
                      >
                        <input
                          type="radio"
                          name={`${id}-execution`}
                          value="text"
                          checked={!isAgentExecutionMode(props.executionMode)}
                          disabled={props.disabled}
                          onChange={() => props.onSelectExecutionMode("text")}
                          className="sr-only"
                        />
                        Chat
                      </label>
                      <label
                        className="za-segment"
                        data-segment="tools"
                        title={zh ? "执行任务" : "Run tasks"}
                      >
                        <input
                          type="radio"
                          name={`${id}-execution`}
                          value="tools"
                          checked={isAgentExecutionMode(props.executionMode)}
                          disabled={props.disabled}
                          onChange={() => props.onSelectExecutionMode("tools")}
                          className="sr-only"
                        />
                        {isAgentDevMode(props.executionMode) ? "Agent·dev" : "Agent"}
                      </label>
                    </div>
                    <TooltipButton
                      variant="ghost"
                      role="switch"
                      className="composer-model-web"
                      aria-label={t("chat.runtime.webSearch")}
                      aria-checked={nativeSearchOn}
                      title={
                        !nativeSearchSupported
                          ? zh
                            ? "当前模型不支持联网"
                            : "Web search is unavailable for this model"
                          : nativeSearchOn
                            ? zh
                              ? "联网已开启"
                              : "Web search on"
                            : zh
                              ? "联网已关闭"
                              : "Web search off"
                      }
                      disabled={props.disabled || !nativeSearchSupported}
                      onClick={() => {
                        if (!props.disabled && nativeSearchSupported)
                          props.onChatRuntimeControlsChange({
                            nativeWebSearchEnabled: !nativeSearchOn,
                          });
                      }}
                    >
                      <span>{zh ? "联网" : "Web"}</span>
                      <SwitchIndicator checked={nativeSearchOn} size="sm" />
                    </TooltipButton>
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="composer-reasoning-heading">
                <TooltipButton
                  variant="ghost"
                  className="composer-reasoning-help"
                  aria-expanded={helpOpen}
                  aria-controls={descriptionId}
                  aria-label={zh ? "了解当前思考档位" : "About this reasoning level"}
                  title={zh ? "了解当前档位" : "About this level"}
                  onClick={() => setHelpOpen((old) => !old)}
                >
                  <CircleHelp className="size-4" />
                </TooltipButton>
                <div className="composer-reasoning-title">
                  <span className="composer-reasoning-value" aria-live="polite">
                    <span key={displayed} className="composer-reasoning-value-text">
                      {copy(displayed).label}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="composer-reasoning-model"
                    disabled={props.disabled}
                    onClick={() => showView("models")}
                    aria-label={`${t("chat.selectModel")}: ${modelLabel}`}
                  >
                    <span>{modelLabel}</span>
                    <ChevronRight className="size-3" />
                  </button>
                </div>
                <TooltipButton
                  variant="ghost"
                  className="composer-reasoning-reset"
                  title={
                    zh
                      ? `恢复默认思考：${copy(defaultLevel).label}`
                      : `Reset reasoning to ${copy(defaultLevel).label}`
                  }
                  aria-label={zh ? "恢复默认思考" : "Reset reasoning"}
                  disabled={props.disabled || displayed === defaultLevel}
                  onClick={() => {
                    cancelPreview();
                    selectEffort(defaultLevel);
                  }}
                >
                  <RotateCcw className="size-4" />
                </TooltipButton>
              </div>
              <ReasoningSlider
                key={props.selectedValue ?? modelLabel}
                value={index}
                max={choices.length - 1}
                label={t("chat.runtime.reasoning")}
                valueText={`${copy(displayed).label} · ${modelLabel}`}
                describedBy={descriptionId}
                disabled={props.disabled}
                inputRef={sliderRef}
                onPreview={(next) => {
                  const level = choices[next];
                  if (level) {
                    previewRef.current = { level, model: props.selectedValue };
                    setPreview(level);
                  }
                }}
                onCommit={commitPreview}
                onCancel={cancelPreview}
              />
              <p
                className={helpOpen ? "composer-reasoning-description" : "sr-only"}
                id={descriptionId}
              >
                {copy(displayed).description}
              </p>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
