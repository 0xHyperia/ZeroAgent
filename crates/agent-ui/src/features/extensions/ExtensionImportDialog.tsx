import { useRef } from "react";
import { FileText, Loader2, Upload } from "../../components/IconSet";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { TooltipButton as Button } from "../../components/ui/tooltip-button";
import type { ExtensionKind } from "./extensionTypes";

export function ExtensionImportDialog(props: {
  kind: ExtensionKind | null;
  file: File | null;
  error: string;
  busy: boolean;
  blocked: boolean;
  uncertain: boolean;
  refreshing: boolean;
  onReconcile: () => void;
  onChoose: () => void;
  onFiles: (files: File[]) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const lastKind = useRef<ExtensionKind>("plugin");
  if (props.kind) lastKind.current = props.kind;
  const noun = lastKind.current === "plugin" ? "插件" : "技能";
  return (
    <Dialog
      open={!!props.kind}
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogContent
        className="za-extension-import p-6"
        style={{ maxWidth: "min(480px,calc(100vw - 32px))" }}
      >
        <DialogTitle>导入{noun}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          选择文件并确认后，安装到你的个人{noun}中。
        </DialogDescription>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Drag/drop is optional; the contained choose-file button provides the complete keyboard path. */}
        <div
          className="za-extension-import-drop"
          role="presentation"
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (!props.busy) props.onFiles(Array.from(event.dataTransfer.files));
          }}
        >
          {props.file ? <FileText className="size-6" /> : <Upload className="size-6" />}
          <p className="break-all font-medium">
            {props.file ? props.file.name : `将${noun}包拖到这里`}
          </p>
          <p className="text-xs text-muted-foreground">
            {props.file
              ? `${(props.file.size / 1024).toFixed(1)} KB · ZIP`
              : "支持 UTF-8 文本 ZIP，最大 350 KB"}
          </p>
          <Button
            variant="outline"
            className="rounded-full"
            disabled={props.busy}
            onClick={props.onChoose}
          >
            {props.file ? "更换文件" : "选择 ZIP 文件"}
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          压缩包需要包含 SKILL.md。插件可包含多个技能；导入不会执行其中的文件。
        </p>
        {props.error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {props.error}
          </p>
        )}
        {props.uncertain && (
          <Button
            variant="outline"
            className="mt-3 rounded-full"
            disabled={props.refreshing || props.busy}
            onClick={props.onReconcile}
          >
            {props.refreshing ? "正在核对…" : "刷新目录核对"}
          </Button>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" disabled={props.busy} onClick={props.onClose}>
            取消
          </Button>
          <Button
            className="rounded-full"
            disabled={!props.file || props.busy || props.blocked}
            onClick={props.onConfirm}
          >
            {props.busy && <Loader2 className="size-4 animate-spin" />}
            {props.busy ? "正在导入…" : `添加${noun}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
