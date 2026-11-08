import {
  ChevronRight,
  FolderClosed,
  MoreHorizontal,
  Plus,
  SquarePen,
} from "@liveagent/ui/components/IconSet";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type CloudAccountGuard,
  type CloudChatProjectsClient,
  type CloudProject,
  type CloudProjectConversation,
  CloudWorkError,
} from "@/lib/cloudChatProjects";
import { CloudProjectIcon } from "./CloudProjectIcon";

type ProjectNavigationProps = {
  client: CloudChatProjectsClient;
  captureGuard: CloudAccountGuard;
  revision: number;
  onOpen: (id?: string) => void;
  onCreate: () => void;
  renderConversation: (item: SidebarConversation) => ReactNode;
  onVisibleConversationsChange?: (
    projectId: string,
    items: readonly SidebarConversation[],
    position: number,
  ) => void;
  onNewConversation?: (project: CloudProject) => void;
  currentConversationId?: string;
  activeProjectId?: string;
  isOpen?: boolean;
};

function ProjectConversations(
  props: ProjectNavigationProps & {
    project: CloudProject;
    expanded: boolean;
    position: number;
    projectToggle: RefObject<HTMLButtonElement | null>;
  },
) {
  const { locale, t } = useLocale();
  const english = locale === "en-US";
  const untitled = t("chat.runNotification.untitled");
  const [items, setItems] = useState<CloudProjectConversation[]>([]);
  const [cursor, setCursor] = useState("");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failedPage, setFailedPage] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const pageAction = useRef<HTMLElement | null>(null);
  const focusAfterLastPage = useRef<Set<string> | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const loadedRevision = useRef<number | null>(null);
  const { client, captureGuard, project, revision, expanded, projectToggle, isOpen = true } = props;
  const load = useCallback(
    async (before = "") => {
      if (inFlight.current || (before && loadedRevision.current !== revision)) return;
      const epoch = generation.current;
      const guard = captureGuard();
      inFlight.current = true;
      setLoading(true);
      try {
        const page = await client.listConversations(project.id, before);
        guard();
        if (generation.current !== epoch) return;
        if (!page.next_before_id && pageAction.current === document.activeElement) {
          const existing = new Set(
            Array.from(
              list.current?.querySelectorAll<HTMLElement>("[data-project-conversation-id]") ?? [],
              (row) => row.dataset.projectConversationId,
            ),
          );
          focusAfterLastPage.current = new Set(
            page.items
              .filter((item) => !item.conversation?.archived && !existing.has(item.conversation_id))
              .map((item) => item.conversation_id),
          );
        }
        setItems((previous) => [
          ...new Map(
            (before ? [...previous, ...page.items] : page.items).map((item) => [
              item.conversation_id,
              item,
            ]),
          ).values(),
        ]);
        setCursor(page.next_before_id);
        setFailedPage(null);
        setReady(true);
        loadedRevision.current = revision;
      } catch {
        try {
          guard();
          if (generation.current === epoch) setFailedPage(before);
        } catch {
          /* Retired account. */
        }
      } finally {
        if (generation.current === epoch) {
          inFlight.current = false;
          setLoading(false);
        }
      }
    },
    [client, captureGuard, project.id, revision],
  );
  // Changing the read identity retires an in-flight page without replacing visible rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision owns the snapshot generation.
  useEffect(() => {
    return () => {
      generation.current++;
      inFlight.current = false;
    };
  }, [client, captureGuard, project.id, revision]);
  // Refresh only expanded groups. Collapsing keeps their loaded rows and scroll position.
  useEffect(() => {
    if (expanded && isOpen && (!ready || loadedRevision.current !== revision)) void load();
  }, [expanded, isOpen, revision, ready, load]);
  useEffect(() => {
    const target = sentinel.current;
    if (
      !target ||
      !expanded ||
      !isOpen ||
      !cursor ||
      loading ||
      failedPage !== null ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (active && entries.some((entry) => entry.isIntersecting)) void load(cursor);
      },
      { root: target.closest(".cloud-project-navigation"), rootMargin: "0px 0px 80px 0px" },
    );
    observer.observe(target);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [cursor, expanded, isOpen, loading, failedPage, load]);
  const visible = useMemo<SidebarConversation[]>(
    () =>
      items
        .filter((item) => !item.conversation?.archived)
        .map((binding) => ({
          id: binding.conversation_id,
          title: binding.conversation?.title || untitled,
          model: binding.conversation?.model || "",
          providerId: "web-chat",
          createdAt: Date.parse(binding.conversation?.created_at || binding.created_at),
          updatedAt: Date.parse(binding.conversation?.updated_at || binding.created_at),
          isPinned: binding.conversation?.pinned === true,
        }))
        .sort((a, b) => Number(!!b.isPinned) - Number(!!a.isPinned) || b.updatedAt - a.updatedAt),
    [items, untitled],
  );
  const { onVisibleConversationsChange, position } = props;
  useLayoutEffect(() => {
    const ids = focusAfterLastPage.current;
    focusAfterLastPage.current = null;
    if (!ids || !expanded || !isOpen) return;
    const first = visible.find((item) => ids.has(item.id));
    const row = Array.from(
      list.current?.querySelectorAll<HTMLElement>("[data-project-conversation-id]") ?? [],
    ).find((candidate) => candidate.dataset.projectConversationId === first?.id);
    (row?.querySelector<HTMLElement>("button, a[href]") ?? projectToggle.current)?.focus();
  }, [visible, expanded, isOpen, projectToggle]);
  useEffect(() => {
    onVisibleConversationsChange?.(project.id, expanded && isOpen ? visible : [], position);
    return () => onVisibleConversationsChange?.(project.id, [], position);
  }, [project.id, expanded, isOpen, visible, onVisibleConversationsChange, position]);
  return (
    <div ref={list} className="cloud-project-conversations">
      {visible.map((item) => (
        <div
          key={item.id}
          data-project-conversation-id={item.id}
          className="cloud-project-conversation"
        >
          {props.renderConversation(item)}
        </div>
      ))}
      {loading && !cursor && failedPage === null ? (
        <div
          role="status"
          aria-label={english ? "Loading project conversations" : "正在加载项目会话"}
          className="cloud-project-loading"
        >
          <span />
          <span />
        </div>
      ) : null}
      {cursor || failedPage !== null ? (
        <Button
          ref={pageAction}
          type="button"
          variant="ghost"
          size="sm"
          className="cloud-project-list-note h-auto min-h-8 w-full whitespace-normal text-left max-[820px]:min-h-11"
          aria-disabled={loading || undefined}
          aria-busy={loading || undefined}
          onClick={() => void load(failedPage ?? cursor)}
        >
          {loading
            ? english
              ? "Loading conversations…"
              : "正在加载会话…"
            : failedPage !== null
              ? english
                ? "Couldn't load conversations. Retry"
                : "会话加载失败，重试"
              : english
                ? "Load more conversations"
                : "加载更多会话"}
        </Button>
      ) : null}
      {ready && !loading && failedPage === null && !visible.length && !cursor ? (
        <p className="cloud-project-list-note">{english ? "No conversations yet" : "暂无对话"}</p>
      ) : null}
      {cursor ? <div ref={sentinel} aria-hidden="true" className="h-px" /> : null}
    </div>
  );
}

function ProjectGroup(props: ProjectNavigationProps & { project: CloudProject; position: number }) {
  const { locale } = useLocale();
  const english = locale === "en-US";
  const projectName = props.project.name;
  const [expanded, setExpanded] = useState(props.activeProjectId === props.project.id);
  const contentId = useId();
  const projectToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.activeProjectId === props.project.id) setExpanded(true);
  }, [props.activeProjectId, props.project.id]);
  return (
    <div
      className="cloud-project-group"
      data-expanded={expanded}
      data-current-project={props.activeProjectId === props.project.id ? "" : undefined}
    >
      <div className="cloud-project-heading">
        <button
          ref={projectToggle}
          type="button"
          className="cloud-sidebar-destination cloud-project-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="cloud-project-folder">
            <CloudProjectIcon icon={props.project.icon} color={props.project.color} />
            <ChevronRight className="size-4" />
          </span>
          <span className="truncate">{projectName}</span>
        </button>
        <div className="cloud-project-actions">
          <Button
            variant="ghost"
            size="icon-xs"
            title={english ? "Project settings" : "项目设置"}
            aria-label={
              english ? `Project settings for ${projectName}` : `项目设置：${projectName}`
            }
            onClick={() => props.onOpen(props.project.id)}
          >
            <MoreHorizontal className="size-4" />
          </Button>
          {props.onNewConversation ? (
            <Button
              variant="ghost"
              size="icon-xs"
              title={english ? "New conversation in project" : "在项目中新建对话"}
              aria-label={
                english ? `New conversation in ${projectName}` : `在${projectName}中新建对话`
              }
              onClick={() => props.onNewConversation?.(props.project)}
            >
              <SquarePen className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>
      <div
        id={contentId}
        className="cloud-project-disclosure"
        data-open={expanded}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div>
          <ProjectConversations {...props} expanded={expanded} projectToggle={projectToggle} />
        </div>
      </div>
    </div>
  );
}

export function CloudChatProjectNavigation(props: ProjectNavigationProps) {
  const { locale } = useLocale();
  const english = locale === "en-US";
  const newProjectLabel = english ? "New project" : "新建项目";
  const [projects, setProjects] = useState<CloudProject[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [activeRetry, setActiveRetry] = useState(0);
  const [activeRead, setActiveRead] = useState<{
    id: string;
    state: "loading" | "ready" | "failed" | "missing";
    project?: CloudProject;
  }>();
  const section = useRef<HTMLElement>(null);
  const directoryButton = useRef<HTMLButtonElement>(null);
  const retryActiveButton = useRef<HTMLButtonElement>(null);
  const activeReadFocus = useRef<string | undefined>(undefined);
  const { client, captureGuard, revision, activeProjectId } = props;
  const detachedProjectId =
    projects && activeProjectId && !projects.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : undefined;
  const currentActiveRead = activeRead?.id === detachedProjectId ? activeRead : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh counters invalidate this account-scoped list.
  useEffect(() => {
    let current = true;
    const guard = captureGuard();
    setLoading(true);
    setError(false);
    void client
      .listProjects()
      .then((page) => {
        guard();
        if (current) setProjects(page.items);
      })
      .catch(() => {
        try {
          guard();
          if (current) setError(true);
        } catch {
          /* Retired account. */
        }
      })
      .finally(() => {
        try {
          guard();
          if (current) setLoading(false);
        } catch {
          /* Retired account. */
        }
      });
    return () => {
      current = false;
    };
  }, [client, captureGuard, revision, retry]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Both retry and revision invalidate the detached project's snapshot.
  useEffect(() => {
    if (!detachedProjectId) return;
    const id = detachedProjectId;
    let current = true;
    const guard = captureGuard();
    const rememberRetryFocus = () => {
      if (retryActiveButton.current && document.activeElement === retryActiveButton.current)
        activeReadFocus.current = id;
    };
    setActiveRead((old) =>
      old?.id === id ? { ...old, state: "loading" } : { id, state: "loading" },
    );
    void client
      .getProject(id)
      .then((project) => {
        guard();
        if (!current) return;
        if (project.id !== id) throw new Error("Unexpected project identity");
        rememberRetryFocus();
        setActiveRead({ id, state: "ready", project });
      })
      .catch((cause) => {
        try {
          guard();
          if (!current) return;
          if (cause instanceof CloudWorkError && cause.status === 404) {
            rememberRetryFocus();
            setActiveRead({ id, state: "missing" });
          } else
            setActiveRead((old) =>
              old?.id === id ? { ...old, state: "failed" } : { id, state: "failed" },
            );
        } catch {
          /* Retired account. */
        }
      });
    return () => {
      current = false;
    };
  }, [client, captureGuard, detachedProjectId, revision, activeRetry]);
  useLayoutEffect(() => {
    if (!currentActiveRead || activeReadFocus.current !== currentActiveRead.id) return;
    activeReadFocus.current = undefined;
    const target = section.current?.querySelector<HTMLButtonElement>(
      "[data-current-project] .cloud-project-toggle",
    );
    (target ?? directoryButton.current)?.focus({ preventScroll: true });
  }, [currentActiveRead]);
  const shown = projects?.slice(0, 5) ?? [];
  const active =
    projects?.find((item) => item.id === activeProjectId) ?? currentActiveRead?.project;
  if (active && !shown.includes(active)) shown.push(active);
  return (
    <section
      ref={section}
      aria-label={english ? "Cloud projects" : "云端项目"}
      className="cloud-project-navigation"
    >
      <div className="flex items-center justify-between px-2.5 pb-1">
        <button
          ref={directoryButton}
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => props.onOpen()}
        >
          {english ? "Projects" : "项目"}
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={newProjectLabel}
          title={newProjectLabel}
          onClick={props.onCreate}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      {shown.map((project, position) => (
        <ProjectGroup {...props} key={project.id} project={project} position={position} />
      ))}
      {loading && !shown.length ? (
        <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">
          {english ? "Loading projects…" : "正在加载项目…"}
        </p>
      ) : null}
      {error ? (
        <button
          type="button"
          className="px-2.5 py-2 text-xs text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => setRetry((old) => old + 1)}
        >
          {english ? "Couldn't load projects. Retry" : "项目加载失败，重试"}
        </button>
      ) : null}
      {detachedProjectId && currentActiveRead?.state === "missing" ? (
        <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">
          {english ? "The current project is unavailable" : "当前项目已不可用"}
        </p>
      ) : null}
      {detachedProjectId &&
      currentActiveRead &&
      ["loading", "failed"].includes(currentActiveRead.state) ? (
        <Button
          ref={retryActiveButton}
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto min-h-8 w-full justify-start whitespace-normal px-2.5 text-left text-xs text-muted-foreground max-[820px]:min-h-11"
          aria-disabled={currentActiveRead.state === "loading" || undefined}
          aria-busy={currentActiveRead.state === "loading" || undefined}
          onClick={() => {
            if (currentActiveRead.state === "failed") setActiveRetry((old) => old + 1);
          }}
        >
          {currentActiveRead.state === "loading"
            ? english
              ? "Reading the current project…"
              : "正在读取当前项目…"
            : english
              ? "Couldn't load the current project. Retry"
              : "当前项目加载失败，重试"}
        </Button>
      ) : null}
      {!loading &&
      !error &&
      !shown.length &&
      (!detachedProjectId || currentActiveRead?.state === "missing") ? (
        <button
          type="button"
          className="cloud-sidebar-destination text-muted-foreground"
          onClick={props.onCreate}
        >
          <FolderClosed className="size-4" />
          {english ? "Create your first project" : "创建第一个项目"}
        </button>
      ) : null}
      {shown.length > 5 || (projects?.length ?? 0) > 5 ? (
        <button
          type="button"
          className="cloud-sidebar-destination text-muted-foreground"
          onClick={() => props.onOpen()}
        >
          {english ? "View all projects" : "查看全部项目"}
        </button>
      ) : null}
    </section>
  );
}
