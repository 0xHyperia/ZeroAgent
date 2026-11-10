import {
  ChevronDown,
  Folder,
  GitBranch,
  Globe,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Terminal,
} from "@liveagent/ui/components/IconSet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  isEditableShortcutTarget,
  isKeyEventHandledElsewhere,
  matchesAccelerator,
} from "@liveagent/ui/lib/shortcuts/shortcutKeys";
import { useEffect, useRef } from "react";
import { formatBrowserAddress, safeBrowserUrl } from "@liveagent/ui/components/project-tools/workspaceBrowserAddress";
import type { BrowserHistorySnapshot } from "@liveagent/ui/components/project-tools/workspaceBrowserHistory";

export type BrowserNewTabTools = {
  changes?: () => void;
  terminal?: () => void;
  bottomTerminal?: () => void;
  files?: () => void;
  sideChat?: () => void;
  more?: readonly { label: string; run: () => void }[];
};

export type BrowserVisit = {
  url: string;
  title?: string;
  history?: BrowserHistorySnapshot;
};

const toolShortcuts = {
  changes: ["Ctrl+Shift+KeyG", "Ctrl+Shift+G", "Control+Shift+G"],
  terminal: ["Ctrl+Backquote", "Ctrl+`", "Control+`"],
  files: ["Ctrl+KeyP", "Ctrl+P", "Control+P"],
  sideChat: ["Ctrl+Alt+KeyS", "Ctrl+Alt+S", "Control+Alt+S"],
} as const;

export function browserRecommendations(visits: readonly BrowserVisit[]) {
  const sites = new Map<string, { url: string; label: string; visits: number }>();
  function record(input: string, title?: string) {
    const normalized = safeBrowserUrl(input);
    if (!normalized) return;
    const url = new URL(normalized);
    url.search = "";
    url.hash = "";
    const previous = sites.get(url.origin);
    const label = title?.trim() || previous?.label || formatBrowserAddress(url.href);
    sites.set(url.origin, { url: url.href, label, visits: (previous?.visits ?? 0) + 1 });
  }
  for (const { url, title, history } of visits) {
    for (const entry of history?.entries ?? []) record(entry);
    if (url) record(url, title);
  }
  return [...sites.values()].sort((left, right) => right.visits - left.visits).slice(0, 4);
}

export function BrowserNewTab({
  active,
  tools,
  visits,
  onNavigate,
  onOpenTab,
  onOpenAddress,
  onOpenOptions,
  onVisitStore,
}: {
  active: boolean;
  tools?: BrowserNewTabTools;
  visits: readonly BrowserVisit[];
  onNavigate: (url: string) => void;
  onOpenTab: (url: string, foreground: boolean) => void;
  onOpenAddress: () => void;
  onOpenOptions: () => void;
  onVisitStore: () => void;
}) {
  const { locale } = useLocale();
  const zh = locale.startsWith("zh");
  const copy = (en: string, cn: string) => (zh ? cn : en);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !tools) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        isEditableShortcutTarget(event.target) ||
        isKeyEventHandledElsewhere(event)
      )
        return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && !content.current?.contains(focused)) return;
      for (const [id, [accelerator]] of Object.entries(toolShortcuts)) {
        const run = tools[id as keyof typeof toolShortcuts];
        if (!run || !matchesAccelerator(event, accelerator, false)) continue;
        event.preventDefault();
        run();
        break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, tools]);
  const actions = [
    { id: "changes", label: copy("Changes", "变更"), icon: GitBranch, run: tools?.changes },
    { id: "terminal", label: copy("Terminal", "终端"), icon: Terminal, run: tools?.terminal },
    { id: "files", label: copy("Files", "文件"), icon: Folder, run: tools?.files },
    {
      id: "sideChat",
      label: copy("Side chat", "侧边聊天"),
      icon: MessageSquare,
      run: tools?.sideChat,
    },
    {
      id: "address",
      label: copy("Open webpage", "打开网页"),
      icon: Globe,
      run: onOpenAddress,
    },
  ] as const;
  const recommendations = browserRecommendations(visits);
  return (
    <div ref={content} className="za-browser-new-tab">
      <div className="za-browser-new-tab-content">
        <section aria-label={copy("Tools", "工具")}>
          <h3>{copy("Tools", "工具")}</h3>
          <div className="za-browser-new-tab-tools">
            {actions.map(({ id, label, icon: Icon, run }) =>
              run ? (
                <div className="za-browser-new-tab-action" key={label}>
                  <button
                    type="button"
                    onClick={run}
                    aria-keyshortcuts={id === "address" ? undefined : toolShortcuts[id][2]}
                    className="za-browser-new-tab-tool"
                  >
                    <Icon />
                    <span>{label}</span>
                    {id !== "address" && <kbd>{toolShortcuts[id][1]}</kbd>}
                  </button>
                  {id === "terminal" && tools?.bottomTerminal && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <button
                            type="button"
                            className="za-browser-new-tab-terminal-menu"
                            aria-label={copy("Terminal options", "终端选项")}
                          />
                        }
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={tools.bottomTerminal}>
                          {copy("Open bottom terminal", "在底部打开终端")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              ) : null,
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className="za-browser-new-tab-tool za-browser-new-tab-more"
                  />
                }
              >
                <LayoutGrid />
                <span>{copy("More tools…", "更多工具…")}</span>
                <ChevronDown />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{copy("Browser", "浏览器")}</DropdownMenuLabel>
                <DropdownMenuItem onClick={onOpenOptions}>
                  {copy("Browser options", "浏览器选项")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onVisitStore}>
                  {copy("Visit Web Store", "访问扩展商店")}
                </DropdownMenuItem>
                {tools?.more?.map(({ label, run }) => (
                  <DropdownMenuItem key={label} onClick={run}>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </section>
        {recommendations.length > 0 && (
          <section aria-label={copy("Suggested", "推荐")}>
            <h3>{copy("Suggested", "推荐")}</h3>
            <ul className="za-browser-new-tab-sites">
              {recommendations.map(({ url, label }) => (
                <li key={url}>
                  <a
                    href={url}
                    title={label}
                    onClick={(event) => {
                      event.preventDefault();
                      if (event.ctrlKey || event.metaKey) onOpenTab(url, event.shiftKey);
                      else onNavigate(url);
                    }}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return;
                      event.preventDefault();
                      onOpenTab(url, false);
                    }}
                  >
                    <span className="za-browser-new-tab-site-icon">
                      {new URL(url).hostname === "agent.usa0.top" ? (
                        <img src="/zeroagent-logo.png" alt="" draggable={false} />
                      ) : (
                        <Globe />
                      )}
                    </span>
                    <span className="za-browser-new-tab-site-title">{label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
