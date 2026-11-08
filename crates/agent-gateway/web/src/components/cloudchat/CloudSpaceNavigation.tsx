import {
  ChevronDown,
  Clock3,
  FolderClosed,
  Globe,
  Layers,
  Plus,
  Star,
  Trash2,
} from "@liveagent/ui/components/IconSet";
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n";
import { useEffect, useState } from "react";
import {
  CLOUD_SPACE_HOME,
  type CloudSpaceClient,
  type CloudSpaceLocation,
  type CloudSpacePage,
  cloudSpaceTitle,
} from "@/lib/cloudSpace";
import { CloudSpaceCapacity } from "./CloudSpacePage";

export function CloudSpaceNavigation(props: {
  client: CloudSpaceClient;
  location: CloudSpaceLocation;
  revision: number;
  onNavigate: (location: CloudSpaceLocation) => void;
  onStorage?: () => void;
  onNewFolder?: () => void;
  reportLoadErrors?: boolean;
}) {
  const { locale } = useLocale();
  const text = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
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
    { id: "recent", Icon: Clock3 },
    { id: "all", Icon: Layers },
  ] as const;
  return (
    <div className="cloud-space-navigation">
      <nav aria-label={text("资料空间分类", "Library sections")} className="flex flex-col gap-1">
        {categories.map(({ id, Icon }) => (
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
            {cloudSpaceTitle({ ...CLOUD_SPACE_HOME, category: id }, locale)}
          </button>
        ))}
        <button
          type="button"
          className="cloud-sidebar-destination"
          aria-current={
            !props.location.folder && props.location.scope === "starred" ? "page" : undefined
          }
          onClick={() => props.onNavigate({ ...CLOUD_SPACE_HOME, scope: "starred" })}
        >
          <Star className="size-4" />
          {cloudSpaceTitle({ ...CLOUD_SPACE_HOME, scope: "starred" }, locale)}
        </button>
        <button
          type="button"
          className="cloud-sidebar-destination"
          aria-current={
            !props.location.folder &&
            props.location.category === "sites" &&
            props.location.scope === "all"
              ? "page"
              : undefined
          }
          onClick={() => props.onNavigate({ ...CLOUD_SPACE_HOME, category: "sites" })}
        >
          <Globe className="size-4" />
          {cloudSpaceTitle({ ...CLOUD_SPACE_HOME, category: "sites" }, locale)}
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
            {text("文件夹", "Folders")}
          </button>
          <TooltipButton
            title={text("新建文件夹", "New folder")}
            aria-label={text("新建文件夹", "New folder")}
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
              {text("新建文件夹", "New folder")}
            </button>
          ) : null}
        </div>
      </section>
      {failed && props.reportLoadErrors !== false ? (
        <button
          type="button"
          className="cloud-sidebar-destination text-muted-foreground"
          onClick={() => setRetry((value) => value + 1)}
        >
          {text("资料加载失败，重试", "Couldn't load the library. Retry")}
        </button>
      ) : null}
      <div className="cloud-space-navigation-footer">
        <button
          type="button"
          className="cloud-sidebar-destination"
          aria-current={
            !props.location.folder && props.location.scope === "trash" ? "page" : undefined
          }
          onClick={() => props.onNavigate({ ...CLOUD_SPACE_HOME, scope: "trash" })}
        >
          <Trash2 className="size-4" />
          {cloudSpaceTitle({ ...CLOUD_SPACE_HOME, scope: "trash" }, locale)}
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
