import {
  ArrowLeft,
  ArrowRight,
  FileText as Code,
  ExternalLink,
  Globe,
  History,
  Lock,
  Maximize2,
  Minimize2,
  MonitorSmartphone,
  RefreshCw,
  Settings2,
  Share2,
  SquareMousePointer,
  X,
} from "@liveagent/ui/components/IconSet";
import { PreviewIdentityContext } from "@liveagent/ui/components/resource-preview/PreviewChrome";
import { PreviewLoading } from "@liveagent/ui/components/resource-preview/PreviewFeedback";
import {
  type DocumentRevisionComment,
  ResourceDocumentComments,
  type RevisionSelection,
} from "@liveagent/ui/components/resource-preview/ResourceDocumentComments";
import { ResourceVersionTimeline } from "@liveagent/ui/components/resource-preview/ResourceVersionTimeline";
import {
  COMMENT_CURSOR,
  COMMENT_PIN,
} from "@liveagent/ui/components/resource-preview/readerInteraction";
import { PreviewReadingTarget } from "@liveagent/ui/components/resource-preview/readingSession";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { Input } from "@liveagent/ui/components/ui/input";
import { ScrollArea } from "@liveagent/ui/components/ui/scroll-area";
import { TooltipButton as Action } from "@liveagent/ui/components/ui/tooltip-button";
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CloudChatArtifactVersion } from "@/lib/cloudChatArtifacts";
import type { CloudSiteGrant, CloudSiteRelease } from "@/lib/cloudChatSites";
import { CloudChatFeedback } from "./CloudChatFeedback";
import { CloudChatReaderLayout } from "./CloudChatReaderContext";

type Props = {
  artifact: CloudChatArtifactVersion;
  release: CloudSiteRelease | null;
  preview: CloudSiteGrant | null;
  busy: boolean;
  unavailable?: boolean;
  feedback: ReactNode;
  initialAction?: "share" | "settings";
  displayName?: string;
  onRename?: (name: string) => Promise<void>;
  onShare: () => void;
  onOpen: () => void;
  onClose: () => void;
  onContinue?: () => void;
  versions: CloudChatArtifactVersion[];
  onVersion: (id: string) => void;
  onRequestRevision?: (comments: readonly DocumentRevisionComment[]) => Promise<boolean>;
  isCurrent: () => boolean;
};

export function CloudSiteWorkspace(props: Props) {
  return (
    <PreviewReadingTarget identity={`site:${props.artifact.id}`}>
      <PreviewIdentityContext.Provider
        value={{
          name: props.artifact.name,
          mime: "text/html",
          onRequestRevision: props.onRequestRevision,
        }}
      >
        <SiteWorkspaceContent {...props} />
      </PreviewIdentityContext.Provider>
    </PreviewReadingTarget>
  );
}

function SiteWorkspaceContent(props: Props) {
  const layout = useContext(CloudChatReaderLayout);
  const root = useRef<HTMLElement>(null),
    frame = useRef<HTMLIFrameElement>(null),
    canvas = useRef<HTMLDivElement>(null);
  const exit = useRef<(() => void) | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [page, setPage] = useState("");
  const [viewport, setViewport] = useState("fit");
  const [history, setHistory] = useState<string[]>([]),
    [position, setPosition] = useState(0);
  const [reload, setReload] = useState(0),
    [loadedIdentity, setLoadedIdentity] = useState(""),
    [readyIdentity, setReadyIdentity] = useState("");
  const [slowIdentity, setSlowIdentity] = useState("");
  const [modifying, setModifying] = useState(false),
    [selection, setSelection] = useState<RevisionSelection | null>(null);
  const [marks, setMarks] = useState<readonly DocumentRevisionComment[]>([]);
  const [manage, setManage] = useState(props.initialAction === "settings");
  const [tab, setTab] = useState("settings"),
    [title, setTitle] = useState(props.displayName ?? props.artifact.name.replace(/\.zip$/i, ""));
  const [renaming, setRenaming] = useState(false),
    [renameError, setRenameError] = useState("");
  const initialOpened = useRef(false);
  const [renameUnknown, setRenameUnknown] = useState(false);
  const activePath = page || props.release?.manifest.entry_point || "";
  const previewUrl =
    props.preview?.release_id === props.artifact.id ? props.preview.url : undefined;
  const origin = previewUrl ? new URL(previewUrl).origin : "";
  const previewRoot = previewUrl ? new URL(previewUrl).pathname.match(/^\/v\/[^/]+\//)?.[0] : "";
  const url =
    origin && previewRoot
      ? new URL(activePath.split("/").map(encodeURIComponent).join("/"), `${origin}${previewRoot}`)
          .href
      : "";
  const frameIdentity = `${url}:${reload}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one handshake identity per concrete frame, generated before load can fire.
  const channel = useMemo(() => crypto.randomUUID(), [frameIdentity]);
  const loaded = loadedIdentity === frameIdentity;
  const bridgeReady = readyIdentity === frameIdentity;
  useEffect(() => {
    if (!url || loaded) return;
    const timer = setTimeout(() => setSlowIdentity(frameIdentity), 12000);
    return () => clearTimeout(timer);
  }, [url, loaded, frameIdentity]);
  const send = useCallback(
    (command: string, data: object = {}) => {
      if (!frame.current || !origin || !latest.current.isCurrent()) return;
      frame.current.contentWindow?.postMessage(
        { type: "zeroagent-site-command", channel, command, ...data },
        origin,
      );
    },
    [origin, channel],
  );
  // Configure and retire the isolated browsing context with its concrete URL.
  useEffect(() => {
    const host = canvas.current;
    if (!url || !host) return;
    const element = document.createElement("iframe");
    element.title = `${latest.current.displayName ?? latest.current.artifact.name} · 站点预览`;
    element.setAttribute("sandbox", "allow-scripts allow-same-origin allow-downloads");
    element.referrerPolicy = "no-referrer";
    element.allow =
      "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'";
    element.onload = () => {
      setLoadedIdentity(frameIdentity);
      send("init");
    };
    frame.current = element;
    host.append(element);
    element.src = url;
    return () => {
      element.onload = null;
      element.remove();
      if (frame.current === element) frame.current = null;
    };
  }, [url, frameIdentity, send]);
  useEffect(() => {
    if (props.initialAction === "share" && props.release && !props.busy && !initialOpened.current) {
      initialOpened.current = true;
      latest.current.onShare();
    }
  }, [props.initialAction, props.release, props.busy]);
  useEffect(() => {
    if (bridgeReady) send("mode", { enabled: modifying, cursor: COMMENT_CURSOR, pin: COMMENT_PIN });
  }, [send, modifying, bridgeReady]);
  useEffect(() => {
    if (bridgeReady)
      send("marks", { marks: marks.map((item) => ({ block: item.block, comment: item.comment })) });
  }, [send, marks, bridgeReady]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      const data = event.data;
      if (
        !latest.current.isCurrent() ||
        event.source !== frame.current?.contentWindow ||
        event.origin !== origin ||
        data?.type !== "zeroagent-site" ||
        data.channel !== channel ||
        data.path !== activePath
      )
        return;
      if (data.event === "ready") {
        setReadyIdentity(frameIdentity);
        return;
      }
      if (
        data.event === "navigate" &&
        !modifying &&
        typeof data.target === "string" &&
        props.release?.manifest.entries.some(
          (entry) => entry.path === data.target && entry.mime.startsWith("text/html"),
        )
      ) {
        setHistory((old) => [...old.slice(0, position), activePath]);
        setPosition(position + 1);
        setPage(data.target);
        return;
      }
      if (
        !modifying ||
        typeof data.id !== "string" ||
        !/^site:[a-z0-9-]+:\d{1,10}$/.test(data.id) ||
        ![data.x, data.y, data.width, data.height].every(
          (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100000,
        )
      )
        return;
      const bounds = frame.current?.getBoundingClientRect(),
        host = root.current?.getBoundingClientRect();
      if (!bounds || !host) return;
      const at = {
        x: Math.max(12, Math.min(bounds.left - host.left + data.x, host.width - 380)),
        y: Math.min(bounds.top - host.top + data.y, host.height - 90),
        visible: data.visible === true,
      };
      if (data.event === "position")
        setSelection((old) => (old && old.id === data.id ? { ...old, ...at } : old));
      if (
        data.event === "selection" &&
        typeof data.quote === "string" &&
        data.quote.length <= 1500 &&
        typeof data.selector === "string" &&
        data.selector.length <= 400
      ) {
        const quote = `页面：${activePath}\n元素：${data.selector}\n内容：${data.quote}`;
        setSelection({ id: data.id, page: 1, start: 0, end: quote.length, quote, ...at });
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [activePath, origin, props.release, modifying, position, channel, frameIdentity]);
  function navigate(delta: number) {
    const target = position + delta;
    if (target < 0 || target > history.length) return;
    if (delta < 0) {
      setHistory((old) => {
        const next = [...old];
        next[position] = activePath;
        return next;
      });
    }
    setPage(history[target] ?? props.release?.manifest.entry_point ?? "");
    setPosition(target);
  }
  function toggleModify() {
    if (modifying) exit.current?.();
    else setModifying(true);
  }
  function close() {
    if (modifying) exit.current?.();
    else props.onClose();
  }
  const name = props.displayName ?? props.artifact.name.replace(/\.zip$/i, "");
  return (
    <section
      ref={root}
      className="cloud-site-workspace"
      aria-label={`站点：${name}`}
      data-managing={manage || undefined}
    >
      <header className="cloud-site-browser-bar">
        <div className="cloud-site-browser-leading">
          {manage ? (
            <Action
              tooltip="返回站点预览"
              aria-label="返回站点预览"
              variant="ghost"
              onClick={() => setManage(false)}
            >
              <ArrowLeft className="size-4" />
              <span>站点</span>
            </Action>
          ) : (
            <>
              <div className="cloud-site-nav-capsule">
                <Action
                  tooltip="后退"
                  aria-label="后退"
                  variant="ghost"
                  size="icon-sm"
                  disabled={!position || modifying}
                  onClick={() => navigate(-1)}
                >
                  <ArrowLeft className="size-4" />
                </Action>
                <Action
                  tooltip="前进"
                  aria-label="前进"
                  variant="ghost"
                  size="icon-sm"
                  disabled={position >= history.length - 1 || modifying}
                  onClick={() => navigate(1)}
                >
                  <ArrowRight className="size-4" />
                </Action>
                <Action
                  tooltip="刷新站点"
                  aria-label="刷新站点"
                  variant="ghost"
                  size="icon-sm"
                  disabled={!url || modifying}
                  onClick={() => setReload((old) => old + 1)}
                >
                  <RefreshCw className={`size-4 ${!loaded && url ? "animate-spin" : ""}`} />
                </Action>
              </div>
              {props.onRequestRevision ? (
                <Action
                  variant="ghost"
                  className="cloud-site-modify"
                  aria-label="请求修改"
                  tooltip={bridgeReady ? "选择页面元素并提出修改要求" : "站点加载完成后可请求修改"}
                  disabled={!bridgeReady}
                  aria-pressed={modifying}
                  onClick={toggleModify}
                >
                  <SquareMousePointer className="size-4" />
                  <span>请求修改</span>
                </Action>
              ) : null}
            </>
          )}
        </div>
        <div className="cloud-site-browser-title" title={name}>
          <span>{name}</span>
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" title="打开私人站点">
              <Lock className="size-3" />
              <span>
                {new URL(url).hostname}
                {activePath !== props.release?.manifest.entry_point ? ` / ${activePath}` : ""}
              </span>
              <ExternalLink className="size-3" />
            </a>
          ) : (
            <small>私人站点 · v{props.artifact.number}</small>
          )}
        </div>
        <div className="cloud-site-browser-actions">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Action
                  variant="ghost"
                  size="icon-sm"
                  disabled={!url || manage}
                  tooltip="预览尺寸"
                  aria-label="预览尺寸"
                />
              }
            >
              <MonitorSmartphone className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" variant="soft">
              <DropdownMenuRadioGroup value={viewport} onValueChange={setViewport}>
                <DropdownMenuRadioItem value="fit">适合窗口</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="phone">手机 · 390 px</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="desktop">桌面 · 1280 px</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Action
            variant="ghost"
            disabled={!props.release || props.busy}
            onClick={props.onShare}
            aria-label="分享"
            tooltip="分享站点"
          >
            <Share2 className="size-4" />
            <span>分享</span>
          </Action>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Action
                  variant="ghost"
                  size="icon-sm"
                  disabled={modifying}
                  tooltip="管理站点"
                  aria-label="管理站点"
                />
              }
            >
              <Settings2 className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" variant="soft">
              <DropdownMenuItem
                onClick={() => {
                  setTab("settings");
                  setManage(true);
                }}
              >
                <Settings2 className="size-4" />
                站点设置
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setTab("versions");
                  setManage(true);
                }}
              >
                <History className="size-4" />
                版本历史记录
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setTab("files");
                  setManage(true);
                }}
              >
                <Code className="size-4" />
                构建文件
              </DropdownMenuItem>
              {props.onContinue ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={props.onContinue}>
                    <SquareMousePointer className="size-4" />与 AI 一起工作
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="cloud-site-window-capsule">
            {layout?.canSplit ? (
              <Action
                variant="ghost"
                size="icon-sm"
                tooltip={layout.expanded ? "返回并排视图" : "进入完整视图"}
                aria-label={layout.expanded ? "返回并排视图" : "进入完整视图"}
                onClick={layout.toggleExpanded}
              >
                {layout.expanded ? (
                  <Minimize2 className="size-4" />
                ) : (
                  <Maximize2 className="size-4" />
                )}
              </Action>
            ) : null}
            <Action
              variant="ghost"
              size="icon-sm"
              tooltip="关闭站点"
              aria-label="关闭站点"
              onClick={close}
            >
              <X className="size-4" />
            </Action>
          </div>
        </div>
      </header>
      {manage ? (
        <ScrollArea className="cloud-site-management-scroll">
          <div className="cloud-site-management">
            <div className="cloud-site-management-heading">
              <span>
                <Globe className="size-7" />
              </span>
              <div>
                <h1>{name}</h1>
                <p>
                  <Lock className="size-3" /> 私人站点 · v{props.artifact.number}
                </p>
              </div>
            </div>
            <nav aria-label="站点管理">
              <button
                type="button"
                aria-current={tab === "settings" ? "page" : undefined}
                onClick={() => setTab("settings")}
              >
                设置
              </button>
              <button
                type="button"
                aria-current={tab === "versions" ? "page" : undefined}
                onClick={() => setTab("versions")}
              >
                版本
              </button>
              <button
                type="button"
                aria-current={tab === "files" ? "page" : undefined}
                onClick={() => setTab("files")}
              >
                构建文件
              </button>
            </nav>
            {tab === "settings" ? (
              <>
                <h2>常规</h2>
                <div className="cloud-site-setting">
                  <div>
                    <label htmlFor="cloud-site-name">名称</label>
                    <p>资料空间中显示的站点名称</p>
                  </div>
                  <div className="cloud-site-name-field">
                    <Input
                      id="cloud-site-name"
                      value={title}
                      readOnly={!props.onRename}
                      maxLength={200}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                    {props.onRename ? (
                      <Button
                        size="sm"
                        disabled={renameUnknown || renaming || !title.trim() || title === name}
                        onClick={async () => {
                          setRenaming(true);
                          setRenameError("");
                          try {
                            await props.onRename?.(title.trim());
                          } catch (e) {
                            if (e instanceof Error && e.name === "CloudSpaceSaveUnconfirmedError")
                              setRenameUnknown(true);
                            setRenameError(e instanceof Error ? e.message : "名称保存失败");
                          } finally {
                            setRenaming(false);
                          }
                        }}
                      >
                        {renaming ? "保存中…" : "保存"}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {renameError ? (
                  <CloudChatFeedback compact tone="warning" message={renameError} />
                ) : null}
                <div className="cloud-site-setting">
                  <div>
                    <span>访问权限</span>
                    <p>只有你可以打开私人预览</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={props.onShare}>
                    <Lock className="size-4" />
                    管理分享
                  </Button>
                </div>
                <div className="cloud-site-setting">
                  <div>
                    <span>当前构建</span>
                    <p>版本固定，更新后保留历史内容</p>
                  </div>
                  <span>
                    v{props.artifact.number} ·{" "}
                    {new Date(props.artifact.created_at).toLocaleDateString("zh-CN")}
                  </span>
                </div>
                <h2>继续创作</h2>
                <div className="cloud-site-setting">
                  <div>
                    <span>在对话中修改</span>
                    <p>结合站点原始文件继续工作，检查后保存新版本。</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!props.onContinue}
                    onClick={props.onContinue}
                  >
                    编辑站点
                  </Button>
                </div>
              </>
            ) : tab === "versions" ? (
              <>
                <h2>版本历史记录</h2>
                <ResourceVersionTimeline
                  versions={props.versions}
                  selected={props.artifact.id}
                  busy={props.busy}
                  onSelect={props.onVersion}
                />
              </>
            ) : (
              <>
                <h2>
                  构建文件 <small>{props.release?.manifest.entries.length ?? 0}</small>
                </h2>
                <ul className="cloud-site-file-list">
                  {props.release?.manifest.entries.map((entry) => (
                    <li key={entry.path}>
                      <Code className="size-4" />
                      <span>{entry.path}</span>
                      <small>{Math.max(1, Math.round(entry.size / 1024))} KB</small>
                      {entry.path === props.release?.manifest.entry_point ? (
                        <span className="cloud-site-entry">首页</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </ScrollArea>
      ) : null}
      <div className="cloud-site-canvas" data-viewport={viewport} hidden={manage} inert={manage}>
        <div ref={canvas} className="cloud-site-frame-host" />
        {!url || !loaded ? (
          <div className="cloud-site-opening">
            {url && slowIdentity === frameIdentity ? (
              <>
                <Globe className="size-8" />
                <h2>站点暂未响应</h2>
                <p>可以重新加载，或稍后再打开。</p>
                <Button onClick={() => setReload((value) => value + 1)}>重新加载</Button>
              </>
            ) : props.busy || url ? (
              <PreviewLoading message="正在打开站点…" />
            ) : (
              <>
                <Globe className="size-8" />
                <h2>{props.unavailable ? "站点暂不可预览" : "打开你的站点"}</h2>
                <p>
                  {props.unavailable ? "站点内容仍保留在资料空间中" : "在私人空间中预览和继续创作"}
                </p>
                {!props.unavailable ? <Button onClick={props.onOpen}>预览站点</Button> : null}
              </>
            )}
          </div>
        ) : null}
      </div>
      {props.feedback ? (
        <div className="cloud-site-workspace-feedback">{props.feedback}</div>
      ) : null}
      <ResourceDocumentComments
        enabled={modifying}
        onEnabled={setModifying}
        selection={selection}
        onSelection={(next) => {
          setSelection(next);
          if (!next) send("clear");
        }}
        onMarks={setMarks}
        onNavigate={(block) => send("navigate", { id: block })}
        exitRef={exit}
      />
    </section>
  );
}
