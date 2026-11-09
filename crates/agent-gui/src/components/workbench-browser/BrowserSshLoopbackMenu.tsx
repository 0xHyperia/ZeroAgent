import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { type FormEvent, useId, useState } from "react";
import Cable from "~icons/lucide/cable";
import { resolveBrowserAddress } from "./browserAddress";

export type BrowserSshTarget = { id: string; label: string };

export function browserLoopbackAddress(address: string): string | null {
  const resolved = resolveBrowserAddress(address);
  if (!resolved) return null;
  const url = new URL(resolved);
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\])$/i.test(
    url.hostname,
  ) && url.port !== "0"
    ? resolved
    : null;
}

export function displaySshLoopbackAddress(actual: string, original: string): string {
  const resolved = browserLoopbackAddress(actual);
  if (!resolved) return original;
  const page = new URL(resolved);
  const remote = new URL(original);
  page.hostname = remote.hostname;
  page.port = remote.port;
  return page.href;
}

export function BrowserSshLoopbackMenu({
  active,
  targets,
  onOpen,
  onClose,
}: {
  active: boolean;
  targets: readonly BrowserSshTarget[];
  onOpen(sessionId: string, url: string): Promise<void>;
  onClose(): Promise<void>;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const label = {
    title: zh ? "SSH 回环转发" : "SSH loopback forwarding",
    active: zh ? "已连接 SSH 回环" : "SSH loopback connected",
    description: zh
      ? "在当前工作区选择一个已连接的 SSH 会话，打开该宿主上的本地网页。"
      : "Open a local web page on a connected SSH host in this workspace.",
    connection: zh ? "SSH 会话" : "SSH session",
    url: zh ? "回环地址" : "Loopback address",
    open: zh ? "打开" : "Open",
    disconnect: zh ? "停止转发" : "Stop forwarding",
    invalid: zh ? "请输入有效的回环地址。" : "Enter a valid loopback address.",
    failed: zh
      ? "SSH 转发不可用，请检查所选会话。"
      : "SSH forwarding is unavailable. Check the selected session.",
  };
  const [shown, setShown] = useState(false);
  const addressId = useId();
  const [selected, setSelected] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selection = targets.some((target) => target.id === selected) ? selected : targets[0]?.id;

  async function open(event: FormEvent) {
    event.preventDefault();
    const url = browserLoopbackAddress(address);
    if (!url || !selection) {
      setError(label.invalid);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onOpen(selection, url);
      setShown(false);
    } catch {
      setError(label.failed);
    } finally {
      setBusy(false);
    }
  }

  if (!active && targets.length === 0) return null;
  return (
    <>
      <button
        type="button"
        title={active ? label.active : label.title}
        aria-label={active ? label.active : label.title}
        aria-haspopup="dialog"
        aria-expanded={shown}
        data-active={active || undefined}
        onClick={() => {
          setError("");
          setShown(true);
        }}
      >
        <Cable />
      </button>
      <Dialog open={shown} onOpenChange={setShown}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{label.title}</DialogTitle>
            <DialogDescription>{label.description}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <form className="space-y-3" onSubmit={(event) => void open(event)}>
              {targets.length > 0 && (
                <>
                  <label className="block space-y-1 text-sm">
                    <span>{label.connection}</span>
                    <select
                      className="h-9 w-full rounded-lg border border-input bg-background px-2"
                      value={selection}
                      onChange={(event) => setSelected(event.target.value)}
                    >
                      {targets.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1 text-sm" htmlFor={addressId}>
                    <span>{label.url}</span>
                    <Input
                      id={addressId}
                      value={address}
                      placeholder="http://localhost:3000"
                      onChange={(event) => setAddress(event.target.value)}
                      spellCheck={false}
                    />
                  </label>
                </>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogActions>
                {active && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void onClose()
                        .then(
                          () => setShown(false),
                          () => setError(label.failed),
                        )
                        .finally(() => setBusy(false));
                    }}
                  >
                    {label.disconnect}
                  </Button>
                )}
                {targets.length > 0 && (
                  <Button type="submit" size="sm" disabled={busy || !address.trim()}>
                    {label.open}
                  </Button>
                )}
              </DialogActions>
            </form>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
