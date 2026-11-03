import {
  ChevronDown,
  Clock3,
  FolderClosed,
  Globe,
  Layers,
  MoreHorizontal,
  Plus,
  Search,
  Star,
  Trash2,
} from "@liveagent/ui/components/IconSet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import { useEffect, useState } from "react";
import {
  CLOUD_SPACE_HOME,
  type CloudSpaceClient,
  type CloudSpaceItem,
  type CloudSpaceLocation,
  type CloudSpacePage,
} from "@/lib/cloudSpace";
import { CloudSpaceCapacity } from "./CloudSpacePage";

export function CloudSpaceNavigation(props: {
  client: CloudSpaceClient;
  location: CloudSpaceLocation;
  revision: number;
  onNavigate: (location: CloudSpaceLocation) => void;
  onOpen: (item: CloudSpaceItem) => void;
  onOther: (resource: "projects" | "sources") => void;
  onStorage?: () => void;
  onNewFolder?: () => void;
}) {
  const [page, setPage] = useState<CloudSpacePage | null>(null),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  const { client, revision } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: revisions and explicit retry invalidate server metadata.
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void client
      .list(CLOUD_SPACE_HOME, "", "updated", "", controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setPage(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [client, revision, retry]);
  const [foldersOpen, setFoldersOpen] = useState(true);
  const categories = [
    { id: "recent", label: "最近", Icon: Clock3 },
    { id: "all", label: "全部资料", Icon: Layers },
  ] as const;
  return (
    <div className="cloud-space-navigation">
      <nav aria-label="资料空间分类" className="flex flex-col gap-1">
        {categories.map(({ id, label, Icon }) => (
          <button
            type="button"
            className="cloud-sidebar-destination"
            key={id}
            aria-current={
              props.location.category === id &&
              props.location.scope === "all" &&
              !props.location.folder
                ? "page"
                : undefined
            }
            onClick={() => props.onNavigate({ ...CLOUD_SPACE_HOME, category: id })}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
        <button
          type="button"
          className="cloud-sidebar-destination"
          aria-current={props.location.scope === "starred" ? "page" : undefined}
          onClick={() => props.onNavigate({ ...CLOUD_SPACE_HOME, scope: "starred" })}
        >
          <Star className="size-4" />
          收藏
        </button>
        <button
          type="button"
          className="cloud-sidebar-destination"
          aria-current={
            props.location.category === "sites" && props.location.scope === "all"
              ? "page"
              : undefined
          }
          onClick={() => props.onNavigate({ ...CLOUD_SPACE_HOME, category: "sites" })}
        >
          <Globe className="size-4" />
          站点
        </button>
      </nav>
      <section className="cloud-space-folders">
        <div className="cloud-space-folder-heading">
          <button
            type="button"
            aria-expanded={foldersOpen}
            onClick={() => setFoldersOpen((open) => !open)}
          >
            <ChevronDown className="size-3.5" data-open={foldersOpen} />
            文件夹
          </button>
          <TooltipButton
            title="新建文件夹"
            aria-label="新建文件夹"
            variant="ghost"
            size="icon-sm"
            onClick={props.onNewFolder}
          >
            <Plus className="size-4" />
          </TooltipButton>
        </div>
        <div hidden={!foldersOpen} className="space-y-1">
          {page?.folders.map((item) => (
            <button
              type="button"
              className="cloud-sidebar-destination"
              key={item.id}
              aria-current={props.location.folder === item.id ? "page" : undefined}
              onClick={() => props.onNavigate({ ...CLOUD_SPACE_HOME, folder: item.id })}
            >
              <FolderClosed className="size-4 shrink-0" />
              <span className="truncate">{item.name}</span>
            </button>
          ))}
          {page && !page.folders.length ? (
            <button
              type="button"
              className="cloud-sidebar-destination cloud-space-new-folder"
              onClick={props.onNewFolder}
            >
              <Plus className="size-4" />
              新建文件夹
            </button>
          ) : null}
        </div>
      </section>
      {failed ? (
        <button
          type="button"
          className="cloud-sidebar-destination text-muted-foreground"
          onClick={() => setRetry((value) => value + 1)}
        >
          资料加载失败，重试
        </button>
      ) : null}
      <div className="cloud-space-navigation-footer">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<button type="button" className="cloud-sidebar-destination" />}
          >
            <MoreHorizontal className="size-4" />
            更多
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" variant="soft" className="cloud-space-menu">
            <DropdownMenuItem onClick={() => props.onOther("projects")}>
              <FolderClosed className="size-4" />
              项目资料
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => props.onOther("sources")}>
              <Search className="size-4" />
              研究来源
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          className="cloud-sidebar-destination"
          aria-current={props.location.scope === "trash" ? "page" : undefined}
          onClick={() => props.onNavigate({ ...CLOUD_SPACE_HOME, scope: "trash" })}
        >
          <Trash2 className="size-4" />
          回收站
        </button>
        {page ? (
          <CloudSpaceCapacity
            usage={page.usage}
            onClick={
              props.onStorage ?? (() => props.onNavigate({ ...CLOUD_SPACE_HOME, scope: "trash" }))
            }
          />
        ) : null}
      </div>
    </div>
  );
}
