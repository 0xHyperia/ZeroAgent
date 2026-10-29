import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CloudChatFile, CloudChatFilesClient } from "@/lib/cloudChatFiles";
import {
  type CloudAccountGuard,
  type CloudChatProjectsClient,
  type CloudProject,
  type CloudProjectConversation,
  type CloudProjectDraft,
  CloudWorkUnconfirmedError,
} from "@/lib/cloudChatProjects";
import { useCloudWorkPanel } from "./useCloudWorkPanel";

type Props = {
  client: CloudChatProjectsClient;
  initialProjectId?: string;
  filesClient?: CloudChatFilesClient;
  conversationId?: string | null;
  captureGuard: CloudAccountGuard;
  onProjectChange?: (binding: CloudProjectConversation) => void;
  onOpenConversation?: (id: string) => void;
  onContextChanged?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onRequestNavigation?: (action: () => void) => void;
};
const emptyDraft = (): CloudProjectDraft => ({ name: "", description: "", instructions: "" });

export function CloudChatProjectsPanel({
  client,
  initialProjectId,
  filesClient,
  conversationId,
  captureGuard,
  onProjectChange,
  onOpenConversation,
  onContextChanged,
  onDirtyChange,
  onRequestNavigation,
}: Props) {
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [projectsReady, setProjectsReady] = useState(false);
  const [next, setNext] = useState("");
  const [selected, setSelected] = useState<CloudProject | null>(null);
  const [draft, setDraft] = useState<CloudProjectDraft>(emptyDraft);
  const [association, setAssociation] = useState<CloudProjectConversation | null>(null);
  const [conversations, setConversations] = useState<CloudProjectConversation[]>([]);
  const [conversationNext, setConversationNext] = useState("");
  const [files, setFiles] = useState<CloudChatFile[]>([]);
  const [library, setLibrary] = useState<CloudChatFile[]>([]);
  const [libraryNext, setLibraryNext] = useState("");
  const [fileChoice, setFileChoice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const { busy, error, setError, run } = useCloudWorkPanel(captureGuard, conversationId);
  const automaticSelectionScope = useRef<string | null>(null);
  const formId = useId();
  const initialSelection = useRef(false);
  const dirty =
    draft.name !== (selected?.name ?? "") ||
    draft.description !== (selected?.description ?? "") ||
    draft.instructions !== (selected?.instructions ?? "");
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    void run(async (guard) => {
      const page = await client.listProjects();
      guard();
      setProjects(page.items);
      setNext(page.next_before_id);
      setProjectsReady(true);
    });
  }, [client, run]);
  useEffect(() => {
    let current = true;
    setAssociation(null);
    if (conversationId) {
      const guard = captureGuard();
      void client
        .getAssociation(conversationId)
        .then((binding) => {
          guard();
          if (current) setAssociation(binding);
        })
        .catch((cause) => {
          try {
            guard();
            if (current)
              setError(cause instanceof Error ? cause.message : "会话项目暂时不可用，请刷新。");
          } catch {
            /* Account retired. */
          }
        });
    }
    return () => {
      current = false;
    };
  }, [client, conversationId, captureGuard, setError]);

  const replace = useCallback((project: CloudProject) => {
    setProjects((previous) =>
      previous.some((item) => item.id === project.id)
        ? previous.map((item) => (item.id === project.id ? project : item))
        : [project, ...previous],
    );
    setSelected(project);
  }, []);
  const loadProject = useCallback(
    async (project: Pick<CloudProject, "id">, guard: () => void, preserveDraft = false) => {
      const [current, history, references, accountFiles] = await Promise.all([
        client.getProject(project.id),
        client.listConversations(project.id),
        client.listFiles(project.id),
        filesClient?.list(),
      ]);
      guard();
      replace(current);
      if (!preserveDraft)
        setDraft({
          name: current.name,
          description: current.description,
          instructions: current.instructions,
        });
      setConversations(history.items);
      setConversationNext(history.next_before_id);
      setFiles(references.items);
      setLibrary(accountFiles?.files ?? []);
      setLibraryNext(accountFiles?.nextCursor ?? "");
      setFileChoice("");
      setConfirmDelete(false);
    },
    [client, filesClient, replace],
  );

  useEffect(() => {
    if (initialProjectId !== undefined) return;
    const scope = conversationId ?? "";
    if (busy || !association || automaticSelectionScope.current === scope) return;
    automaticSelectionScope.current = scope;
    if (association.project_id) {
      void run((guard) => loadProject({ id: association.project_id }, guard));
    }
  }, [association, busy, conversationId, loadProject, run, initialProjectId]);
  useEffect(() => {
    if (!initialProjectId || !projectsReady || initialSelection.current || busy) return;
    initialSelection.current = true;
    automaticSelectionScope.current = conversationId ?? "";
    void run((guard) => loadProject({ id: initialProjectId }, guard));
  }, [initialProjectId, projectsReady, busy, conversationId, loadProject, run]);
  function refresh() {
    void run(async (guard) => {
      const page = await client.listProjects();
      const binding = conversationId ? await client.getAssociation(conversationId) : null;
      guard();
      setProjects(page.items);
      setNext(page.next_before_id);
      setAssociation(binding);
      if (selected) await loadProject(selected, guard, true);
      guard();
      setUnconfirmed(false);
    });
  }

  return (
    <section aria-label="CloudChat 项目" className="space-y-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">项目资料与指令</h2>
        <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>
          刷新列表
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <select
          aria-label="选择项目"
          className="min-w-0 flex-1 rounded-md border bg-background p-2"
          value={selected?.id ?? ""}
          disabled={busy}
          onChange={(event) => {
            const nextId = event.target.value;
            const navigate = () => {
              automaticSelectionScope.current = conversationId ?? "";
              const project = projects.find((item) => item.id === nextId);
              if (project) void run((guard) => loadProject(project, guard));
              else {
                setSelected(null);
                setDraft(emptyDraft());
                setFiles([]);
                setConversations([]);
                setConfirmDelete(false);
              }
            };
            if (onRequestNavigation) onRequestNavigation(navigate);
            else navigate();
          }}
        >
          <option value="">新建项目</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>
      {next && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async (guard) => {
              const page = await client.listProjects(next);
              guard();
              setProjects((previous) => [...previous, ...page.items]);
              setNext(page.next_before_id);
            })
          }
        >
          加载更多项目
        </Button>
      )}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async (guard) => {
            try {
              const project = selected
                ? await client.updateProject(selected, draft)
                : await client.createProject(draft);
              guard();
              replace(project);
              setDraft({
                name: project.name,
                description: project.description,
                instructions: project.instructions,
              });
              onContextChanged?.();
            } catch (cause) {
              guard();
              if (cause instanceof CloudWorkUnconfirmedError) setUnconfirmed(true);
              throw cause;
            }
          });
        }}
      >
        <label className="block space-y-1" htmlFor={`${formId}-name`}>
          <span>项目名称</span>
          <Input
            id={`${formId}-name`}
            aria-label="项目名称"
            value={draft.name}
            onChange={(event) => setDraft((old) => ({ ...old, name: event.target.value }))}
            disabled={busy}
          />
        </label>
        <label className="block space-y-1" htmlFor={`${formId}-description`}>
          <span>项目说明</span>
          <Textarea
            id={`${formId}-description`}
            aria-label="项目说明"
            value={draft.description}
            onChange={(event) => setDraft((old) => ({ ...old, description: event.target.value }))}
            disabled={busy}
          />
        </label>
        <label className="block space-y-1" htmlFor={`${formId}-instructions`}>
          <span>项目指令</span>
          <Textarea
            id={`${formId}-instructions`}
            aria-label="项目指令"
            value={draft.instructions}
            onChange={(event) => setDraft((old) => ({ ...old, instructions: event.target.value }))}
            placeholder="这个项目的目标、术语和输出偏好。"
            disabled={busy}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={busy || (!selected && unconfirmed) || !draft.name.trim()}
          >
            {selected ? "保存项目" : "创建项目"}
          </Button>
          {selected && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              删除项目
            </Button>
          )}
        </div>
      </form>
      {selected && (
        <>
          {confirmDelete && (
            <div className="space-y-2 rounded-md border p-3 text-xs">
              <p>删除项目会解除关联，会话与文件原件仍保留。</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    void run(async (guard) => {
                      await client.removeProject(selected);
                      const binding = conversationId
                        ? await client.getAssociation(conversationId)
                        : null;
                      guard();
                      setProjects((previous) => previous.filter((item) => item.id !== selected.id));
                      setSelected(null);
                      setDraft(emptyDraft());
                      setConfirmDelete(false);
                      setAssociation(binding);
                      setFiles([]);
                      setConversations([]);
                      if (binding) onProjectChange?.(binding);
                      onContextChanged?.();
                    })
                  }
                >
                  确认删除项目
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  保留项目
                </Button>
              </div>
            </div>
          )}
          <div className="space-y-2 border-t pt-3">
            <h3 className="text-xs font-medium">当前会话</h3>
            {conversationId ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {association?.project_id === selected.id
                    ? "当前会话已归入此项目。"
                    : "将当前会话归入项目，可在后续请求中使用项目指令和资料。"}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !association}
                  onClick={() =>
                    void run(async (guard) => {
                      if (!association) return;
                      const binding = await client.setAssociation(
                        conversationId,
                        association.project_id === selected.id ? "" : selected.id,
                        association.version,
                      );
                      guard();
                      setAssociation(binding);
                      onProjectChange?.(binding);
                      onContextChanged?.();
                      await loadProject(selected, guard, true);
                    })
                  }
                >
                  {association?.project_id === selected.id ? "移出此项目" : "归入此项目"}
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">创建会话后可将它归入项目。</p>
            )}
          </div>
          <div className="space-y-2 border-t pt-3">
            <h3 className="text-xs font-medium">项目会话</h3>
            {conversations.map((binding) => (
              <Button
                key={binding.conversation_id}
                size="sm"
                variant="ghost"
                className="max-w-full justify-start truncate"
                disabled={busy || !onOpenConversation}
                onClick={() => onOpenConversation?.(binding.conversation_id)}
              >
                {binding.conversation?.title || "未命名会话"}
              </Button>
            ))}
            {conversations.length === 0 && (
              <p className="text-xs text-muted-foreground">还没有关联的会话。</p>
            )}
            {conversationNext && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async (guard) => {
                    const page = await client.listConversations(selected.id, conversationNext);
                    guard();
                    setConversations((previous) => [...previous, ...page.items]);
                    setConversationNext(page.next_before_id);
                  })
                }
              >
                加载更多会话
              </Button>
            )}
          </div>
          <div className="space-y-2 border-t pt-3">
            <h3 className="text-xs font-medium">项目资料</h3>
            <p className="text-xs text-muted-foreground">
              关联已解析的文件，原件继续保存在账号文件库。
            </p>
            {files.map((file) => (
              <div key={file.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 break-words">{file.name}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !filesClient}
                  onClick={() =>
                    void run(async (guard) => {
                      if (!filesClient) return;
                      const result = await filesClient.download(file);
                      guard();
                      result.guard();
                      const url = URL.createObjectURL(result.blob);
                      try {
                        guard();
                        result.guard();
                        const anchor = document.createElement("a");
                        anchor.href = url;
                        anchor.download = file.name;
                        anchor.click();
                      } finally {
                        URL.revokeObjectURL(url);
                      }
                    })
                  }
                >
                  下载原件
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async (guard) => {
                      const updated = await client.setFile(selected, file.id, false);
                      guard();
                      replace(updated);
                      setFiles((previous) => previous.filter((item) => item.id !== file.id));
                      onContextChanged?.();
                    })
                  }
                >
                  解除关联
                </Button>
              </div>
            ))}
            {filesClient && (
              <div className="flex gap-2">
                <select
                  aria-label="选择项目资料"
                  className="min-w-0 flex-1 rounded-md border bg-background p-2 text-xs"
                  value={fileChoice}
                  disabled={busy}
                  onChange={(event) => setFileChoice(event.target.value)}
                >
                  <option value="">从账号文件库选择</option>
                  {library
                    .filter(
                      (file) =>
                        file.state === "ready" && !files.some((item) => item.id === file.id),
                    )
                    .map((file) => (
                      <option key={file.id} value={file.id}>
                        {file.name}
                      </option>
                    ))}
                </select>
                <Button
                  size="sm"
                  disabled={busy || !fileChoice}
                  onClick={() =>
                    void run(async (guard) => {
                      const updated = await client.setFile(selected, fileChoice, true);
                      const page = await client.listFiles(selected.id);
                      guard();
                      replace(updated);
                      setFiles(page.items);
                      setFileChoice("");
                      onContextChanged?.();
                    })
                  }
                >
                  关联资料
                </Button>
              </div>
            )}
            {libraryNext && filesClient && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async (guard) => {
                    const page = await filesClient.list({ before: libraryNext });
                    guard();
                    setLibrary((previous) => [...previous, ...page.files]);
                    setLibraryNext(page.nextCursor);
                  })
                }
              >
                加载更多文件
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
