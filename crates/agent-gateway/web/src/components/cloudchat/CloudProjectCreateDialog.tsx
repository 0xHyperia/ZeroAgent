import { FolderClosed } from "@liveagent/ui/components/IconSet";
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
import { useLocale } from "@liveagent/ui/i18n";
import { useEffect, useId, useRef, useState } from "react";
import {
  type CloudAccountGuard,
  type CloudChatProjectsClient,
  type CloudProject,
  CloudWorkUnconfirmedError,
} from "@/lib/cloudChatProjects";

/** The same creation form can continue the action that opened it. */
export function CloudProjectCreateDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: CloudChatProjectsClient;
  captureGuard: CloudAccountGuard;
  disabled?: boolean;
  afterCreate?: "select" | "move";
  finalFocus?: () => HTMLElement | false | undefined;
  onCreated: (project: CloudProject) => void | Promise<void>;
}) {
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "en-US" ? en : zh);
  const nameLabel = copy("项目名称", "Project name");
  const intent =
    props.afterCreate === "move"
      ? {
          description: copy(
            "创建后，所选对话会移入这个项目。",
            "Move the selected conversation into the new project.",
          ),
          submit: copy("创建并移入", "Create and move"),
          retry: copy("重试移入项目", "Retry move"),
        }
      : props.afterCreate === "select"
        ? {
            description: copy(
              "此草稿将使用新项目，输入和附件会保留。",
              "Use this project for the draft. Keep its text and attachments.",
            ),
            submit: copy("创建并选择", "Create and select"),
            retry: copy("重试选择项目", "Retry project selection"),
          }
        : {
            description: copy(
              "将相关对话、文件和项目指令放在一起。",
              "Keep related conversations, files, and instructions together.",
            ),
            submit: copy("创建项目", "Create project"),
            retry: copy("继续", "Continue"),
          };
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
    let project = created;
    try {
      guard();
      project ??= await props.client.createProject({
        name: name.trim(),
        description: "",
        instructions: "",
      });
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
          const unconfirmed = cause instanceof CloudWorkUnconfirmedError;
          setUnknown(unconfirmed);
          if (project) {
            const fallback = copy(
              "项目已创建。请重试关联。",
              "Project created. Try linking it again.",
            );
            setError(
              locale !== "en-US" && cause instanceof Error
                ? `项目已创建。${cause.message}`
                : fallback,
            );
          } else {
            setError(
              unconfirmed
                ? copy(
                    "创建结果尚未确认，请先刷新列表核对，避免重复创建。",
                    "Creation could not be confirmed. Check the project list before trying again.",
                  )
                : locale !== "en-US" && cause instanceof Error
                  ? cause.message
                  : copy("创建失败，请重试。", "Could not create the project. Try again."),
            );
          }
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
        className="cloud-project-create-dialog max-w-lg rounded-3xl p-6"
        showCloseButton
        closeDisabled={busy}
        closeLabel={copy("关闭新建项目", "Close new project")}
        finalFocus={props.finalFocus}
      >
        <DialogHeader className="px-0 pt-0 max-[820px]:px-0 max-[820px]:pt-0">
          <DialogTitle className="text-xl">{copy("创建项目", "Create project")}</DialogTitle>
          <DialogDescription>{intent.description}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <label htmlFor={nameId} className="text-sm font-medium">
              {nameLabel}
            </label>
            <div className="relative">
              <FolderClosed
                className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id={nameId}
                autoFocus
                aria-label={nameLabel}
                placeholder={copy("例如：新产品发布计划", "For example, product launch plan")}
                maxLength={200}
                className="h-12 rounded-xl pl-10"
                value={name}
                disabled={busy || !!created || unknown}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="min-h-0 px-0 pb-0 max-[820px]:flex-row max-[820px]:flex-wrap max-[820px]:items-center max-[820px]:px-0 max-[820px]:pb-0">
            <Button
              type="button"
              variant="ghost"
              className="rounded-full max-[820px]:min-h-11"
              disabled={busy}
              onClick={() => props.onOpenChange(false)}
            >
              {copy("取消", "Cancel")}
            </Button>
            <Button
              type="submit"
              className="rounded-full px-5 max-[820px]:min-h-11"
              disabled={busy || props.disabled || unknown || !name.trim()}
            >
              {busy ? copy("正在保存…", "Saving…") : created ? intent.retry : intent.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
