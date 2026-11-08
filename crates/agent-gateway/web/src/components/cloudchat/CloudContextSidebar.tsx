import { BookOpen, FileText, PanelLeft, PanelLeftClose, X } from "@liveagent/ui/components/IconSet";
import {
  Sidebar,
  SidebarHeader,
  SidebarHeaderRow,
  SidebarTrigger,
} from "@liveagent/ui/components/ui/sidebar";
import { useLocale } from "@liveagent/ui/i18n";
import { type ReactNode, useEffect, useState } from "react";
import type { CloudChatFile, CloudChatFilesClient } from "@/lib/cloudChatFiles";
import type { CloudSpaceClient, CloudSpaceLocation } from "@/lib/cloudSpace";
import { CloudSpaceNavigation } from "./CloudSpaceNavigation";

type Resource = "files" | "artifacts";

/** Context navigation only. Hover never selects an execution environment. */
export function CloudContextSidebar(props: {
  preview: boolean;
  mobileRail?: ReactNode;
  spaceClient?: CloudSpaceClient;
  spaceLocation?: CloudSpaceLocation;
  spaceRevision?: number;
  onSpaceNavigate?: (location: CloudSpaceLocation) => void;
  onSpaceStorage?: () => void;
  onSpaceNewFolder?: () => void;
  activeResource?: Resource;
  files: CloudChatFilesClient;
  onOpenResource: (resource: Resource) => void;
  onOpenFile: (id: string) => void;
  onPin: () => void;
  reportLoadErrors?: boolean;
}) {
  const { locale } = useLocale();
  const text = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const [files, setFiles] = useState<CloudChatFile[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const { files: client, spaceClient } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly restarts this read after a user action.
  useEffect(() => {
    if (spaceClient) return;
    const controller = new AbortController();
    setState("loading");
    setFiles([]);
    void client
      .list({ signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        setFiles(
          page.files.filter((file) => file.state !== "deleted" && file.state !== "deleting"),
        );
        setState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
    return () => controller.abort();
  }, [client, retry, spaceClient]);
  const sidebarAction = props.preview
    ? text("打开资料空间", "Open library")
    : text("收起侧栏", "Collapse sidebar");
  return (
    <Sidebar
      label={text("资料空间导航", "Library navigation")}
      previewOpen={props.preview}
      mobileRail={props.mobileRail}
      className="cloud-context-sidebar bg-settings-rail"
      data-context-destination="library"
    >
      <SidebarHeader className="px-3 pb-2 pt-2.5">
        <SidebarHeaderRow
          actions={
            <SidebarTrigger
              showShortcut={!props.preview}
              title={sidebarAction}
              aria-label={sidebarAction}
              onClick={(event) => {
                if (props.preview) {
                  event.preventDefault();
                  props.onPin();
                }
              }}
            >
              {props.mobileRail ? (
                <X className="size-4" />
              ) : props.preview ? (
                <PanelLeft className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </SidebarTrigger>
          }
        >
          <h2 className="min-w-0 truncate px-1 text-base font-semibold">
            {text("资料空间", "Library")}
          </h2>
        </SidebarHeaderRow>
      </SidebarHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-5 flex flex-col">
        {props.spaceClient && props.spaceLocation && props.onSpaceNavigate ? (
          <CloudSpaceNavigation
            client={props.spaceClient}
            location={props.spaceLocation}
            revision={props.spaceRevision ?? 0}
            onNavigate={props.onSpaceNavigate}
            onStorage={props.onSpaceStorage}
            onNewFolder={props.onSpaceNewFolder}
            reportLoadErrors={props.reportLoadErrors}
          />
        ) : (
          <>
            <nav aria-label={text("资料类型", "Resource types")} className="space-y-1">
              {(
                [
                  ["files", text("文件", "Files"), FileText],
                  ["artifacts", text("成果", "Outputs"), BookOpen],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  aria-current={props.activeResource === id ? "page" : undefined}
                  className="cloud-sidebar-destination"
                  onClick={() => props.onOpenResource(id)}
                >
                  <Icon className="size-4 shrink-0" />
                  {label}
                </button>
              ))}
            </nav>
            <h3 className="px-2.5 pb-2 pt-7 text-xs text-muted-foreground">
              {text("最近文件", "Recent files")}
            </h3>
            {state === "loading" ? (
              <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">
                {text("正在加载文件…", "Loading files…")}
              </p>
            ) : null}
            {state === "error" ? (
              <button
                type="button"
                className="cloud-sidebar-destination text-muted-foreground"
                onClick={() => setRetry((value) => value + 1)}
              >
                {text("文件加载失败，重试", "Couldn't load files. Retry")}
              </button>
            ) : null}
            {state === "ready" && !files.length ? (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">
                {text("暂无文件", "No files")}
              </p>
            ) : null}
            {files.slice(0, 8).map((file) => (
              <button
                key={file.id}
                type="button"
                className="cloud-sidebar-destination"
                onClick={() => props.onOpenFile(file.id)}
              >
                <FileText className="size-4 shrink-0" />
                <span className="truncate">{file.name}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </Sidebar>
  );
}
