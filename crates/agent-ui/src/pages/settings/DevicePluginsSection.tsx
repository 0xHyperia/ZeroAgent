import "@liveagent/ui/i18n/namespaces/settings";
import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import { useCallback } from "react";
import { FolderOpen, Loader2, MoreHorizontal, RefreshCw } from "../../components/IconSet";
import { DeviceUiPreviewDialog } from "../../components/sandboxed-ui/DeviceUiPreviewDialog";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/SettingsLayout";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
import { useConfirmDialog } from "../../components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useLocale } from "../../i18n";
import type { DevicePlugin, DevicePluginsClient } from "../../lib/plugins/devicePlugins";
import type { DeviceUiSurfaceClient } from "../../lib/plugins/deviceUiSurface";
import { useDevicePluginList } from "../../lib/plugins/useDevicePluginList";
import { AgentActivationSwitch } from "./shared";

type Props = { client: DevicePluginsClient; workdir?: string };

export function DevicePluginsSection({ client, workdir }: Props) {
  const { t } = useLocale();
  if (client.installSource === "workspace" && !workdir) {
    return (
      <SettingsSection title={t("settings.devicePlugins.title")}>
        <p className="px-1 text-sm text-muted-foreground">
          {t("settings.devicePlugins.selectWorkspace")}
        </p>
      </SettingsSection>
    );
  }
  return <DevicePluginsList key={workdir} client={client} workdir={workdir} />;
}

function PluginPanelButton({
  load,
  workdir,
  pluginId,
  pluginVersion,
  resourceId,
  title,
}: {
  load: DeviceUiSurfaceClient;
  workdir?: string;
  pluginId: string;
  pluginVersion: string;
  resourceId: string;
  title: string;
}) {
  const read = useCallback(async () => {
    const document = await load({ action: "panel", workdir, pluginId, pluginVersion, resourceId });
    if (!("html" in document)) throw new Error("DEVICE_UI_DOCUMENT_INVALID");
    return document;
  }, [load, workdir, pluginId, pluginVersion, resourceId]);
  return <DeviceUiPreviewDialog label={title} load={read} />;
}

function DevicePluginsList({ client, workdir }: Props) {
  const { t } = useLocale();
  const { list, loading, loadError, busy, actionError, refresh, perform } = useDevicePluginList(
    client,
    workdir,
  );
  const { confirm, dialog } = useConfirmDialog();
  const { pickDirectory, directoryPickerElement } = useDirectoryPicker();
  const canInstall = list?.available && list.installAvailable;

  async function install() {
    if (
      !(await confirm({
        title: t("sandboxedUi.plugins.install"),
        description: t("settings.devicePlugins.installDescription"),
        confirmLabel: t("settings.devicePlugins.chooseFolder"),
        cancelLabel: t("confirmDialog.cancel"),
      }))
    )
      return;
    if (client.installSource === "native") {
      await perform({ action: "install" });
    } else if (workdir) {
      const sourcePath = await pickDirectory(workdir);
      if (sourcePath) await perform({ action: "install", sourcePath });
    }
  }

  async function changeTrust() {
    const trusted = list?.trusted === true;
    if (
      await confirm({
        title: t(trusted ? "settings.devicePlugins.revokeTrust" : "settings.devicePlugins.trust"),
        description: t(
          trusted
            ? "settings.devicePlugins.revokeDescription"
            : "settings.devicePlugins.trustDescription",
        ),
        confirmLabel: t(
          trusted ? "settings.devicePlugins.revokeTrust" : "settings.devicePlugins.trust",
        ),
        cancelLabel: t("confirmDialog.cancel"),
      })
    ) {
      await perform({ action: trusted ? "revokeTrust" : "trust" });
    }
  }

  async function remove(plugin: DevicePlugin) {
    const name = plugin.name || plugin.id;
    if (
      await confirm({
        title: t("sandboxedUi.plugins.removeTitle").replace("{name}", name),
        description: t("sandboxedUi.plugins.removeDescription"),
        confirmLabel: t("sandboxedUi.plugins.remove"),
        cancelLabel: t("confirmDialog.cancel"),
        tone: "destructive",
      })
    ) {
      await perform({ action: "remove", pluginId: plugin.id });
    }
  }

  function pluginRow(plugin: DevicePlugin) {
    const { tools, hooks, prompt, ui } = plugin.contributes;
    const read = client.readSurface;
    const name = plugin.name || plugin.id;
    const source = t(
      plugin.source === "workspace"
        ? "sandboxedUi.plugins.sourceWorkspace"
        : "sandboxedUi.plugins.sourceUser",
    );
    const details = [
      source,
      plugin.version,
      tools.length ? t("sandboxedUi.plugins.tools").replace("{count}", String(tools.length)) : "",
      hooks.length ? t("sandboxedUi.plugins.hooks").replace("{count}", String(hooks.length)) : "",
      prompt ? t("sandboxedUi.plugins.prompt") : "",
      ui.length ? t("sandboxedUi.plugins.panels").replace("{count}", String(ui.length)) : "",
    ].filter(Boolean);
    return (
      <SettingsRow
        key={plugin.id}
        title={name}
        description={
          <>
            <div>{details.join(" · ")}</div>
            {plugin.description ? <div className="break-words">{plugin.description}</div> : null}
            {plugin.enabled && read && ui.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {ui.map((panel) => (
                  <PluginPanelButton
                    key={`${plugin.version}:${panel.id}`}
                    load={read}
                    workdir={workdir}
                    pluginId={plugin.id}
                    pluginVersion={plugin.version}
                    resourceId={panel.id}
                    title={panel.title}
                  />
                ))}
              </div>
            ) : null}
          </>
        }
        control={
          <div className="flex items-center gap-2">
            <AgentActivationSwitch
              checked={plugin.enabled}
              disabled={Boolean(busy)}
              title={`${name} · ${t(plugin.enabled ? "sandboxedUi.plugins.disable" : "sandboxedUi.plugins.enable")}`}
              onToggle={() =>
                void perform({ action: plugin.enabled ? "disable" : "enable", pluginId: plugin.id })
              }
            />
            {plugin.source === "user" ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("settings.devicePlugins.pluginActions").replace("{name}", name)}
                    />
                  }
                  disabled={Boolean(busy)}
                >
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void remove(plugin)}>
                    {t("sandboxedUi.plugins.remove")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        }
      />
    );
  }

  return (
    <SettingsSection
      title={t("settings.devicePlugins.title")}
      description={workdir || t("settings.devicePlugins.userScope")}
      actions={
        list?.available ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={Boolean(busy)}
              onClick={() => void perform({ action: "reload" })}
            >
              <RefreshCw className="size-4" />
              {t("sandboxedUi.plugins.reload")}
            </Button>
            {canInstall ? (
              <Button
                type="button"
                size="sm"
                disabled={Boolean(busy)}
                onClick={() => void install()}
              >
                <FolderOpen className="size-4" />
                {t("sandboxedUi.plugins.install")}
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {loading || busy ? (
        <div role="status" className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t(busy ? "settings.devicePlugins.updating" : "settings.devicePlugins.loading")}
        </div>
      ) : null}
      {loadError ? (
        <SettingsRow
          title={t("settings.devicePlugins.loadError")}
          control={
            <Button variant="outline" size="sm" onClick={refresh}>
              {t("sandboxedUi.plugins.reload")}
            </Button>
          }
        />
      ) : list && !list.available ? (
        <SettingsNotice variant="warning">{t("settings.devicePlugins.unavailable")}</SettingsNotice>
      ) : null}
      {actionError !== null ? (
        <SettingsNotice variant="action-error">
          {t("settings.devicePlugins.updateError")}
        </SettingsNotice>
      ) : null}
      {list?.available && workdir && list.trustAvailable ? (
        <SettingsRow
          title={t("settings.devicePlugins.trustTitle")}
          description={t(
            list.trusted ? "settings.devicePlugins.trusted" : "sandboxedUi.plugins.untrusted",
          )}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(busy)}
              onClick={() => void changeTrust()}
            >
              {t(
                list.trusted
                  ? "settings.devicePlugins.revokeTrust"
                  : "settings.devicePlugins.trust",
              )}
            </Button>
          }
        />
      ) : null}
      {list?.errors.length ? (
        <SettingsNotice variant="warning">{t("sandboxedUi.plugins.errors")}</SettingsNotice>
      ) : null}
      {list?.available && list.plugins.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">{t("sandboxedUi.plugins.emptyTitle")}</p>
      ) : null}
      {list?.plugins.length ? <SettingsCard>{list.plugins.map(pluginRow)}</SettingsCard> : null}
      {dialog}
      {directoryPickerElement}
    </SettingsSection>
  );
}
