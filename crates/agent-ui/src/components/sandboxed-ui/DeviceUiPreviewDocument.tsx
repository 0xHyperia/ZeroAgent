import { useMemo } from "react";
import { useLocale } from "../../i18n";
import type { DeviceUiDocument } from "../../lib/plugins/deviceUiSurface";
import { buildReadOnlyDeviceUiDocument } from "./readOnlyDocument";

export default function DeviceUiPreviewDocument({
  document,
  title,
}: {
  document: DeviceUiDocument;
  title: string;
}) {
  const { t } = useLocale();
  const source = useMemo(() => {
    try {
      return document.html ? buildReadOnlyDeviceUiDocument(document.html) : "";
    } catch {
      return "";
    }
  }, [document]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-4 pb-4">
      {source ? (
        <iframe
          className="min-h-64 w-full flex-1 rounded-md border border-border bg-background"
          title={title}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={source}
        />
      ) : null}
      {document.result !== undefined ? (
        <details open={!source} className="rounded-md border border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer">{t("sandboxedUi.device.result")}</summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words">
            {JSON.stringify(document.result, null, 2)}
          </pre>
        </details>
      ) : null}
      {!source && document.result === undefined ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {t("sandboxedUi.panelError.generic")}
        </p>
      ) : null}
    </div>
  );
}
import "@liveagent/ui/i18n/namespaces/projectTools";
