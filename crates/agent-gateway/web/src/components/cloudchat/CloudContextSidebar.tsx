import {
  BookOpen,
  FileText,
  FolderClosed,
  Globe,
  MonitorSmartphone,
  PanelLeft,
  PanelLeftClose,
  X,
} from "@liveagent/ui/components/IconSet";
import { Sidebar, SidebarHeader, SidebarTrigger } from "@liveagent/ui/components/ui/sidebar";
import { type ReactNode, useEffect, useState } from "react";
import type { CloudChatFile, CloudChatFilesClient } from "@/lib/cloudChatFiles";
import type { CloudSpaceClient, CloudSpaceItem, CloudSpaceLocation } from "@/lib/cloudSpace";
import type { ExecutionEnvironment } from "@/lib/executionTargets";
import { CloudSpaceNavigation } from "./CloudSpaceNavigation";

export type CloudSidebarDestination = "chat" | "library" | "devices";
type Resource = "files" | "artifacts" | "sources" | "projects" | "memory";

/** Context navigation only. Hover never selects an execution environment. */
export function CloudContextSidebar(props: {
  destination: Exclude<CloudSidebarDestination, "chat">;
  preview: boolean;
  mobileRail?: ReactNode;
  spaceClient?: CloudSpaceClient;
  spaceLocation?: CloudSpaceLocation;
  spaceRevision?: number;
  onSpaceNavigate?: (location: CloudSpaceLocation) => void;
  onSpaceOpen?: (item: CloudSpaceItem) => void;
  onSpaceStorage?: () => void;
  activeResource?: Resource;
  files: CloudChatFilesClient;
  environments: readonly ExecutionEnvironment[];
  onOpenResource: (resource: Resource) => void;
  onOpenFile: (id: string) => void;
  onOpenDevices: () => void;
  onPin: () => void;
}) {
  const [files, setFiles] = useState<CloudChatFile[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const { destination, files: client } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly restarts this read after a user action.
  useEffect(() => {
    if (destination !== "library" || props.spaceClient) return;
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
  }, [client, destination, retry, props.spaceClient]);
  const devices = props.environments.filter(
    (environment) => environment.runtime_kind === "device_agent",
  );
  return (
    <Sidebar
      label={destination === "library" ? "资料空间导航" : "设备导航"}
      previewOpen={props.preview}
      mobileRail={props.mobileRail}
      className="cloud-context-sidebar bg-settings-rail"
      data-context-destination={destination}
    >
      <SidebarHeader className="px-3 pb-2 pt-4">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <h2 className="px-1 text-base font-semibold">
            {destination === "library" ? "资料空间" : "设备"}
          </h2>
          <SidebarTrigger
            showShortcut={!props.preview}
            title={
              props.preview
                ? destination === "library"
                  ? "打开资料空间"
                  : "打开设备管理"
                : "收起侧栏"
            }
            aria-label={
              props.preview
                ? destination === "library"
                  ? "打开资料空间"
                  : "打开设备管理"
                : "收起侧栏"
            }
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
        </div>
      </SidebarHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-5 flex flex-col">
        {destination === "library" ? (
          props.spaceClient && props.spaceLocation && props.onSpaceNavigate && props.onSpaceOpen ? (
            <CloudSpaceNavigation
              client={props.spaceClient}
              location={props.spaceLocation}
              revision={props.spaceRevision ?? 0}
              onNavigate={props.onSpaceNavigate}
              onOpen={props.onSpaceOpen}
              onOther={props.onOpenResource}
              onStorage={props.onSpaceStorage}
            />
          ) : (
            <>
              <nav aria-label="资料类型" className="space-y-1">
                {(
                  [
                    ["files", "文件", FileText],
                    ["artifacts", "成果", BookOpen],
                    ["sources", "来源", Globe],
                    ["projects", "项目", FolderClosed],
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
              <h3 className="px-2.5 pb-2 pt-7 text-xs text-muted-foreground">最近文件</h3>
              {state === "loading" ? (
                <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">
                  正在加载文件…
                </p>
              ) : null}
              {state === "error" ? (
                <button
                  type="button"
                  className="cloud-sidebar-destination text-muted-foreground"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  文件加载失败，重试
                </button>
              ) : null}
              {state === "ready" && !files.length ? (
                <p className="px-2.5 py-2 text-xs text-muted-foreground">暂无文件</p>
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
          )
        ) : (
          <>
            <button
              type="button"
              className="cloud-sidebar-destination"
              onClick={props.onOpenDevices}
            >
              <MonitorSmartphone className="size-4" />
              管理设备
            </button>
            <h3 className="px-2.5 pb-2 pt-7 text-xs text-muted-foreground">已连接的设备</h3>
            {!devices.length ? (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">暂无已连接的设备</p>
            ) : null}
            {devices.map((device) => (
              <button
                key={device.device_id ?? device.agent_id ?? device.name}
                type="button"
                className="cloud-sidebar-destination"
                onClick={props.onOpenDevices}
              >
                <MonitorSmartphone className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{device.device_name || device.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {device.online ? "在线" : "离线"}
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </Sidebar>
  );
}
