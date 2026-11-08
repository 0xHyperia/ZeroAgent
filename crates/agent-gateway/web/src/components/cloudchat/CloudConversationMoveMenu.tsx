import { Check, FolderOpen, Plus } from "@liveagent/ui/components/IconSet";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n";
import { useEffect, useState } from "react";
import type {
  CloudAccountGuard,
  CloudChatProjectsClient,
  CloudProject,
} from "@/lib/cloudChatProjects";
import { CloudProjectIcon } from "./CloudProjectIcon";

/** Host-owned cloud destinations inside the shared conversation row menu. */
export function CloudConversationMoveMenu(props: {
  conversationId: string;
  client: CloudChatProjectsClient;
  captureGuard: CloudAccountGuard;
  disabled: boolean;
  onMove: (project: CloudProject | null) => Promise<void>;
  onCreate: () => void;
  onError: (message: string) => void;
}) {
  const { locale } = useLocale();
  const english = locale === "en-US";
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CloudProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [cursor, setCursor] = useState("");
  const [next, setNext] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const { client, captureGuard, conversationId } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly re-reads this menu page.
  useEffect(() => {
    if (!open) {
      setCursor("");
      return;
    }
    let current = true;
    const guard = captureGuard();
    setLoading(true);
    setError(false);
    void Promise.all([client.listProjects(cursor), client.getAssociation(conversationId)])
      .then(([page, binding]) => {
        guard();
        if (!current) return;
        setItems((previous) =>
          cursor
            ? [...new Map([...previous, ...page.items].map((item) => [item.id, item])).values()]
            : page.items,
        );
        setProjectId(binding.project_id);
        setNext(page.next_before_id);
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
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [open, cursor, client, captureGuard, conversationId, retry]);
  function move(project: CloudProject | null) {
    const guard = captureGuard();
    void props.onMove(project).catch((cause) => {
      try {
        guard();
        props.onError(
          cause instanceof Error
            ? cause.message
            : english
              ? "Couldn't move the conversation. Try again."
              : "移动失败，请重试。",
        );
      } catch {
        /* Retired account. */
      }
    });
  }
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger disabled={props.disabled} className="gap-2 text-xs">
        <FolderOpen className="size-3.5 shrink-0" />
        {english ? "Move to project" : "移至项目"}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        side="right"
        variant="soft"
        className="w-56 max-h-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <DropdownMenuItem className="gap-2" disabled={props.disabled} onClick={props.onCreate}>
          <Plus className="size-4" />
          {english ? "New project" : "新建项目"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {items.map((project) => (
          <DropdownMenuItem
            key={project.id}
            className="gap-2"
            disabled={props.disabled || loading || projectId === project.id}
            onClick={() => move(project)}
          >
            <CloudProjectIcon icon={project.icon} color={project.color} />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {projectId === project.id ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
        {loading ? (
          <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">
            {english ? "Loading projects…" : "正在加载项目…"}
          </p>
        ) : null}
        {error ? (
          <DropdownMenuItem closeOnClick={false} onClick={() => setRetry((value) => value + 1)}>
            {english ? "Couldn't load projects. Retry" : "项目加载失败，重试"}
          </DropdownMenuItem>
        ) : null}
        {!loading && !error && !items.length ? (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">
            {english ? "No projects yet" : "还没有项目"}
          </p>
        ) : null}
        {next && !error ? (
          <DropdownMenuItem closeOnClick={false} disabled={loading} onClick={() => setCursor(next)}>
            {english ? "Show more projects" : "查看更多项目"}
          </DropdownMenuItem>
        ) : null}
        {projectId && !error ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={props.disabled || loading} onClick={() => move(null)}>
              {english ? "Remove from project" : "移出项目"}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
