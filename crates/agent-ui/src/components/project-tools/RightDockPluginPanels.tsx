import "@liveagent/ui/i18n/namespaces/projectTools";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import type { DevicePluginsClient } from "../../lib/plugins/devicePlugins";
import type { DeviceUiDocument, DeviceUiSurfaceClient } from "../../lib/plugins/deviceUiSurface";
import { useDevicePluginList } from "../../lib/plugins/useDevicePluginList";
import { ArrowLeft, Plug, X } from "../IconSet";
import { Button } from "../ui/button";
import { TooltipButton } from "../ui/tooltip-button";

const PreviewDocument = lazy(() => import("../sandboxed-ui/DeviceUiPreviewDocument"));

type Panel = {
  id: string;
  title: string;
  pluginId: string;
  pluginName: string;
  version: string;
};

const panelKey = (panel: Panel) => JSON.stringify([panel.pluginId, panel.version, panel.id]);

export function RightDockPluginPanels({
  client,
  workdir,
  onClose,
}: {
  client: DevicePluginsClient;
  workdir: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const { list, loading, loadError, refresh } = useDevicePluginList(client, workdir);
  const [selection, setSelection] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const panels = list?.available
    ? list.plugins.flatMap((plugin) => {
        if (!plugin.enabled || (plugin.source === "workspace" && !list.trusted)) return [];
        return plugin.contributes.ui
          .filter((panel) => panel.placement === "sidePane")
          .map((panel) => ({
            ...panel,
            pluginId: plugin.id,
            pluginName: plugin.name || plugin.id,
            version: plugin.version,
          }));
      })
    : [];
  const selected = selection ? panels.find((panel) => panelKey(panel) === selection) : undefined;

  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    if (selection && !selected) setSelection(undefined);
  }, [selected, selection]);

  return (
    <section
      aria-label={t("sandboxedUi.dock.title")}
      className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        {selected ? (
          <TooltipButton
            variant="ghost"
            size="icon-sm"
            aria-label={t("sandboxedUi.dock.back")}
            title={t("sandboxedUi.dock.back")}
            onClick={() => {
              setSelection(undefined);
              heading.current?.focus();
            }}
          >
            <ArrowLeft className="size-4" />
          </TooltipButton>
        ) : null}
        <h2 ref={heading} className="min-w-0 flex-1 truncate text-sm font-medium" tabIndex={-1}>
          {selected?.title || t("sandboxedUi.dock.title")}
        </h2>
        <TooltipButton
          variant="ghost"
          size="icon-sm"
          aria-label={t("sandboxedUi.dock.close")}
          title={t("sandboxedUi.dock.close")}
          onClick={onClose}
        >
          <X className="size-4" />
        </TooltipButton>
      </header>
      {selected && client.readSurface ? (
        <PluginPanelDocument
          key={panelKey(selected)}
          read={client.readSurface}
          panel={selected}
          workdir={workdir}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
          {loading ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("projectTools.loading")}
            </p>
          ) : null}
          {loadError ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p role="alert">{t("sandboxedUi.panelError.generic")}</p>
              <Button variant="outline" size="sm" onClick={refresh}>
                {t("sandboxedUi.dock.retry")}
              </Button>
            </div>
          ) : !loading && panels.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("sandboxedUi.dock.noPanels")}</p>
          ) : null}
          {panels.map((panel) => (
            <Button
              key={panelKey(panel)}
              variant="outline"
              className="h-auto w-full justify-start gap-2 py-2 text-left"
              onClick={() => {
                setSelection(panelKey(panel));
                heading.current?.focus();
              }}
            >
              <Plug className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm">{panel.title}</span>
                <span className="truncate text-xs text-muted-foreground">{panel.pluginName}</span>
              </span>
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

function PluginPanelDocument({
  read,
  panel,
  workdir,
}: {
  read: DeviceUiSurfaceClient;
  panel: Panel;
  workdir: string;
}) {
  const { t } = useLocale();
  const [view, setView] = useState<{ document?: DeviceUiDocument; failed?: boolean }>({});
  const { pluginId, version, id } = panel;
  useEffect(() => {
    let active = true;
    void read({ action: "panel", workdir, pluginId, pluginVersion: version, resourceId: id }).then(
      (document) => {
        if (active) setView("html" in document ? { document } : { failed: true });
      },
      () => {
        if (active) setView({ failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [read, workdir, pluginId, version, id]);
  if (view.failed)
    return (
      <p className="p-3 text-sm text-muted-foreground" role="alert">
        {t("sandboxedUi.panelError.generic")}
      </p>
    );
  const loading = (
    <p className="p-3 text-sm text-muted-foreground" role="status">
      {t("projectTools.loading")}
    </p>
  );
  return (
    <Suspense fallback={loading}>
      {view.document ? <PreviewDocument document={view.document} title={panel.title} /> : loading}
    </Suspense>
  );
}
