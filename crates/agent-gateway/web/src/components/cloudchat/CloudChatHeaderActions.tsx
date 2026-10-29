import {
  Brain,
  FileText,
  FolderOpen,
  Globe,
  MoreHorizontal,
  PanelRightOpen,
  Settings2,
} from "@liveagent/ui/components/IconSet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useIsMobile } from "@liveagent/ui/hooks/use-mobile";

export type CloudChatResource = "files" | "artifacts" | "sources" | "projects" | "memory";

export function CloudChatHeaderActions(props: {
  onOpenResource: (resource: CloudChatResource) => void;
  onOpenModelLimits: () => void;
  modelLimitsDisabled: boolean;
  exportDisabled: boolean;
  onExport: (format: "markdown" | "json") => void;
}) {
  const mobile = useIsMobile();
  const resources = [
    { id: "files", label: "文件库", icon: FileText },
    { id: "artifacts", label: "成果库", icon: FolderOpen },
    { id: "sources", label: "来源资料", icon: Globe },
    { id: "projects", label: "项目", icon: FolderOpen },
    { id: "memory", label: "记忆", icon: Brain },
  ] as const;
  return (
    <div className="flex shrink-0 items-center gap-1" data-cloud-chat-actions="">
      {!mobile ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="sm" />}
            aria-label="对话资料与项目"
            className="gap-2 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <PanelRightOpen className="size-4" />
            <span className="max-640:sr-only">资料</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" variant="soft">
            {resources.map(({ id, label, icon: Icon }) => (
              <DropdownMenuItem key={id} onClick={() => props.onOpenResource(id)} className="gap-2">
                <Icon className="size-4 text-muted-foreground" />
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" />}
          aria-label="对话选项"
          title="对话选项"
          className="rounded-lg text-muted-foreground hover:text-foreground"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" variant="soft">
          {mobile ? (
            <>
              {resources.map(({ id, label, icon: Icon }) => (
                <DropdownMenuItem
                  key={id}
                  onClick={() => props.onOpenResource(id)}
                  className="gap-2"
                >
                  <Icon className="size-4" />
                  {label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem
            disabled={props.modelLimitsDisabled}
            onClick={props.onOpenModelLimits}
            className="gap-2"
          >
            <Settings2 className="size-4" />
            模型参数
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={props.exportDisabled}
            onClick={() => props.onExport("markdown")}
          >
            导出 Markdown
          </DropdownMenuItem>
          <DropdownMenuItem disabled={props.exportDisabled} onClick={() => props.onExport("json")}>
            导出 JSON
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
