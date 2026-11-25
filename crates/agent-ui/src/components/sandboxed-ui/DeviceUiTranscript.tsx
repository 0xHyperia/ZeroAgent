import "@liveagent/ui/i18n/namespaces/projectTools";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocale } from "../../i18n";
import type { DeviceUiHistory, DeviceUiSurfaceClient } from "../../lib/plugins/deviceUiSurface";
import { DeviceUiPreviewDialog } from "./DeviceUiPreviewDialog";

const EMPTY_HISTORY: DeviceUiHistory = { previews: [], mcp: [] };
type Context = {
  history: DeviceUiHistory;
  load: DeviceUiSurfaceClient;
  conversationId: string;
  workdir?: string;
  htmlPreviews: boolean;
};
const DeviceUi = createContext<Context | undefined>(undefined);

export function DeviceUiTranscript({
  children,
  client,
  conversationId,
  workdir,
  running,
  htmlPreviews = true,
}: {
  children: ReactNode;
  client?: DeviceUiSurfaceClient;
  conversationId: string;
  workdir?: string;
  running: boolean;
  htmlPreviews?: boolean;
}) {
  const [last, setLast] = useState<{
    client: DeviceUiSurfaceClient;
    conversationId: string;
    workdir?: string;
    history: DeviceUiHistory;
  }>();

  useEffect(() => {
    if (!client || !conversationId || running) return;
    let current = true;
    void client({ action: "history", conversationId, workdir }).then(
      (data) => {
        if (current && "previews" in data) {
          setLast({ client, conversationId, workdir, history: data });
        }
      },
      () => {
        if (current) setLast(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [client, conversationId, workdir, running]);

  const history =
    client === last?.client && conversationId === last?.conversationId && workdir === last?.workdir
      ? (last?.history ?? EMPTY_HISTORY)
      : EMPTY_HISTORY;
  const context = useMemo(
    () => (client ? { history, load: client, conversationId, workdir, htmlPreviews } : undefined),
    [client, conversationId, workdir, history, htmlPreviews],
  );
  return <DeviceUi.Provider value={context}>{children}</DeviceUi.Provider>;
}

export function HtmlPreviewFence({ code, children }: { code: string; children: ReactNode }) {
  const { t } = useLocale();
  const host = useContext(DeviceUi);
  const read = host?.htmlPreviews ? host.load : undefined;
  const conversation = host?.conversationId;
  const workdir = host?.workdir;
  const load = useMemo(
    () => (read && conversation ? async () => ({ html: code }) : undefined),
    [code, conversation, read],
  );
  if (!load || !code.trim()) return children;
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-border p-3">
      <DeviceUiPreviewDialog
        key={workdir}
        label={t("sandboxedUi.device.htmlPreview")}
        load={load}
      />
      <details className="text-sm">
        <summary className="cursor-pointer px-1 text-muted-foreground">
          {t("sandboxedUi.device.source")}
        </summary>
        {children}
      </details>
    </div>
  );
}

export function DeviceToolSurfaces({ toolCallId }: { toolCallId: string }) {
  const { t } = useLocale();
  const host = useContext(DeviceUi);
  const previews = host?.htmlPreviews
    ? host.history.previews.filter((preview) => preview.toolCallId === toolCallId)
    : [];
  const hasMcp = host?.history.mcp.includes(toolCallId);
  if (!host || (!previews.length && !hasMcp)) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 py-2">
      {previews.map((preview) => (
        <ToolSurfaceButton
          key={preview.id}
          host={host}
          id={preview.id}
          action="preview"
          label={preview.title || t("sandboxedUi.device.htmlPreview")}
        />
      ))}
      {hasMcp ? (
        <ToolSurfaceButton
          host={host}
          id={toolCallId}
          action="mcp"
          label={t("sandboxedUi.device.mcp")}
        />
      ) : null}
    </div>
  );
}

function ToolSurfaceButton({
  host,
  id,
  action,
  label,
}: {
  host: Context;
  id: string;
  action: "preview" | "mcp";
  label: string;
}) {
  const { load, conversationId, workdir } = host;
  const read = useCallback(async () => {
    const document = await load({ action, conversationId, resourceId: id, workdir });
    if (!("html" in document)) throw new Error("DEVICE_UI_DOCUMENT_INVALID");
    return document;
  }, [load, action, conversationId, id, workdir]);
  return <DeviceUiPreviewDialog label={label} load={read} />;
}
