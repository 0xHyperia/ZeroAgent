import { type FormEvent, useState } from "react";
import { Button } from "@liveagent/ui/components/ui/button";
import { Copy, Loader2, Lock } from "@liveagent/ui/components/IconSet";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";

type RelayKeyCopyDialogProps = {
  keyName: string | null;
  onClose: () => void;
  onConfirm: (password: string) => Promise<void>;
};

export function RelayKeyCopyDialog({ keyName, onClose, onConfirm }: RelayKeyCopyDialogProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!keyName) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password) {
      setError("请输入当前 USA-零 账户密码。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onConfirm(password);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "密码验证失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-w-sm p-0"
        closeDisabled={busy}
        closeLabel="关闭"
        showCloseButton
      >
        <form className="p-5" onSubmit={submit}>
          <div className="flex min-w-0 items-start gap-3 pr-10">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Lock className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-sm leading-normal">
                验证密码后复制
              </DialogTitle>
              <p className="mt-1 truncate text-xs text-muted-foreground" title={keyName}>
                {keyName}
              </p>
            </div>
          </div>
          <div className="mt-5 space-y-2">
            <Label htmlFor="relay-copy-password">USA-零 账户密码</Label>
            <Input
              id="relay-copy-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
          </div>
          {error && <p className="mt-3 text-xs leading-5 text-destructive">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
              验证并复制
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
