import { SettingsRow } from "@liveagent/ui/components/settings/SettingsLayout";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@liveagent/ui/components/ui/dialog";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useRef, useState } from "react";
import { getKBrainHealth } from "../../agent-ui-adapters/kbrainSettings";

function diagnosticVersion(version: string | undefined) {
  return version && /^v?\d{1,8}\.\d{1,8}\.\d{1,8}(?:[-+][\w.-]{1,40})?$/.test(version)
    ? version
    : null;
}

export function DesktopDiagnosticsRow({ version }: { version: string }) {
  const { t } = useLocale();
  const [report, setReport] = useState<string | null>(null);
  const generation = useRef(0);

  async function load(open: boolean) {
    const request = ++generation.current;
    setReport(null);
    if (!open) return;
    const health = await getKBrainHealth().catch(() => null);
    if (request !== generation.current) return;
    setReport(
      JSON.stringify(
        {
          schemaVersion: 1,
          application: { name: "ZeroAgent", version: diagnosticVersion(version) },
          runtime: health
            ? {
                status: "ready",
                version: diagnosticVersion(health.build?.version),
                protocol: { major: health.protocol.major, minor: health.protocol.minor },
                startupContract: health.startupContract,
              }
            : { status: "unavailable" },
        },
        null,
        2,
      ),
    );
  }

  function download() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "zeroagent-diagnostics.json";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function copy() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      toast.success(t("settings.diagnostics.copied"));
    } catch {
      toast.error(t("settings.diagnostics.copyFailed"));
    }
  }

  return (
    <SettingsRow
      title={t("settings.diagnostics.title")}
      description={t("settings.diagnostics.description")}
      control={
        <Dialog onOpenChange={(open) => void load(open)}>
          <DialogTrigger render={<Button variant="outline" size="sm" />}>
            {t("settings.diagnostics.preview")}
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("settings.diagnostics.title")}</DialogTitle>
              <DialogDescription>{t("settings.diagnostics.description")}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              {report ? (
                <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">{report}</pre>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  {t("settings.diagnostics.loading")}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" disabled={!report} onClick={() => void copy()}>
                {t("settings.diagnostics.copy")}
              </Button>
              <Button disabled={!report} onClick={download}>
                {t("settings.diagnostics.download")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      }
    />
  );
}
