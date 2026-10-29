import { FolderClosed, Plus } from "@liveagent/ui/components/IconSet";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useEffect, useState } from "react";
import type {
  CloudAccountGuard,
  CloudChatProjectsClient,
  CloudProject,
} from "@/lib/cloudChatProjects";

export function CloudChatProjectNavigation(props: {
  client: CloudChatProjectsClient;
  captureGuard: CloudAccountGuard;
  revision: number;
  onOpen: (id?: string) => void;
}) {
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const { client, captureGuard, revision } = props;
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
          onClick={() => props.onOpen()}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      {projects.slice(0, 5).map((project) => (
        <button
          key={project.id}
          type="button"
          className="cloud-sidebar-destination"
          onClick={() => props.onOpen(project.id)}
        >
          <FolderClosed className="size-4 shrink-0" />
          <span className="truncate">{project.name}</span>
        </button>
      ))}
      {loading ? (
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
          onClick={() => props.onOpen()}
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
