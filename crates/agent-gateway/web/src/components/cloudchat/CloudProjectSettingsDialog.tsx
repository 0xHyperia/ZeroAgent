import { FileText, Plus, RefreshCw, Search, Trash2, X } from "@liveagent/ui/components/IconSet";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@liveagent/ui/components/ui/alert-dialog";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { useEffect, useId, useRef, useState } from "react";
import type { CloudChatFile, CloudChatFilesClient } from "@/lib/cloudChatFiles";
import type {
  CloudAccountGuard,
  CloudChatProjectsClient,
  CloudProject,
  CloudProjectDraft,
} from "@/lib/cloudChatProjects";
import { MOBILE_BACK_EVENT } from "@/lib/mobileRuntime";
import { CloudProjectIcon, CloudProjectIconPicker } from "./CloudProjectIcon";
import { useCloudWorkPanel } from "./useCloudWorkPanel";

type Props = {
  projectId?: string;
  client: CloudChatProjectsClient;
  filesClient: CloudChatFilesClient;
  captureGuard: CloudAccountGuard;
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
  onSelect: (projectId: string) => void;
  onCreate: () => void;
  onChanged: () => void;
  onPreviewFile: (fileId: string) => void;
};
const toDraft = (project: CloudProject): CloudProjectDraft => ({
  name: project.name,
  description: project.description,
  instructions: project.instructions,
  icon: project.icon || "folder",
  color: project.color || "default",
});

function ProjectCatalog(props: Props) {
  const [items, setItems] = useState<CloudProject[]>([]);
  const [next, setNext] = useState("");
  const [search, setSearch] = useState("");
  const { busy, error, run } = useCloudWorkPanel(props.captureGuard);
  const { client } = props;
  useEffect(() => {
    void run(async (guard) => {
      const page = await client.listProjects();
      guard();
      setItems(page.items);
      setNext(page.next_before_id);
    });
  }, [client, run]);
  return (
    <>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
        <Input
          aria-label="搜索已加载项目"
          placeholder="搜索项目"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-10 rounded-xl pl-9"
        />
      </div>
      <div className="max-h-[50dvh] space-y-1 overflow-auto" aria-busy={busy}>
        <button type="button" className="cloud-project-catalog-row" onClick={props.onCreate}>
          <Plus className="size-5" />
          <span>新建项目</span>
        </button>
        {items
          .filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()))
          .map((project) => (
            <button
              type="button"
              key={project.id}
              className="cloud-project-catalog-row"
              onClick={() => props.onSelect(project.id)}
            >
              <CloudProjectIcon
                icon={project.icon}
                color={project.color}
                className="size-5 shrink-0"
              />
              <span className="min-w-0 truncate">{project.name}</span>
            </button>
          ))}
        {busy ? (
          <p role="status" className="py-4 text-center text-sm text-muted-foreground">
            正在加载项目…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="py-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {next || error ? (
          <Button
            variant="ghost"
            className="w-full rounded-xl"
            disabled={busy}
            onClick={() =>
              void run(async (guard) => {
                const page = await client.listProjects(next);
                guard();
                setItems((previous) => [
                  ...new Map([...previous, ...page.items].map((item) => [item.id, item])).values(),
                ]);
                setNext(page.next_before_id);
              })
            }
          >
            {error ? "重新加载" : "查看更多项目"}
          </Button>
        ) : null}
        {!busy && !error && items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">还没有项目</p>
        ) : null}
      </div>
    </>
  );
}

function ProjectSettings(
  props: Props & {
    projectId: string;
    onDirtyChange: (dirty: boolean) => void;
    onBusyChange: (busy: boolean) => void;
    onCloseRequest: (afterClose?: () => void) => void;
  },
) {
  const [project, setProject] = useState<CloudProject | null>(null);
  const [draft, setDraft] = useState<CloudProjectDraft | null>(null);
  const [tab, setTab] = useState<"settings" | "files">("settings");
  const [files, setFiles] = useState<CloudChatFile[]>([]);
  const [filesReady, setFilesReady] = useState(false);
  const [filesNext, setFilesNext] = useState("");
  const [library, setLibrary] = useState<CloudChatFile[]>([]);
  const [libraryNext, setLibraryNext] = useState("");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState(false);
  const formId = useId();
  const { busy, error, run } = useCloudWorkPanel(props.captureGuard, props.projectId);
  const { client, projectId, onDirtyChange, onBusyChange } = props;
  const dirty = !!draft && !!project && JSON.stringify(draft) !== JSON.stringify(toDraft(project));
  useEffect(() => {
    if (!deleting) return;
    const back = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (!busy) setDeleting(false);
    };
    window.addEventListener(MOBILE_BACK_EVENT, back, true);
    return () => window.removeEventListener(MOBILE_BACK_EVENT, back, true);
  }, [deleting, busy]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    void run(async (guard) => {
      const current = await client.getProject(projectId);
      guard();
      setProject(current);
      setDraft(toDraft(current));
    });
  }, [client, projectId, run]);
  function change(value: Partial<CloudProjectDraft>) {
    setDraft((current) => (current ? { ...current, ...value } : current));
  }
  function loadFiles() {
    setTab("files");
    if (filesReady) return;
    void run(async (guard) => {
      const page = await client.listFiles(projectId);
      guard();
      setFiles(page.items);
      setFilesNext(page.next_before_id);
      setFilesReady(true);
    });
  }
  async function setFile(file: CloudChatFile, attached: boolean, guard: () => void) {
    if (!project) return;
    const current = await client.setFile(project, file.id, attached);
    guard();
    setProject(current);
    setFiles((previous) =>
      attached
        ? [...previous.filter((item) => item.id !== file.id), file]
        : previous.filter((item) => item.id !== file.id),
    );
    setAdding(false);
    props.onChanged();
  }
  return (
    <>
      <fieldset className="cloud-project-settings-tabs" aria-label="项目设置内容">
        <Button
          variant="ghost"
          className="rounded-full aria-pressed:bg-accent"
          aria-pressed={tab === "settings"}
          onClick={() => setTab("settings")}
        >
          设置
        </Button>
        <Button
          variant="ghost"
          className="rounded-full aria-pressed:bg-accent"
          aria-pressed={tab === "files"}
          onClick={loadFiles}
        >
          项目资料
        </Button>
      </fieldset>
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-destructive/5 p-3 text-sm text-destructive"
        >
          <span className="flex-1">{error}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="重新读取项目"
            disabled={busy}
            onClick={() =>
              void run(async (guard) => {
                const current = await client.getProject(projectId);
                guard();
                setProject(current);
                if (!draft) setDraft(toDraft(current));
              })
            }
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      ) : null}
      {!draft || !project ? (
        <p role="status" className="py-10 text-center text-sm text-muted-foreground">
          {error ? "请重新读取项目" : "正在加载项目设置…"}
        </p>
      ) : (
        <>
          {tab === "settings" ? (
            <form
              id={formId}
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async (guard) => {
                  const current = await client.updateProject(project, draft);
                  guard();
                  setProject(current);
                  setDraft(toDraft(current));
                  props.onChanged();
                  onDirtyChange(false);
                  props.onClose();
                });
              }}
            >
              <div className="space-y-2">
                <label htmlFor={`${formId}-name`} className="text-sm font-medium">
                  项目名称
                </label>
                <div className="flex overflow-hidden rounded-xl border border-input focus-within:ring-2 focus-within:ring-ring/40">
                  <CloudProjectIconPicker
                    icon={draft.icon || "folder"}
                    color={draft.color || "default"}
                    disabled={busy}
                    onChange={change}
                  />
                  <Input
                    id={`${formId}-name`}
                    aria-label="项目名称"
                    className="h-12 min-w-0 rounded-none border-0 shadow-none focus-visible:ring-0"
                    maxLength={200}
                    disabled={busy}
                    value={draft.name}
                    onChange={(event) => change({ name: event.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor={`${formId}-description`} className="text-sm font-medium">
                  项目说明 <span className="font-normal text-muted-foreground">（可选）</span>
                </label>
                <Input
                  id={`${formId}-description`}
                  aria-label="项目说明"
                  value={draft.description}
                  disabled={busy}
                  maxLength={4096}
                  className="h-11 rounded-xl"
                  placeholder="记录项目目标和背景"
                  onChange={(event) => change({ description: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor={`${formId}-instructions`} className="text-sm font-medium">
                  项目指令
                </label>
                <p
                  id={`${formId}-instructions-hint`}
                  className="text-sm leading-relaxed text-muted-foreground"
                >
                  设置上下文，并自定义 ZeroAgent 在此项目中的回复方式。
                </p>
                <Textarea
                  id={`${formId}-instructions`}
                  aria-label="项目指令"
                  aria-describedby={`${formId}-instructions-hint`}
                  value={draft.instructions}
                  disabled={busy}
                  maxLength={16384}
                  className="min-h-28 resize-y rounded-xl p-3"
                  placeholder="例如：使用中文回复。先给结论，再说明依据；保持简洁。"
                  onChange={(event) => change({ instructions: event.target.value })}
                />
              </div>
            </form>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">此项目可使用的资料</p>
                <Button
                  variant="outline"
                  className="rounded-full"
                  disabled={busy}
                  onClick={() => {
                    setAdding(true);
                    void run(async (guard) => {
                      const page = await props.filesClient.list();
                      guard();
                      setLibrary(page.files);
                      setLibraryNext(page.nextCursor);
                    });
                  }}
                >
                  <Plus className="size-4" />
                  添加资料
                </Button>
              </div>
              {adding ? (
                <div className="rounded-2xl border p-3">
                  <div className="mb-2 flex gap-2">
                    <Input
                      aria-label="搜索已加载资料"
                      placeholder="搜索资料库"
                      className="rounded-xl"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="关闭资料选择"
                      onClick={() => setAdding(false)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                  <div className="max-h-48 overflow-auto">
                    {library
                      .filter(
                        (file) =>
                          file.state === "ready" &&
                          !files.some((item) => item.id === file.id) &&
                          file.name.toLowerCase().includes(search.trim().toLowerCase()),
                      )
                      .map((file) => (
                        <button
                          type="button"
                          key={file.id}
                          disabled={busy}
                          className="cloud-project-catalog-row"
                          onClick={() => void run((guard) => setFile(file, true, guard))}
                        >
                          <FileText className="size-4 shrink-0" />
                          <span className="truncate">{file.name}</span>
                        </button>
                      ))}
                    {libraryNext ? (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(async (guard) => {
                            const page = await props.filesClient.list({ before: libraryNext });
                            guard();
                            setLibrary((previous) => [...previous, ...page.files]);
                            setLibraryNext(page.nextCursor);
                          })
                        }
                      >
                        查看更多资料
                      </Button>
                    ) : null}
                    {!busy &&
                    !library.some(
                      (file) =>
                        file.state === "ready" && !files.some((item) => item.id === file.id),
                    ) ? (
                      <p className="p-4 text-sm text-muted-foreground">
                        暂无可添加的资料，可先到资料空间上传。
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="max-h-[35dvh] space-y-1 overflow-auto">
                {files.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center gap-2 rounded-xl px-2 py-1 hover:bg-accent/50"
                  >
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate py-2 text-left text-sm"
                      disabled={busy}
                      onClick={() => {
                        props.onCloseRequest(() => props.onPreviewFile(file.id));
                      }}
                    >
                      {file.name}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`解除关联：${file.name}`}
                      disabled={busy}
                      onClick={() => void run((guard) => setFile(file, false, guard))}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
                {filesReady && !files.length ? (
                  <p className="rounded-2xl bg-muted/40 px-4 py-8 text-center text-sm text-muted-foreground">
                    添加参考资料，让项目中的对话更了解你的工作。
                  </p>
                ) : null}
                {filesNext ? (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async (guard) => {
                        const page = await client.listFiles(projectId, filesNext);
                        guard();
                        setFiles((previous) => [...previous, ...page.items]);
                        setFilesNext(page.next_before_id);
                      })
                    }
                  >
                    查看更多项目资料
                  </Button>
                ) : null}
              </div>
              {busy ? (
                <p role="status" className="text-sm text-muted-foreground">
                  正在更新资料…
                </p>
              ) : null}
            </div>
          )}
          <DialogFooter className="flex-row items-center justify-between gap-2 border-t px-0 pb-0 pt-4 max-[820px]:flex-row max-[820px]:items-center max-[820px]:px-0 max-[820px]:pb-0">
            <Button
              variant="ghost"
              className="mr-auto rounded-full bg-destructive/5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              <Trash2 className="size-4" />
              删除项目
            </Button>
            <Button
              variant="ghost"
              className="rounded-full"
              disabled={busy}
              onClick={() => props.onCloseRequest()}
            >
              关闭
            </Button>
            {dirty ? (
              <Button
                type={tab === "settings" ? "submit" : "button"}
                form={tab === "settings" ? formId : undefined}
                className="rounded-full px-5"
                disabled={busy || !draft.name.trim()}
                onClick={
                  tab === "files"
                    ? () => {
                        void run(async (guard) => {
                          const current = await client.updateProject(project, draft);
                          guard();
                          setProject(current);
                          setDraft(toDraft(current));
                          props.onChanged();
                          onDirtyChange(false);
                          props.onClose();
                        });
                      }
                    : undefined
                }
              >
                {busy ? "正在保存…" : "保存"}
              </Button>
            ) : null}
          </DialogFooter>
          <AlertDialog
            open={deleting}
            onOpenChange={(open) => {
              if (!busy) setDeleting(open);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>删除“{project.name}”？</AlertDialogTitle>
                <AlertDialogDescription>
                  项目指令和资料关联将被移除。对话会保留在最近列表，资料原件仍保存在资料空间。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <Button variant="ghost" disabled={busy} onClick={() => setDeleting(false)}>
                  取消
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    void run(async (guard) => {
                      await client.removeProject(project);
                      guard();
                      props.onChanged();
                      onDirtyChange(false);
                      props.onClose();
                    })
                  }
                >
                  {busy ? "正在删除…" : "确认删除项目"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </>
  );
}

export function CloudProjectSettingsDialog(props: Props) {
  const [dirty, setDirty] = useState(false);
  const { onDirtyChange } = props;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const afterCloseRef = useRef<(() => void) | undefined>(undefined);
  function requestClose(afterClose?: () => void) {
    if (busy) return;
    afterCloseRef.current = afterClose;
    if (dirty) setDiscard(true);
    else {
      props.onClose();
      afterClose?.();
    }
  }
  useEffect(() => {
    const back = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (discard) setDiscard(false);
      else requestClose();
    };
    window.addEventListener(MOBILE_BACK_EVENT, back);
    return () => window.removeEventListener(MOBILE_BACK_EVENT, back);
  });
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <DialogContent
          showCloseButton
          closeDisabled={busy}
          closeLabel="关闭项目设置"
          className="cloud-project-settings-dialog max-w-xl rounded-3xl p-6"
        >
          <DialogHeader>
            <DialogTitle className="text-xl">{props.projectId ? "项目设置" : "项目"}</DialogTitle>
            <DialogDescription className="sr-only">
              编辑项目的名称、外观、上下文与参考资料。
            </DialogDescription>
          </DialogHeader>
          {props.projectId ? (
            <ProjectSettings
              {...props}
              projectId={props.projectId}
              onDirtyChange={setDirty}
              onBusyChange={setBusy}
              onCloseRequest={requestClose}
            />
          ) : (
            <ProjectCatalog {...props} />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={discard} onOpenChange={setDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle>
            <AlertDialogDescription>
              项目设置还没有保存，当前对话和草稿不会受到影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setDiscard(false)}>
              继续编辑
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                props.onClose();
                afterCloseRef.current?.();
              }}
            >
              放弃修改并关闭
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
