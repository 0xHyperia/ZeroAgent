import {
  BookOpen,
  Check,
  FolderOpen,
  Globe,
  Paperclip,
  Plus,
} from "@liveagent/ui/components/IconSet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useRef, useState } from "react";

export function CloudChatComposerMenu(props: {
  disabled: boolean;
  researchEnabled: boolean;
  onUpload: () => void;
  onOpenFiles: (anchor: HTMLElement | null) => void;
  onOpenProjects: (anchor: HTMLElement | null) => void;
  onToggleResearch: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = props.open ?? localOpen;
  return (
    <DropdownMenu
      open={isOpen}
      onOpenChange={(open) => {
        if (open) setAnchor(triggerRef.current);
        if (props.open === undefined) setLocalOpen(open);
        props.onOpenChange?.(open);
      }}
    >
      <DropdownMenuTrigger
        render={<Button ref={triggerRef} variant="ghost" size="icon-sm" />}
        aria-label="添加资料与工具"
        title={isOpen ? "关闭添加菜单" : "添加资料与工具"}
        disabled={props.disabled}
        className="cloud-composer-add"
        data-open={isOpen || undefined}
      >
        <Plus className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={8}
        variant="soft"
        anchor={anchor ?? undefined}
        className="cloud-composer-menu max-w-[calc(100vw-32px)]"
      >
        <DropdownMenuLabel className="cloud-composer-menu-heading">添加到对话</DropdownMenuLabel>
        <DropdownMenuItem className="gap-3" onClick={props.onUpload}>
          <Paperclip className="size-4 shrink-0" />
          <span>
            <span className="block">添加照片和文件</span>
            <span className="block text-xs text-muted-foreground">从设备上传资料</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-3" onClick={() => props.onOpenFiles(triggerRef.current)}>
          <BookOpen className="size-4 shrink-0" />
          <span>
            <span className="block">从资料库添加</span>
            <span className="block text-xs text-muted-foreground">引用已保存的文件</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-3"
          onClick={() => props.onOpenProjects(triggerRef.current)}
        >
          <FolderOpen className="size-4 shrink-0" />
          <span>
            <span className="block">选择项目</span>
            <span className="block text-xs text-muted-foreground">使用项目资料与指令</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          role="menuitemcheckbox"
          aria-checked={props.researchEnabled}
          className="gap-3"
          onClick={props.onToggleResearch}
        >
          <Globe className="size-4 shrink-0" />
          <span className="flex-1">
            <span className="block">公开联网研究</span>
            <span className="block text-xs text-muted-foreground">发送前确认公开研究主题</span>
          </span>
          {props.researchEnabled ? <Check className="size-4" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type CloudChatPresentation = "chat" | "work";
export function CloudChatModeSwitch({
  value,
  onChange,
}: {
  value: CloudChatPresentation;
  onChange: (value: CloudChatPresentation) => void;
}) {
  return (
    <fieldset aria-label="输入体验" className="cloud-mode-switch" data-mode={value}>
      <span className="cloud-mode-indicator" aria-hidden="true" />
      {(
        [
          { id: "chat", label: "对话" },
          { id: "work", label: "工作" },
        ] as const
      ).map((mode) => (
        <Button
          key={mode.id}
          type="button"
          variant="ghost"
          title={mode.id === "chat" ? "提问并探索想法" : "完成任务与交付成果"}
          aria-pressed={value === mode.id}
          tabIndex={value === mode.id ? 0 : -1}
          onClick={() => {
            if (value !== mode.id) onChange(mode.id);
          }}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? "chat"
                : event.key === "End"
                  ? "work"
                  : value === "chat"
                    ? "work"
                    : "chat";
            if (next !== value) onChange(next);
            event.currentTarget.parentElement
              ?.querySelector<HTMLButtonElement>(`button[data-mode="${next}"]`)
              ?.focus();
          }}
          data-mode={mode.id}
        >
          {mode.label}
        </Button>
      ))}
    </fieldset>
  );
}
