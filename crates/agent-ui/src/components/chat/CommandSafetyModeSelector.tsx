import { setUpOfflineSandbox, useSandboxCapability } from "@liveagent/adapters/sandboxCapability";
import type { CommandSafetyMode } from "@liveagent/app/lib/settings";
import {
  Check,
  Hand,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  SquarePen,
  Wrench,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import { COMPOSER_CONTROL_TRIGGER_CLASS } from "@liveagent/ui/lib/chat/composerControlStyles";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";
import { OfflineSandboxSetupDialog } from "./OfflineSandboxSetupDialog";

const MODE_I18N_KEYS: Record<CommandSafetyMode, string> = {
  ask: "chat.safety.ask",
  autoEdit: "chat.safety.autoEdit",
  always: "chat.safety.always",
  autoReview: "chat.safety.autoReview",
  sandbox: "chat.safety.sandbox",
  sandboxOffline: "chat.safety.sandboxOffline",
};

const MODE_DESC_I18N_KEYS: Record<CommandSafetyMode, string> = {
  ask: "chat.safety.askDesc",
  autoEdit: "chat.safety.autoEditDesc",
  always: "chat.safety.alwaysDesc",
  autoReview: "chat.safety.autoReviewDesc",
  sandbox: "chat.safety.sandboxDesc",
  sandboxOffline: "chat.safety.sandboxOfflineDesc",
};

const SAFETY_MODES = [
  "ask",
  "autoEdit",
  "autoReview",
  "sandbox",
  "sandboxOffline",
  "always",
] as const;

/**
 * 读掩蔽是平台/后端相关的能力,不能作为跨平台的肯定承诺(P2#7)。
 * macOS 用 `(deny file-read* (subpath …))`、Linux 用 `--tmpfs` 掩蔽,文案成立;
 * Windows 的联网后端是 WRITE_RESTRICTED 受限令牌 —— 限制性 SID 只参与"写"判定,
 * 读/执行跳过第二遍,且写 ACE 只授不撤,**没有任何读掩蔽**。若沿用同一句"敏感目录
 * 不可读",Windows 用户会据此认为凭据受保护而在沙箱模式下跑不可信代码,而这恰恰是
 * 可联网的后端(~/.ssh、%USERPROFILE%\.aws\credentials、config.sqlite 里的 provider
 * key 都可读并外传)。故该平台改用不含读掩蔽承诺的文案。
 * 断网后端(AppContainer)默认拒读,顺带获得掩蔽,sandboxOffline 文案不受影响。
 */
const MECHANISMS_WITHOUT_READ_MASKING: ReadonlySet<string> = new Set(["restricted-token"]);

function modeIcon(mode: CommandSafetyMode, className: string) {
  if (mode === "ask") return <Hand className={className} />;
  if (mode === "autoEdit") return <SquarePen className={className} />;
  if (mode === "autoReview") return <ShieldCheck className={className} />;
  if (mode === "always") return <ShieldAlert className={className} />;
  if (mode === "sandboxOffline") return <ShieldOff className={className} />;
  return <Shield className={className} />;
}

function triggerIconClass(mode: CommandSafetyMode) {
  if (mode === "sandbox" || mode === "sandboxOffline") {
    return "size-4 shrink-0 text-emerald-600 dark:text-emerald-400";
  }
  if (mode === "ask") return "size-4 shrink-0 text-sky-600 dark:text-sky-400";
  if (mode === "always") return "size-4 shrink-0 text-amber-600 dark:text-amber-400";
  return "size-4 shrink-0 text-muted-foreground";
}

export function CommandSafetyModeSelector(props: {
  value: CommandSafetyMode;
  disabled?: boolean;
  mobileBlock?: boolean;
  onChange: (mode: CommandSafetyMode) => void;
}) {
  const { value, disabled, mobileBlock, onChange } = props;
  const { t } = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const capability = useSandboxCapability();
  const [setupOpen, setSetupOpen] = useState(false);
  const canSetUpOffline =
    !disabled && capability?.path_protection !== false && capability?.setup_available === true;
  // Only the execution backend can confirm that it can enforce the requested isolation.
  const sandboxUnavailable =
    capability?.supported !== true || capability?.path_protection === false;
  const offlineUnavailable = sandboxUnavailable || capability?.network_control !== true;
  const sandboxLacksReadMasking =
    capability === null ||
    capability.read_masking === false ||
    MECHANISMS_WITHOUT_READ_MASKING.has(capability.mechanism);
  const disabledHint =
    capability === null
      ? t("chat.safety.sandboxCapabilityUnknown")
      : sandboxUnavailable && capability.platform === "windows"
        ? t("chat.safety.sandboxNativeWindows")
        : [
            t(
              sandboxUnavailable
                ? "chat.safety.sandboxUnavailable"
                : "chat.safety.sandboxOfflineUnavailable",
            ),
            capability.reason,
          ]
            .filter(Boolean)
            .join(" · ");
  const modeDescKey = (mode: CommandSafetyMode) =>
    mode === "sandbox" && sandboxLacksReadMasking
      ? "chat.safety.sandboxDescNoReadMask"
      : MODE_DESC_I18N_KEYS[mode];
  // 当前值本身不可用(如设置同步自 macOS,本机是 Windows)时仍显示,但标红提示
  // 由执行层报错兜底;这里不做静默改写,避免设置回写抖动。
  const selected = SAFETY_MODES.includes(value) ? value : "ask";
  const selectedLabel = t(MODE_I18N_KEYS[selected]);

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              disabled={disabled}
              data-composer-option-block={mobileBlock ? "" : undefined}
              className={
                mobileBlock
                  ? "composer-safety-block min-w-11 shrink-0 justify-start gap-1.5 px-2 text-xs"
                  : cn(
                      COMPOSER_CONTROL_TRIGGER_CLASS,
                      "w-8 justify-center gap-0 px-0",
                      "data-popup-open:bg-muted/60 web:max-480:flex-none web:max-480:w-8 web:max-480:min-w-8 web:max-480:justify-center web:max-480:gap-0 web:max-480:px-0",
                    )
              }
            />
          }
          title={selectedLabel}
          aria-label={`${t("chat.safety.label")}: ${selectedLabel}`}
        >
          {modeIcon(selected, triggerIconClass(selected))}
          {mobileBlock && <span className="truncate">{selectedLabel}</span>}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          variant="soft"
          className="flex w-[324px] max-w-[calc(100vw-16px)] flex-col gap-0.5"
          side="top"
          align="start"
        >
          {SAFETY_MODES.map((mode) => {
            const entryDisabled =
              mode === "sandbox"
                ? sandboxUnavailable
                : mode === "sandboxOffline"
                  ? offlineUnavailable
                  : false;
            const isSelected = mode === selected;
            const item = (
              <DropdownMenuItem
                key={mode}
                disabled={entryDisabled}
                onSelect={() => {
                  if (entryDisabled) return;
                  onChange(mode);
                }}
                className={cn(
                  "h-auto shrink-0 items-start gap-2.5 py-2 text-xs whitespace-normal",
                  mobileBlock && "min-h-11",
                  isSelected && "bg-accent text-accent-foreground",
                )}
              >
                {modeIcon(mode, "mt-0.5 size-3.5 shrink-0 text-muted-foreground")}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium leading-4">{t(MODE_I18N_KEYS[mode])}</span>
                  <span className="text-tiny font-normal leading-4 text-muted-foreground">
                    {entryDisabled ? disabledHint : t(modeDescKey(mode))}
                  </span>
                </span>
                {isSelected ? (
                  <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
                ) : (
                  <span className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                )}
              </DropdownMenuItem>
            );
            if (mode !== "sandboxOffline" || !entryDisabled || !canSetUpOffline) return item;
            return [
              item,
              <DropdownMenuItem
                key="setup-offline-sandbox"
                onSelect={() => setSetupOpen(true)}
                title={capability?.setup_hint || undefined}
                className="h-auto shrink-0 items-start gap-2.5 py-1.5 pl-8 text-xs whitespace-normal"
              >
                <Wrench className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium leading-4">{t("chat.safety.setupOffline")}</span>
                  <span className="text-tiny font-normal leading-4 text-muted-foreground">
                    {t("chat.safety.setupOfflineDesc")}
                  </span>
                </span>
              </DropdownMenuItem>,
            ];
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {setupOpen && (
        <OfflineSandboxSetupDialog
          open={setupOpen}
          hint={capability?.setup_hint}
          onOpenChange={setSetupOpen}
          onRun={setUpOfflineSandbox}
          onUseOffline={() => onChange("sandboxOffline")}
        />
      )}
    </>
  );
}
