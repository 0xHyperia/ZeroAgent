import {
  Blend,
  BookOpen,
  ChartColumn,
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
import { SegmentedControl } from "@liveagent/ui/components/ui/segmented-control";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { ExtensionMark } from "@liveagent/ui/features/extensions/ExtensionMark";
import {
  type ExtensionPackage,
  type ExtensionSkill,
  extensionComposerEntry,
} from "@liveagent/ui/features/extensions/extensionTypes";
import { useLocale } from "@liveagent/ui/i18n";
import {
  extensionDescription,
  extensionDisplayName,
} from "@liveagent/ui/lib/extensions/presentation";
import { useRef, useState } from "react";

export function CloudChatComposerMenu(props: {
  disabled: boolean;
  projectDisabled?: boolean;
  researchEnabled: boolean;
  onUpload: () => void;
  onOpenFiles: (anchor: HTMLElement | null) => void;
  onOpenProjects: (anchor: HTMLElement | null) => void;
  onOpenExtensions: (anchor: HTMLElement | null) => void;
  onToggleResearch: () => void;
  extensions: ExtensionPackage[];
  onTryExtension: (pkg: ExtensionPackage, skill: ExtensionSkill) => void;
  onDataAnalysis?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "en-US" ? en : zh);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = props.open ?? localOpen;
  const image = props.extensions.find((pkg) => pkg.id === "imagegen");
  const imageSkill = image && extensionComposerEntry(image);
  const addLabel = copy("添加资料与工具", "Add context and tools");
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
        aria-label={addLabel}
        title={isOpen ? copy("关闭添加菜单", "Close add menu") : addLabel}
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
        <DropdownMenuLabel className="cloud-composer-menu-heading">
          {copy("添加到对话", "Add to conversation")}
        </DropdownMenuLabel>
        <DropdownMenuItem className="gap-3" onClick={props.onUpload}>
          <Paperclip className="size-4 shrink-0" />
          <span>
            <span>{copy("添加照片和文件", "Upload photos and files")}</span>
            <span>{copy("从设备上传资料", "From this device")}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-3" onClick={() => props.onOpenFiles(triggerRef.current)}>
          <BookOpen className="size-4 shrink-0" />
          <span>
            <span>{copy("从资料库添加", "Add from library")}</span>
            <span>{copy("引用已保存的文件", "Reference saved files")}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-3"
          disabled={props.projectDisabled}
          onClick={() => props.onOpenProjects(triggerRef.current)}
        >
          <FolderOpen className="size-4 shrink-0" />
          <span>
            <span>{copy("选择项目", "Choose a project")}</span>
            <span>{copy("使用项目资料与指令", "Use project files and instructions")}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {image && imageSkill && (
          <DropdownMenuItem onClick={() => props.onTryExtension(image, imageSkill)}>
            <ExtensionMark id={image.id} small />
            <span>
              <span>{extensionDisplayName(image, locale)}</span>
              <span>{extensionDescription(image, locale)}</span>
            </span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => props.onOpenExtensions(triggerRef.current)}>
          <Blend className="size-4 shrink-0" />
          <span>
            <span>{copy("插件与技能", "Plugins and skills")}</span>
            <span>{copy("选择可用扩展", "Choose an available extension")}</span>
          </span>
        </DropdownMenuItem>
        {props.onDataAnalysis && (
          <DropdownMenuItem className="gap-3" onClick={props.onDataAnalysis}>
            <ChartColumn className="size-4" />
            <span>
              <span>{copy("数据分析", "Data analysis")}</span>
              <span>{copy("准备分析请求", "Draft an analysis request")}</span>
            </span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          role="menuitemcheckbox"
          aria-checked={props.researchEnabled}
          className="gap-3"
          onClick={props.onToggleResearch}
        >
          <Globe className="size-4 shrink-0" />
          <span className="flex-1">
            <span>{copy("公开联网研究", "Public web research")}</span>
            <span>{copy("发送前确认研究主题", "Confirm the topic before sending")}</span>
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
  const { locale } = useLocale();
  const en = locale === "en-US";
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      label={en ? "Conversation mode" : "输入体验"}
      className="cloud-mode-switch"
      options={[
        {
          value: "chat",
          label: en ? "Chat" : "对话",
          description: en ? "Ask questions and explore ideas" : "提问并探索想法",
        },
        {
          value: "work",
          label: en ? "Work" : "工作",
          description: en ? "Complete tasks and deliver results" : "完成任务与交付成果",
        },
      ]}
    />
  );
}
