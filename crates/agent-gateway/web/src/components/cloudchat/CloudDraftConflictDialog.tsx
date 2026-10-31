import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import type { CloudChatSavedDraft } from "@/lib/cloudChatSavedDrafts";

export function CloudDraftConflictDialog(props: {
  open: boolean;
  local: CloudChatSavedDraft | null;
  server: CloudChatSavedDraft | null;
  busy?: boolean;
  onClose: () => void;
  onChoose: (choice: "keep-local" | "use-server") => void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        layout="fullscreen-mobile"
        className="flex max-h-[85dvh] max-w-2xl flex-col gap-4 overflow-hidden p-5"
      >
        <DialogTitle>选择要继续的草稿</DialogTitle>
        <DialogDescription>
          这份草稿在其他页面也有修改。查看两份内容后，选择要保留的一份。
        </DialogDescription>
        <div className="grid min-h-0 gap-3 overflow-y-auto overscroll-contain sm:grid-cols-2">
          {(
            [
              ["当前页面", props.local],
              ["云端草稿", props.server],
            ] as const
          ).map(([label, value]) => {
            const text = value?.draft.composer?.text ?? "";
            const resources = [...(value?.draft.files ?? []), ...(value?.draft.artifacts ?? [])];
            return (
              <section
                key={label}
                className="min-w-0 rounded-2xl border border-border/60 bg-muted/20 p-4"
              >
                <h3 className="mb-1 text-sm font-medium">{label}</h3>
                {value?.modelSelection?.model ? (
                  <p className="mb-3 truncate text-xs text-muted-foreground">
                    {value.modelSelection.model}
                  </p>
                ) : null}
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/85">
                  {text.slice(0, 1600) || (resources.length ? "仅附带资料" : "空白草稿")}
                </p>
                {text.length > 1600 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    当前仅预览开头，保留时包含完整内容。
                  </p>
                ) : null}
                {resources.length ? (
                  <ul className="mt-3 space-y-1 border-t border-border/50 pt-3 text-xs text-muted-foreground">
                    {resources.map((resource) => (
                      <li key={resource.id} className="break-words">
                        {resource.name}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>
            继续查看
          </Button>
          <Button
            variant="secondary"
            disabled={props.busy}
            onClick={() => props.onChoose("use-server")}
          >
            使用云端草稿
          </Button>
          <Button disabled={props.busy} onClick={() => props.onChoose("keep-local")}>
            保留当前草稿
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
