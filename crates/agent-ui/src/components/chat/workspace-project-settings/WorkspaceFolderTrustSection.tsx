import "@liveagent/ui/i18n/namespaces/workspaceProject";
import "@liveagent/ui/i18n/namespaces/settings";
import { Loader2, ShieldCheck, ShieldOff } from "@liveagent/ui/components/IconSet";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import type {
  WorkspaceFolderTrustClient,
  WorkspaceFolderTrustStatus,
} from "@liveagent/ui/contracts/workspaceFolderTrust";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useMemo, useRef, useState } from "react";

type TrustState =
  | { phase: "loading" }
  | { phase: "unsupported" }
  | { phase: "ready"; status: WorkspaceFolderTrustStatus }
  | { phase: "failed" };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Shows whether the backend trusts the project folder and lets the user grant
 * or revoke it. Changes are applied immediately: trust lives in the backend's
 * trusted folder list, not in the settings draft saved by the modal.
 */
export function WorkspaceFolderTrustSection(props: {
  path: string;
  client: WorkspaceFolderTrustClient;
  /** Called after the user granted or revoked trust here. */
  onChange?: (status: WorkspaceFolderTrustStatus) => void;
}) {
  const { path, client, onChange } = props;
  const { t } = useLocale();
  const [state, setState] = useState<TrustState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();
  const scope = useMemo(() => ({ client, path }), [client, path]);
  const liveScope = useRef<typeof scope | null>(scope);
  liveScope.current = scope;

  useEffect(() => {
    let cancelled = false;
    liveScope.current = scope;
    setState({ phase: "loading" });
    setError(null);
    setBusy(false);
    void (async () => {
      try {
        if (!(await client.supported())) {
          if (!cancelled) setState({ phase: "unsupported" });
          return;
        }
        const status = await client.get(path);
        if (!cancelled) setState({ phase: "ready", status });
      } catch (failure) {
        if (cancelled) return;
        setState({ phase: "failed" });
        setError(errorMessage(failure));
      }
    })();
    return () => {
      cancelled = true;
      if (liveScope.current === scope) liveScope.current = null;
    };
  }, [client, path, scope]);

  const change = async (grant: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const label = t(grant ? "chat.folderTrustGrant" : "chat.folderTrustRevoke");
      const confirmed = await confirm({
        title: label,
        description: t(
          grant
            ? "settings.devicePlugins.trustDescription"
            : "settings.devicePlugins.revokeDescription",
        ),
        confirmLabel: label,
        cancelLabel: t("confirmDialog.cancel"),
      });
      if (!confirmed || liveScope.current !== scope) return;
      const status = grant ? await client.trust(path) : await client.revoke(path);
      if (liveScope.current !== scope) return;
      setState({ phase: "ready", status });
      onChange?.(status);
    } catch (failure) {
      if (liveScope.current === scope) setError(errorMessage(failure));
    } finally {
      if (liveScope.current === scope) setBusy(false);
    }
  };

  const status = state.phase === "ready" ? state.status : null;
  const trusted = status?.trusted === true;
  const inheritedFrom =
    trusted && status?.source && (status.inherited ?? status.source !== status.workdir)
      ? status.source
      : null;

  let badge: { label: string; variant: "success" | "muted" | "destructive" };
  if (state.phase === "loading") badge = { label: t("chat.folderTrustChecking"), variant: "muted" };
  else if (state.phase === "unsupported")
    badge = { label: t("chat.folderTrustUnavailable"), variant: "muted" };
  else if (state.phase === "failed")
    badge = { label: t("chat.folderTrustUnknown"), variant: "destructive" };
  else if (trusted) badge = { label: t("chat.folderTrustTrusted"), variant: "success" };
  else badge = { label: t("chat.folderTrustNotTrusted"), variant: "muted" };

  return (
    <div className="space-y-2" data-testid="workspace-folder-trust">
      {dialog}
      <div
        className={cn(
          "flex items-center justify-between gap-3 rounded-xl bg-settings-tile px-4 py-3",
          "max-[560px]:flex-col max-[560px]:items-stretch max-[560px]:gap-2",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {trusted ? (
            <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden />
          ) : (
            <ShieldOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="shrink-0 text-sm font-medium">{t("chat.folderTrustTitle")}</span>
          <Badge variant={badge.variant} aria-live="polite">
            {badge.label}
          </Badge>
        </div>
        {status ? (
          <Button
            type="button"
            size="sm"
            variant={trusted ? "outline" : "default"}
            disabled={busy}
            onClick={() => void change(!trusted)}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {trusted ? t("chat.folderTrustRevoke") : t("chat.folderTrustGrant")}
          </Button>
        ) : null}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {state.phase === "unsupported"
          ? t("chat.folderTrustUnsupported")
          : t("chat.folderTrustDescription")}
      </p>
      {trusted && (status?.inherited || inheritedFrom) ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {inheritedFrom
            ? t("chat.folderTrustInherited").replace("{path}", inheritedFrom)
            : t("chat.folderTrustInheritedParent")}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs leading-5 text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
