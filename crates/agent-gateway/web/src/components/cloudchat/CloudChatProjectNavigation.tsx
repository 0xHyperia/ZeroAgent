import {
  ChevronRight,
  FolderClosed,
  MoreHorizontal,
  Plus,
  SquarePen,
} from "@liveagent/ui/components/IconSet";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  CloudAccountGuard,
  CloudChatProjectsClient,
  CloudProject,
  CloudProjectConversation,
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
  props: ProjectNavigationProps & { project: CloudProject; expanded: boolean; position: number },
) {
  const [items, setItems] = useState<CloudProjectConversation[]>([]);
  const [cursor, setCursor] = useState("");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const loadedRevision = useRef<number | null>(null);
  const { client, captureGuard, project, revision, expanded, isOpen = true } = props;
  const load = useCallback(
    async (before = "") => {
      if (inFlight.current) return;
      const epoch = generation.current;
      const guard = captureGuard();
      inFlight.current = true;
      setLoading(true);
      setError(false);
      try {
        const page = await client.listConversations(project.id, before);
        guard();
        if (generation.current !== epoch) return;
        setItems((previous) => [
          ...new Map(
            (before ? [...previous, ...page.items] : page.items).map((item) => [
              item.conversation_id,
              item,
            ]),
          ).values(),
        ]);
        setCursor(page.next_before_id);
        setReady(true);
        loadedRevision.current = revision;
      } catch {
        try {
          guard();
          if (generation.current === epoch) setError(true);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry is an explicit read invalidation.
  useEffect(() => {
    if (expanded && isOpen && (!ready || loadedRevision.current !== revision)) void load();
  }, [expanded, isOpen, revision, ready, load, retry]);
  useEffect(() => {
    const target = sentinel.current;
    if (
      !target ||
      !expanded ||
      !isOpen ||
      !cursor ||
      loading ||
      error ||
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
  }, [cursor, expanded, isOpen, loading, error, load]);
  const visible = useMemo<SidebarConversation[]>(
    () =>
      items
        .filter((item) => !item.conversation?.archived)
        .map((binding) => ({
          id: binding.conversation_id,
          title: binding.conversation?.title || "未命名对话",
          model: binding.conversation?.model || "",
          providerId: "web-chat",
          createdAt: Date.parse(binding.conversation?.created_at || binding.created_at),
          updatedAt: Date.parse(binding.conversation?.updated_at || binding.created_at),
          isPinned: binding.conversation?.pinned === true,
        }))
        .sort((a, b) => Number(!!b.isPinned) - Number(!!a.isPinned) || b.updatedAt - a.updatedAt),
    [items],
  );
  const { onVisibleConversationsChange, position } = props;
  useEffect(() => {
    onVisibleConversationsChange?.(project.id, expanded && isOpen ? visible : [], position);
    return () => onVisibleConversationsChange?.(project.id, [], position);
  }, [project.id, expanded, isOpen, visible, onVisibleConversationsChange, position]);
  return (
    <div className="cloud-project-conversations">
      {visible.map((item) => (
        <div key={item.id} className="cloud-project-conversation">
          {props.renderConversation(item)}
        </div>
      ))}
      {loading ? (
        <div role="status" aria-label="正在加载项目会话" className="cloud-project-loading">
          <span />
          <span />
        </div>
      ) : null}
      {error ? (
        <button
          type="button"
          className="cloud-project-list-note hover:text-foreground"
          onClick={() => {
            loadedRevision.current = null;
            setRetry((value) => value + 1);
          }}
        >
          会话加载失败，重试
        </button>
      ) : null}
      {ready && !loading && !error && !visible.length && !cursor ? (
        <p className="cloud-project-list-note">暂无对话</p>
      ) : null}
      {cursor ? <div ref={sentinel} aria-hidden="true" className="h-px" /> : null}
    </div>
  );
}

function ProjectGroup(props: ProjectNavigationProps & { project: CloudProject; position: number }) {
  const [expanded, setExpanded] = useState(props.activeProjectId === props.project.id);
  const contentId = useId();
  useEffect(() => {
    if (props.activeProjectId === props.project.id) setExpanded(true);
  }, [props.activeProjectId, props.project.id]);
  return (
    <div className="cloud-project-group" data-expanded={expanded}>
      <div className="cloud-project-heading">
        <button
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
          <span className="truncate">{props.project.name}</span>
        </button>
        <div className="cloud-project-actions">
          <Button
            variant="ghost"
            size="icon-xs"
            title="项目设置"
            aria-label={`项目设置：${props.project.name}`}
            onClick={() => props.onOpen(props.project.id)}
          >
            <MoreHorizontal className="size-4" />
          </Button>
          {props.onNewConversation ? (
            <Button
              variant="ghost"
              size="icon-xs"
              title="在项目中新建对话"
              aria-label={`在${props.project.name}中新建对话`}
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
          <ProjectConversations {...props} expanded={expanded} />
        </div>
      </div>
    </div>
  );
}

export function CloudChatProjectNavigation(props: ProjectNavigationProps) {
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const { client, captureGuard, revision, activeProjectId } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh counters invalidate this account-scoped list.
  useEffect(() => {
    let current = true;
    const guard = captureGuard();
    setLoading(true);
    setError(false);
    void client
      .listProjects()
      .then(async (page) => {
        guard();
        // A selected project can be outside the catalog's first page.
        const active =
          activeProjectId && !page.items.some((item) => item.id === activeProjectId)
            ? await client.getProject(activeProjectId)
            : null;
        guard();
        if (current) setProjects(active ? [active, ...page.items] : page.items);
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
  }, [client, captureGuard, revision, retry, activeProjectId]);
  const shown = projects.slice(0, 5);
  const active = projects.find((item) => item.id === activeProjectId);
  if (active && !shown.includes(active)) shown.push(active);
  return (
    <section aria-label="云端项目" className="cloud-project-navigation">
      <div className="flex items-center justify-between px-2.5 pb-1">
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => props.onOpen()}
        >
          项目
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="新建项目"
          title="新建项目"
          onClick={props.onCreate}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      {shown.map((project, position) => (
        <ProjectGroup {...props} key={project.id} project={project} position={position} />
      ))}
      {loading && projects.length === 0 ? (
        <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">
          正在加载项目…
        </p>
      ) : null}
      {error ? (
        <button
          type="button"
          className="px-2.5 py-2 text-xs text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => setRetry((old) => old + 1)}
        >
          项目加载失败，重试
        </button>
      ) : null}
      {!loading && !error && projects.length === 0 ? (
        <button
          type="button"
          className="cloud-sidebar-destination text-muted-foreground"
          onClick={props.onCreate}
        >
          <FolderClosed className="size-4" />
          创建第一个项目
        </button>
      ) : null}
      {projects.length > 5 ? (
        <button
          type="button"
          className="cloud-sidebar-destination text-muted-foreground"
          onClick={() => props.onOpen()}
        >
          查看全部项目
        </button>
      ) : null}
    </section>
  );
}
