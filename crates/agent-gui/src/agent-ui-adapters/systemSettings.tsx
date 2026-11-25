import { invoke } from "@liveagent/app/shims/tauriCore";
import { RefreshCw } from "@liveagent/ui/components/IconSet";
import { installedWorkspaceEditorTargets } from "@liveagent/ui/components/project-tools/WorkspaceEditorMenuItems";
import {
  SettingsSelectContent,
  SettingsSelectTrigger,
} from "@liveagent/ui/components/settings/SettingsSelect";
import { Button, RefreshButton } from "@liveagent/ui/components/ui/button";
import { Select, SelectItem, SelectValue } from "@liveagent/ui/components/ui/select";
import { useLocale } from "@liveagent/ui/i18n/index";
import { updateRunCompletionSound, updateRunNotifications } from "@liveagent/ui/lib/settings/index";
import {
  refreshWorkspaceEditors,
  setPreferredWorkspaceEditor,
  useWorkspaceEditors,
} from "@liveagent/ui/lib/tools/workspaceEditors";
import {
  AgentActivationSwitch,
  SettingsGroup,
  SettingsRow,
} from "@liveagent/ui/pages/settings/shared";
import { useMemo, useState } from "react";
import { isTauriHost, supportsNativeWorkspaceEditors } from "../lib/host";
import { completionSoundPlayer } from "../lib/notifications/completionSound";
import { inferRuntimePlatform } from "../lib/runtimePlatform";
import { CLOSE_WINDOW_BEHAVIOR_OPTIONS } from "../lib/settings";
import { useTrayPrefs, writeTrayPrefs } from "../lib/tray/trayPrefs";
import type { SettingsSectionProps } from "../pages/settings/types";

export {
  buildFontFamilySelectOptions,
  FONT_FAMILY_CUSTOM_SELECT_VALUE,
  FONT_FAMILY_DEFAULT_SELECT_VALUE,
  fromFontFamilySelectValue,
  toFontFamilySelectValue,
} from "@liveagent/ui/lib/shared/fontFamily";

let fontFamiliesRequest: Promise<string[]> | undefined;

export function listLocalFontFamilies(): Promise<string[]> {
  fontFamiliesRequest ??= invoke<string[]>("system_list_font_families").catch(() => {
    fontFamiliesRequest = undefined;
    return [];
  });
  return fontFamiliesRequest;
}

export function SystemSettingsExtensions(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const trayPrefs = useTrayPrefs();
  const isMacPlatform = useMemo(() => inferRuntimePlatform() === "macos", []);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [testingNotification, setTestingNotification] = useState(false);

  return (
    <>
      {isTauriHost() && (
        <SettingsGroup title={t("settings.notificationsGroup")}>
          <SettingsRow
            title={t("settings.runNotifications")}
            description={t("settings.runNotificationsDesc")}
            control={
              <AgentActivationSwitch
                checked={settings.customSettings.runNotifications}
                title={t("settings.runNotifications")}
                onToggle={() =>
                  setSettings((prev) =>
                    updateRunNotifications(prev, !prev.customSettings.runNotifications),
                  )
                }
              />
            }
          />
          <SettingsRow
            data-settings-anchor="run-completion-sound"
            title={t("settings.runCompletionSound")}
            description={t("settings.runCompletionSoundDesc")}
            control={
              <AgentActivationSwitch
                checked={settings.customSettings.runCompletionSound}
                title={t("settings.runCompletionSound")}
                onToggle={() => {
                  const enabled = !settings.customSettings.runCompletionSound;
                  if (enabled) completionSoundPlayer().unlock();
                  setSettings((prev) => updateRunCompletionSound(prev, enabled));
                }}
              />
            }
          />
        </SettingsGroup>
      )}
      {isTauriHost() && (
        <SettingsGroup title={t("settings.calendarNotifications")}>
          <SettingsRow
            title={t("settings.notificationTest")}
            description={t("settings.notificationTestHint")}
            control={
              <Button
                disabled={testingNotification}
                onClick={async () => {
                  setTestingNotification(true);
                  setNotificationMessage("");
                  try {
                    await invoke("planning_notification_test");
                    setNotificationMessage(t("settings.notificationSubmitted"));
                  } catch (error) {
                    setNotificationMessage(String(error));
                  } finally {
                    setTestingNotification(false);
                  }
                }}
              >
                {t("settings.notificationTest")}
              </Button>
            }
          />
          {notificationMessage && (
            <p role="status" className="text-sm">
              {notificationMessage}
            </p>
          )}
        </SettingsGroup>
      )}
      {supportsNativeWorkspaceEditors() && <PreferredWorkspaceEditorSettings />}
      <SettingsGroup title={t("settings.closeWindowBehavior")}>
        <SettingsRow
          title={t("settings.defaultCloseWindowBehavior")}
          description={
            settings.closeWindowBehavior === "minimize"
              ? t("settings.closeWindowMinimizeDesc")
              : t("settings.closeWindowExitDesc")
          }
          control={
            <Select
              value={settings.closeWindowBehavior}
              onValueChange={(value) =>
                setSettings((previous) => ({
                  ...previous,
                  closeWindowBehavior: value as (typeof CLOSE_WINDOW_BEHAVIOR_OPTIONS)[number],
                }))
              }
            >
              <SettingsSelectTrigger className="min-w-32 justify-between">
                <SelectValue>
                  {settings.closeWindowBehavior === "minimize"
                    ? t("settings.closeWindowMinimize")
                    : t("settings.closeWindowExit")}
                </SelectValue>
              </SettingsSelectTrigger>
              <SettingsSelectContent>
                {CLOSE_WINDOW_BEHAVIOR_OPTIONS.map((behavior) => (
                  <SelectItem key={behavior} value={behavior}>
                    {behavior === "minimize"
                      ? t("settings.closeWindowMinimize")
                      : t("settings.closeWindowExit")}
                  </SelectItem>
                ))}
              </SettingsSelectContent>
            </Select>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.trayTitle")}>
        <SettingsRow
          title={t("settings.trayShowTitles")}
          description={t("settings.trayShowTitlesDesc")}
          control={
            <AgentActivationSwitch
              checked={trayPrefs.showConversationTitles}
              title={t("settings.trayShowTitles")}
              onToggle={() =>
                writeTrayPrefs({ showConversationTitles: !trayPrefs.showConversationTitles })
              }
            />
          }
        />
        {isMacPlatform ? (
          <SettingsRow
            title={t("settings.trayRunningBadge")}
            description={t("settings.trayRunningBadgeDesc")}
            control={
              <AgentActivationSwitch
                checked={trayPrefs.showRunningBadge}
                title={t("settings.trayRunningBadge")}
                onToggle={() => writeTrayPrefs({ showRunningBadge: !trayPrefs.showRunningBadge })}
              />
            }
          />
        ) : null}
      </SettingsGroup>
    </>
  );
}

function PreferredWorkspaceEditorSettings() {
  const { t } = useLocale();
  const { targets, preferredEditor, loaded } = useWorkspaceEditors(true);
  const [refreshing, setRefreshing] = useState(false);
  const editorOptions = installedWorkspaceEditorTargets(targets).filter(
    ({ terminal }) => !terminal,
  );
  const selected = editorOptions.find(({ id }) => id === preferredEditor);
  return (
    <SettingsGroup
      title={t("settings.workspaceEditorGroup")}
      data-settings-anchor="preferred-workspace-editor"
    >
      <SettingsRow
        title={t("settings.preferredWorkspaceEditor")}
        description={t(
          loaded && editorOptions.length === 0
            ? "settings.workspaceEditorNoneDetected"
            : "settings.preferredWorkspaceEditorDesc",
        )}
        control={
          <div className="flex items-center gap-2">
            <RefreshButton
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("settings.workspaceEditorRefresh")}
              title={t("settings.workspaceEditorRefresh")}
              aria-busy={refreshing || !loaded}
              onClick={async () => {
                setRefreshing(true);
                try {
                  await refreshWorkspaceEditors();
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              <RefreshCw data-refresh-icon className="size-4" />
            </RefreshButton>
            {editorOptions.length > 0 && (
              <Select
                value={selected?.id ?? "automatic"}
                onValueChange={(value) => {
                  if (typeof value === "string")
                    setPreferredWorkspaceEditor(value === "automatic" ? "" : value);
                }}
              >
                <SettingsSelectTrigger
                  aria-label={t("settings.preferredWorkspaceEditor")}
                  className="min-w-36 justify-between"
                >
                  <SelectValue>
                    {selected?.label ?? t("settings.workspaceEditorAutomatic")}
                  </SelectValue>
                </SettingsSelectTrigger>
                <SettingsSelectContent>
                  <SelectItem value="automatic">
                    {t("settings.workspaceEditorAutomatic")}
                  </SelectItem>
                  {editorOptions.map(({ id, label }) => (
                    <SelectItem key={id} value={id}>
                      {label}
                    </SelectItem>
                  ))}
                </SettingsSelectContent>
              </Select>
            )}
          </div>
        }
      />
    </SettingsGroup>
  );
}
