import {
  BookOpen,
  ChartColumn,
  Check,
  FolderOpen,
  Globe,
  Palette,
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
  extensionSkillEnabled,
} from "@liveagent/ui/features/extensions/extensionTypes";
import { extensionDisplayName } from "@liveagent/ui/lib/extensions/presentation";
import { useRef, useState } from "react";

export function CloudChatComposerMenu(props: {
  disabled: boolean;
  projectDisabled?: boolean;
  researchEnabled: boolean;
  onUpload: () => void;
  onOpenFiles: (anchor: HTMLElement | null) => void;
  onOpenProjects: (anchor: HTMLElement | null) => void;
  onToggleResearch: () => void;
  onCreateImage: () => void;
  onProductDesign: () => void;
  onCustomize: () => void;
  extensions?: ExtensionPackage[];
  onTryExtension?: (pkg: ExtensionPackage, skill: ExtensionSkill) => void;
  onDataAnalysis?: () => void;
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
          disabled={props.projectDisabled}
          onClick={() => props.onOpenProjects(triggerRef.current)}
        >
          <FolderOpen className="size-4 shrink-0" />
          <span>
            <span className="block">选择项目</span>
            <span className="block text-xs text-muted-foreground">使用项目资料与指令</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {props.extensions ? (
          props.extensions
            .filter((pkg) => extensionSkillEnabled(pkg, pkg.skills[0]))
            .map((pkg) => (
              <DropdownMenuItem
                key={pkg.id}
                className="gap-3"
                onClick={() => props.onTryExtension?.(pkg, pkg.skills[0])}
              >
                <ExtensionMark id={pkg.id} small />
                <span>
                  <span className="block">{extensionDisplayName(pkg)}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {pkg.description}
                  </span>
                </span>
              </DropdownMenuItem>
            ))
        ) : (
          <>
            <DropdownMenuItem className="gap-3" onClick={props.onCreateImage}>
              <ExtensionMark id="imagegen" small />
              <span>
                <span className="block">生成图像</span>
                <span className="block text-xs text-muted-foreground">
                  从想法生成图片，或继续修改参考图
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-3" onClick={props.onProductDesign}>
              <ExtensionMark id="product-design" small />
              <span>
                <span className="block">产品设计</span>
                <span className="block text-xs text-muted-foreground">
                  梳理体验、探索视觉方案并实现设计
                </span>
              </span>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onClick={props.onCustomize}>
          <Palette className="size-4" />
          发现插件与技能
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {props.onDataAnalysis && (
          <DropdownMenuItem className="gap-3" onClick={props.onDataAnalysis}>
            <ChartColumn className="size-4" />
            <span>
              <span className="block">数据分析</span>
              <span className="block text-xs text-muted-foreground">
                先确认数据来源、目标和交付格式
              </span>
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
    <SegmentedControl
      value={value}
      onChange={onChange}
      label="输入体验"
      className="cloud-mode-switch"
      options={[
        { value: "chat", label: "对话", description: "提问并探索想法" },
        { value: "work", label: "工作", description: "完成任务与交付成果" },
      ]}
    />
  );
}
