import {
  BookOpen,
  FileText,
  FolderClosed,
  Globe,
  ImageIcon,
  Layers,
  Search,
  Star,
  Trash2,
  Upload,
} from "@liveagent/ui/components/IconSet";
import { useEffect, useState } from "react";
import {
  CLOUD_SPACE_HOME,
  type CloudSpaceClient,
  type CloudSpaceItem,
  type CloudSpaceLocation,
  type CloudSpacePage,
} from "@/lib/cloudSpace";
import { CloudSpaceCapacity, CloudSpaceIcon } from "./CloudSpacePage";

export function CloudSpaceNavigation(props: {
  client: CloudSpaceClient;
  location: CloudSpaceLocation;
  revision: number;
  onNavigate: (location: CloudSpaceLocation) => void;
  onOpen: (item: CloudSpaceItem) => void;
  onOther: (resource: "projects" | "sources") => void;
  onStorage?: () => void;
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
  const categories = [
    { id: "all", label: "全部资料", Icon: Layers },
    { id: "documents", label: "文档与文件", Icon: FileText },
    { id: "images", label: "图像", Icon: ImageIcon },
    { id: "sites", label: "站点", Icon: Globe },
    { id: "uploads", label: "我的上传", Icon: Upload },
    { id: "outputs", label: "工作产出", Icon: BookOpen },
  ] as const;
  return (
    <div className="cloud-space-navigation">
      <nav aria-label="资料空间分类">
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
      </nav>
      {page?.folders.length ? (
        <>
          <h3>文件夹</h3>
          {page.folders.map((item) => (
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
        </>
      ) : null}
      <h3>工作上下文</h3>
      <button
        type="button"
        className="cloud-sidebar-destination"
        onClick={() => props.onOther("projects")}
      >
        <FolderClosed className="size-4" />
        项目资料
      </button>
      <button
        type="button"
        className="cloud-sidebar-destination"
        onClick={() => props.onOther("sources")}
      >
        <Search className="size-4" />
        研究来源
      </button>
      {page?.pinned.length ? (
        <>
          <h3>常用资料</h3>
          {page.pinned.slice(0, 4).map((item) => (
            <button
              type="button"
              className="cloud-sidebar-destination"
              key={item.id}
              onClick={() => props.onOpen(item)}
            >
              <CloudSpaceIcon item={item} />
              <span className="truncate">{item.name}</span>
            </button>
          ))}
        </>
      ) : null}
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
