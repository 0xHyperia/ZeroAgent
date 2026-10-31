import { FolderClosed, Lightbulb } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { useEffect, useId, useRef, useState } from "react";
import {
  type CloudAccountGuard,
  type CloudChatProjectsClient,
  type CloudProject,
  CloudWorkUnconfirmedError,
} from "@/lib/cloudChatProjects";

/** One creation flow for the sidebar and the conversation's move submenu. */
export function CloudProjectCreateDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: CloudChatProjectsClient;
  captureGuard: CloudAccountGuard;
  disabled?: boolean;
  moveAfterCreate?: boolean;
  onCreated: (project: CloudProject) => void | Promise<void>;
}) {
  const nameId = useId();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CloudProject | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function submit() {
    if (pending.current || props.disabled || unknown || !name.trim()) return;
    const guard = props.captureGuard();
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const project =
        created ??
        (await props.client.createProject({
          name: name.trim(),
          description: "",
          instructions: "",
        }));
      guard();
      if (!mounted.current) return;
      setCreated(project);
      await props.onCreated(project);
      guard();
      if (!mounted.current) return;
      setCreated(null);
      setName("");
      props.onOpenChange(false);
    } catch (cause) {
      try {
        guard();
        if (mounted.current) {
          setUnknown(cause instanceof CloudWorkUnconfirmedError);
          setError(cause instanceof Error ? cause.message : "创建失败，请重试。");
        }
      } catch {
        /* Retired account or conversation. */
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!pending.current) props.onOpenChange(open);
      }}
    >
      <DialogContent
        className="max-w-lg rounded-3xl p-6"
        showCloseButton
        closeDisabled={busy}
        closeLabel="关闭新建项目"
      >
        <DialogHeader>
          <DialogTitle className="text-xl">创建项目</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <label htmlFor={nameId} className="text-sm font-medium">
              项目名称
            </label>
            <div className="relative">
              <FolderClosed
                className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id={nameId}
                autoFocus
                aria-label="项目名称"
                placeholder="例如：新产品发布计划"
                maxLength={200}
                className="h-12 rounded-xl pl-10"
                value={name}
                disabled={busy || !!created || unknown}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </div>
          </div>
          <div className="flex gap-3 rounded-2xl bg-muted/60 p-4 text-sm leading-relaxed text-muted-foreground">
            <Lightbulb className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
              将相关对话、文件和项目指令放在一起，让持续进行的工作更有条理。
              {props.moveAfterCreate ? "创建后，此对话会移入项目。" : ""}
            </DialogDescription>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="rounded-full"
              disabled={busy}
              onClick={() => props.onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              className="rounded-full px-5"
              disabled={busy || props.disabled || unknown || !name.trim()}
            >
              {busy
                ? "正在保存…"
                : created
                  ? "重试移入项目"
                  : props.moveAfterCreate
                    ? "创建并移入"
                    : "创建项目"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
