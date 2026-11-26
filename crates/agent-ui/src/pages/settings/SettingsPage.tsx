import "@liveagent/ui/i18n/namespaces/settings";
import { createSettingsExtension } from "@liveagent/adapters/settingsExtension";
import type { SttProviderId } from "@liveagent/app/lib/settings";
import type { SettingsPageProps } from "@liveagent/app/pages/settings/types";
import {
  Blend,
  BookOpen,
  Brain,
  Cable,
  CalendarDays,
  ChartColumn,
  Clock3,
  Cloud,
  Cpu,
  Globe,
  Key,
  Mic,
  Plug,
  Settings2,
  ShieldCheck,
  Wrench,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n";
import { settingsSectionLabel } from "@liveagent/ui/lib/settings/settingsSearchIndex";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SettingsSectionDefinition, UiExtensionRegistry } from "../../contracts/registry";
import { AgentsSection } from "./AgentsSection";
import { AIApprovalSection } from "./AIApprovalSection";
import { CalendarSection } from "./CalendarSection";
import { CronSection } from "./CronSection";
import { DevicePluginsSection } from "./DevicePluginsSection";
import { HooksSection } from "./HooksSection";
import { MemoryPanel } from "./memory/MemoryPanel";
import { PermissionRulesSection } from "./PermissionRulesSection";
import { RemoteSection } from "./RemoteSection";
import { ResourceHubSection } from "./ResourceHubSection";
import { SettingsShell } from "./SettingsShell";
import { SshSection } from "./SshSection";
import { SttSection } from "./SttSection";
import { SystemSettingsForm } from "./SystemSettingsForm";
import { SystemToolsSection } from "./SystemToolsSection";
import { UsageStatsSection } from "./UsageStatsSection";
import { WebSearchSection } from "./WebSearchSection";

const EMPTY_SERVICES = {};
const STT_SELECTED_PROVIDER_CACHE = new WeakMap<
  SettingsPageProps["sttSettingsService"],
  SttProviderId
>();

export function SettingsPage(props: SettingsPageProps) {
  const {
    settings,
    setSettings,
    saveState,
    onBack,
    initialSection = "system",
    onSectionChange,
    initialProviderId,
    hiddenSections = [],
    sttSettingsService,
    onSttProviderChange,
    onOpenScheduledTasks,
  } = props;
  const { t } = useLocale();
  const [pendingProviderId, setPendingProviderId] = useState(initialProviderId);
  const [sttSelectedProvider, setSttSelectedProvider] = useState<SttProviderId>(
    () =>
      STT_SELECTED_PROVIDER_CACHE.get(sttSettingsService) ??
      settings.stt.provider ??
      "tencent_cloud",
  );
  const sttSelectionChangedRef = useRef(STT_SELECTED_PROVIDER_CACHE.has(sttSettingsService));
  const extension = createSettingsExtension(props);
  const showLocalRuntimeSettings = !("runtimeKind" in props && props.runtimeKind === "web_chat");
  const permissionRulesScope = props.settingsHost?.permissionRulesScope;
  const rulesBackend = props.settingsHost?.kbrain;
  const devicePlugins = props.settingsHost?.devicePlugins;
  const activePluginProject =
    devicePlugins?.installSource === "native"
      ? settings.system.workspaceProjects.find(
          (project) =>
            project.id === settings.system.activeWorkspaceProjectId &&
            (project.kind === "managed" || project.kind === "folder"),
        )
      : undefined;
  const devicePluginWorkdir = props.settingsHost?.devicePluginWorkdir ?? activePluginProject?.path;
  useEffect(() => setPendingProviderId(initialProviderId), [initialProviderId]);
  useEffect(() => {
    if (!sttSelectionChangedRef.current) {
      setSttSelectedProvider(settings.stt.provider ?? "tencent_cloud");
    }
  }, [settings.stt.provider]);

  const handleSttProviderChange = useCallback(
    (provider: SttProviderId) => {
      sttSelectionChangedRef.current = true;
      STT_SELECTED_PROVIDER_CACHE.set(sttSettingsService, provider);
      setSttSelectedProvider(provider);
      onSttProviderChange?.(provider);
    },
    [onSttProviderChange, sttSettingsService],
  );

  const sections = useMemo<SettingsSectionDefinition<void>[]>(
    () => [
      {
        id: "system",
        groupKey: "settings.groupGeneral",
        groupOrder: 10,
        order: 10,
        labelKey: settingsSectionLabel("system"),
        icon: <Settings2 className={extension.iconClassName} />,
        render: () => (
          <SystemSettingsForm
            settings={settings}
            setSettings={setSettings}
            showLocalRuntimeSettings={showLocalRuntimeSettings}
            htmlPreviewsAvailable={Boolean(devicePlugins?.readSurface)}
            fileRuntime={props.settingsHost?.fileRuntime}
          />
        ),
      },
      {
        id: "providers",
        groupKey: "settings.groupGeneral",
        groupOrder: 10,
        order: 20,
        labelKey: settingsSectionLabel("providers"),
        icon: <Cpu className={extension.iconClassName} />,
        contentMode: "fill",
        render: () =>
          extension.renderProviders({
            initialProviderId: pendingProviderId,
            onInitialProviderHandled: () => setPendingProviderId(undefined),
          }),
      },
      {
        id: "agents",
        groupKey: "settings.groupGeneral",
        groupOrder: 10,
        order: 30,
        labelKey: settingsSectionLabel("agents"),
        icon: <BookOpen className={extension.iconClassName} />,
        render: () => <AgentsSection settings={settings} setSettings={setSettings} />,
      },
      // Only hosts that can reach K-brain's usage API get the page.
      ...(props.settingsHost?.kbrain?.getUsageStats
        ? [
            {
              id: "usage",
              groupKey: "settings.groupGeneral",
              groupOrder: 10,
              order: 40,
              labelKey: settingsSectionLabel("usage"),
              icon: <ChartColumn className={extension.iconClassName} />,
              showSaveIndicator: false,
              render: () =>
                props.settingsHost?.kbrain ? (
                  <UsageStatsSection
                    key={props.settingsHost.usageScope}
                    kbrain={props.settingsHost.kbrain}
                  />
                ) : null,
            } satisfies SettingsSectionDefinition<void>,
          ]
        : []),
      ...(["skills", "mcp"] as const).map((id, index) => ({
        id,
        groupKey: "settings.groupResources",
        groupOrder: 20,
        order: (index + 1) * 10,
        labelKey: settingsSectionLabel(id),
        icon:
          id === "skills" ? (
            <Blend className={extension.iconClassName} />
          ) : (
            <Cable className={extension.iconClassName} />
          ),
        contentMode: "fill" as const,
        render: () => (
          <ResourceHubSection resource={id} settings={settings} setSettings={setSettings} />
        ),
      })),
      ...(showLocalRuntimeSettings && devicePlugins
        ? [
            {
              id: "devicePlugins",
              groupKey: "settings.groupResources",
              groupOrder: 20,
              order: 25,
              labelKey: settingsSectionLabel("devicePlugins"),
              icon: <Plug className={extension.iconClassName} />,
              showSaveIndicator: false,
              render: () => (
                <DevicePluginsSection
                  key={JSON.stringify([
                    props.settingsHost?.devicePluginScope ?? props.settingsHost?.usageScope,
                    devicePluginWorkdir,
                  ])}
                  client={devicePlugins}
                  workdir={devicePluginWorkdir}
                />
              ),
            } satisfies SettingsSectionDefinition<void>,
          ]
        : []),
      {
        id: "planning",
        groupKey: "settings.groupResources",
        groupOrder: 20,
        order: 35,
        labelKey: settingsSectionLabel("planning"),
        icon: <CalendarDays className={extension.iconClassName} />,
        render: () => (
          <CalendarSection
            settings={settings}
            setSettings={setSettings}
            showDeviceCalendarData={showLocalRuntimeSettings}
          />
        ),
      },
      {
        id: "memory",
        groupKey: "settings.groupResources",
        groupOrder: 20,
        order: 40,
        labelKey: settingsSectionLabel("memory"),
        icon: <Brain className={extension.iconClassName} />,
        contentMode: "fill",
        render: () => (
          <MemoryPanel
            workdir={settings.system.workdir}
            settings={settings}
            setSettings={setSettings}
            kbrain={props.settingsHost?.kbrain}
          />
        ),
      },
      {
        id: "systemTools",
        groupKey: "settings.groupIntelligence",
        groupOrder: 25,
        order: 20,
        labelKey: settingsSectionLabel("systemTools"),
        icon: <Wrench className={extension.iconClassName} />,
        render: () => (
          <div className="space-y-7">
            {props.settingsHost?.kbrain && <AIApprovalSection kbrain={props.settingsHost.kbrain} />}
            <SystemToolsSection settings={settings} setSettings={setSettings} />
          </div>
        ),
      },
      ...(showLocalRuntimeSettings && props.settingsHost?.kbrain
        ? [
            {
              id: "webSearch",
              groupKey: "settings.groupIntelligence",
              groupOrder: 25,
              order: 22,
              labelKey: settingsSectionLabel("webSearch"),
              icon: <Globe className={extension.iconClassName} />,
              render: () =>
                props.settingsHost?.kbrain ? (
                  <WebSearchSection kbrain={props.settingsHost.kbrain} />
                ) : null,
            } satisfies SettingsSectionDefinition<void>,
          ]
        : []),
      ...(showLocalRuntimeSettings &&
      permissionRulesScope != null &&
      rulesBackend?.listPermissionRules &&
      rulesBackend.addPermissionRule &&
      rulesBackend.deletePermissionRule
        ? [
            {
              id: "permissions",
              groupKey: "settings.groupIntelligence",
              groupOrder: 25,
              order: 25,
              labelKey: settingsSectionLabel("permissions"),
              icon: <ShieldCheck className={extension.iconClassName} />,
              showSaveIndicator: false,
              render: () => (
                <PermissionRulesSection
                  key={permissionRulesScope}
                  kbrain={rulesBackend}
                  settings={settings}
                />
              ),
            } satisfies SettingsSectionDefinition<void>,
          ]
        : []),
      {
        id: "stt",
        groupKey: "settings.groupIntelligence",
        groupOrder: 25,
        order: 30,
        labelKey: settingsSectionLabel("stt"),
        icon: <Mic className={extension.iconClassName} />,
        render: () => (
          <SttSection
            settings={settings}
            setSettings={setSettings}
            service={sttSettingsService}
            selectedProvider={sttSelectedProvider}
            onSelectedProviderChange={handleSttProviderChange}
          />
        ),
      },
      {
        id: "hooks",
        groupKey: "settings.groupResources",
        groupOrder: 20,
        order: 50,
        labelKey: settingsSectionLabel("hooks"),
        icon: <Zap className={extension.iconClassName} />,
        contentMode: "fill",
        render: () => <HooksSection settings={settings} setSettings={setSettings} />,
      },
      {
        id: "cron",
        groupKey: "settings.groupResources",
        groupOrder: 20,
        order: 30,
        labelKey: settingsSectionLabel("cron"),
        icon: <Clock3 className={extension.iconClassName} />,
        render: () =>
          onOpenScheduledTasks ? (
            <Button
              data-settings-anchor="cron-tasks"
              variant="outline"
              onClick={onOpenScheduledTasks}
            >
              {t("settings.openScheduledTasks")}
            </Button>
          ) : (
            <CronSection settings={settings} setSettings={setSettings} />
          ),
      },
      {
        id: "ssh",
        groupKey: "settings.groupConnectivity",
        groupOrder: 40,
        order: 10,
        labelKey: settingsSectionLabel("ssh"),
        icon: <Key className={extension.iconClassName} />,
        render: () => (
          <SshSection settings={settings} setSettings={setSettings} saveState={saveState} />
        ),
      },
      {
        id: "remote",
        groupKey: "settings.groupConnectivity",
        groupOrder: 40,
        order: 20,
        labelKey: settingsSectionLabel("remote"),
        icon: <Cloud className={extension.iconClassName} />,
        render: () => (
          <RemoteSection
            settings={settings}
            setSettings={setSettings}
            surface={extension.surface}
          />
        ),
      },
      ...extension.sections,
    ],
    [
      extension,
      devicePlugins,
      devicePluginWorkdir,
      showLocalRuntimeSettings,
      permissionRulesScope,
      rulesBackend,
      props.settingsHost,
      handleSttProviderChange,
      pendingProviderId,
      saveState,
      setSettings,
      settings,
      sttSelectedProvider,
      sttSettingsService,
      onOpenScheduledTasks,
      t,
    ],
  );
  const registry: UiExtensionRegistry<void> = {
    surface: extension.surface,
    services: EMPTY_SERVICES,
    slots: extension.slots,
    settingsSections: sections,
  };

  return (
    <SettingsShell
      presentation={props.presentation}
      registry={registry}
      context={undefined}
      saveState={saveState}
      onBack={onBack}
      backLabel={props.backLabel}
      initialSection={
        initialSection === "image-studio" || initialSection === "model-preferences"
          ? "providers"
          : initialSection
      }
      initialAnchor={props.initialAnchor}
      onSectionChange={(section) => onSectionChange?.(section as typeof initialSection)}
      mobileDetail={props.mobileDetail}
      onMobileDetailChange={props.onMobileDetailChange}
      hiddenSections={hiddenSections}
      excludedSearchAnchors={[
        ...extension.excludedSearchAnchors,
        ...(devicePlugins?.readSurface ? [] : ["html-previews"]),
        ...(rulesBackend ? [] : ["ai-approval-mode", "ai-approval-model"]),
      ]}
      fontScale={settings.customSettings.fontScale.settings}
      describeScope={(section) => {
        const zh = settings.locale === "zh-CN";
        if (
          section === "account" ||
          section === "connections" ||
          section === "devices" ||
          (!showLocalRuntimeSettings && section === "providers")
        )
          return zh ? "账户" : "Account";
        if (
          section === "shortcuts" ||
          section === "about" ||
          (!showLocalRuntimeSettings && section === "system")
        )
          return zh ? "此客户端" : "This client";
        if (
          showLocalRuntimeSettings &&
          [
            "skills",
            "mcp",
            "cron",
            "memory",
            "ssh",
            "remote",
            "hooks",
            "systemTools",
            "webSearch",
          ].includes(section)
        ) {
          return "runtimeKind" in props && props.runtimeKind === "device_agent"
            ? zh
              ? "指定设备"
              : "Selected device"
            : zh
              ? "此电脑"
              : "This computer";
        }
        return undefined;
      }}
    />
  );
}
