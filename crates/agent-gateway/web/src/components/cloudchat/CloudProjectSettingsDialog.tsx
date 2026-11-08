import { FileText, Plus, Search, Trash2, X } from "@liveagent/ui/components/IconSet";
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
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { useLocale } from "@liveagent/ui/i18n";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CloudChatFilePanel } from "@/components/CloudChatFilePanel";
import type { CloudChatFile, CloudChatFilesClient } from "@/lib/cloudChatFiles";
import {
  type CloudAccountGuard,
  type CloudChatProjectsClient,
  type CloudProject,
  type CloudProjectDraft,
  CloudWorkError,
} from "@/lib/cloudChatProjects";
import { MOBILE_BACK_EVENT } from "@/lib/mobileRuntime";
import { CloudChatFeedback } from "./CloudChatFeedback";
import { CloudChatResourcePresentation } from "./CloudChatReaderContext";
import {
  CloudProjectIcon,
  CloudProjectIconPicker,
  projectAppearanceLabel,
} from "./CloudProjectIcon";
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
};
type ProjectFields = Required<CloudProjectDraft>;
const fields = ["name", "description", "instructions", "icon", "color"] as const;
type ProjectField = (typeof fields)[number];
type ProjectRead = { kind: "project" } | { kind: "files" | "library"; before: string };
type ProjectWrite = "settings" | "files" | "delete";
type GuardedProjectAction = (guard: () => void) => Promise<void>;

function useProjectCopy() {
  const { locale } = useLocale();
  return (zh: string, en: string) => (locale === "en-US" ? en : zh);
}

const toDraft = (project: CloudProject): ProjectFields => ({
  name: project.name,
  description: project.description,
  instructions: project.instructions,
  icon: project.icon || "folder",
  color: project.color || "default",
});

function reconcileDraft(base: ProjectFields, saved: ProjectFields, local: ProjectFields) {
  const draft = { ...saved };
  const conflicts: ProjectField[] = [];
  for (const field of fields) {
    if (local[field] === base[field]) continue;
    draft[field] = local[field];
    if (saved[field] !== base[field] && saved[field] !== local[field]) conflicts.push(field);
  }
  return { draft, conflicts };
}

function ProjectCatalog(props: Props) {
  const copy = useProjectCopy();
  const [items, setItems] = useState<CloudProject[]>([]);
  const [next, setNext] = useState("");
  const [search, setSearch] = useState("");
  const { busy, error, run } = useCloudWorkPanel(props.captureGuard);
  const { client } = props;
  const matches = items.filter((item) =>
    item.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
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
          aria-label={copy("搜索已加载项目", "Search loaded projects")}
          placeholder={copy("搜索项目", "Search projects")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-10 rounded-xl pl-9"
        />
      </div>
      <div className="max-h-[50dvh] space-y-1 overflow-auto" aria-busy={busy}>
        <button type="button" className="cloud-project-catalog-row" onClick={props.onCreate}>
          <Plus className="size-5" />
          <span>{copy("新建项目", "New project")}</span>
        </button>
        {matches.map((project) => (
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
            {copy("正在加载项目…", "Loading projects…")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="py-3 text-sm text-destructive">
            {copy("暂时无法加载项目。", "Could not load projects.")}
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
                setItems((previous) =>
                  next
                    ? [
                        ...new Map(
                          [...previous, ...page.items].map((item) => [item.id, item]),
                        ).values(),
                      ]
                    : page.items,
                );
                setNext(page.next_before_id);
              })
            }
          >
            {error ? copy("重新加载", "Retry") : copy("查看更多项目", "Show more projects")}
          </Button>
        ) : null}
        {!busy && !error && matches.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {items.length
              ? copy("已加载的项目中没有匹配项", "No matches in loaded projects")
              : copy("还没有项目", "No projects yet")}
          </p>
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
    onCloseRequest: () => void;
    onPreviewFile: (file: CloudChatFile, trigger: HTMLButtonElement) => void;
  },
) {
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "en-US" ? en : zh);
  const [project, setProject] = useState<CloudProject | null>(null);
  const [draft, setDraft] = useState<ProjectFields | null>(null);
  const [verifyWrite, setVerifyWrite] = useState<{ kind: ProjectWrite; conflict: boolean } | null>(
    null,
  );
  const [failedRead, setFailedRead] = useState<ProjectRead | null>(null);
  const [conflicts, setConflicts] = useState<ProjectField[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const reviewHeading = useRef<HTMLHeadingElement | null>(null);
  const verifyButton = useRef<HTMLButtonElement | null>(null);
  const [tab, setTab] = useState<"settings" | "files">("settings");
  const [files, setFiles] = useState<CloudChatFile[]>([]);
  const [filesReady, setFilesReady] = useState(false);
  const [filesNext, setFilesNext] = useState("");
  const [library, setLibrary] = useState<CloudChatFile[]>([]);
  const [libraryReady, setLibraryReady] = useState(false);
  const [libraryNext, setLibraryNext] = useState("");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState(false);
  const matchingFiles = library.filter(
    (file) =>
      file.state === "ready" &&
      !files.some((item) => item.id === file.id) &&
      file.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const formId = useId();
  const { busy, error, run } = useCloudWorkPanel(props.captureGuard, props.projectId);
  const { client, projectId, onDirtyChange, onBusyChange } = props;
  const saved = project ? toDraft(project) : null;
  const dirty = !!draft && !!saved && fields.some((field) => draft[field] !== saved[field]);
  const writeBlocked = busy || Boolean(verifyWrite) || conflicts.length > 0;
  const runRead = useCallback(
    (request: ProjectRead, action: GuardedProjectAction) =>
      void run(async (guard) => {
        setFailedRead(null);
        try {
          await action(guard);
        } catch (cause) {
          guard();
          setFailedRead(request);
          throw cause;
        }
      }),
    [run],
  );
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
    runRead({ kind: "project" }, async (guard) => {
      const current = await client.getProject(projectId);
      guard();
      setProject(current);
      setDraft(toDraft(current));
    });
  }, [client, projectId, runRead]);
  useEffect(() => {
    if (reviewed) reviewHeading.current?.focus({ preventScroll: false });
  }, [reviewed]);
  useEffect(() => {
    if (verifyWrite && !busy && !failedRead) verifyButton.current?.focus();
  }, [verifyWrite, busy, failedRead]);
  function change(value: Partial<ProjectFields>) {
    setDraft((current) => (current ? { ...current, ...value } : current));
  }
  function loadFiles(before = "") {
    runRead({ kind: "files", before }, async (guard) => {
      const page = await client.listFiles(projectId, before);
      guard();
      setFiles((previous) =>
        before
          ? [...new Map([...previous, ...page.items].map((item) => [item.id, item])).values()]
          : page.items,
      );
      setFilesNext(page.next_before_id);
      setFilesReady(true);
    });
  }
  function loadLibrary(before = "") {
    runRead({ kind: "library", before }, async (guard) => {
      const page = await props.filesClient.list({ before });
      guard();
      setLibrary((previous) =>
        before
          ? [...new Map([...previous, ...page.files].map((item) => [item.id, item])).values()]
          : page.files,
      );
      setLibraryNext(page.nextCursor);
      setLibraryReady(true);
    });
  }
  function readCurrentProject() {
    runRead({ kind: "project" }, async (guard) => {
      const [current, filePage] = await Promise.all([
        client.getProject(projectId),
        verifyWrite?.kind === "files" ? client.listFiles(projectId) : Promise.resolve(null),
      ]);
      guard();
      const latest = toDraft(current);
      if (saved && draft) {
        const next = reconcileDraft(saved, latest, draft);
        setDraft(next.draft);
        setConflicts(next.conflicts);
        if (next.conflicts.length > 0) setTab("settings");
        setReviewed(true);
      } else {
        setDraft(latest);
      }
      setProject(current);
      if (filePage) {
        setFiles(filePage.items);
        setFilesNext(filePage.next_before_id);
        setFilesReady(true);
      }
      setVerifyWrite(null);
      if (verifyWrite) props.onChanged();
    });
  }
  function write(kind: ProjectWrite, action: GuardedProjectAction) {
    if (writeBlocked) return;
    void run(async (guard) => {
      setFailedRead(null);
      setReviewed(false);
      try {
        await action(guard);
      } catch (cause) {
        guard();
        if (
          cause instanceof CloudWorkError &&
          cause.status !== 409 &&
          cause.status !== 408 &&
          cause.status < 500
        ) {
          throw cause;
        }
        setVerifyWrite({ kind, conflict: cause instanceof CloudWorkError && cause.status === 409 });
        setDeleting(false);
      }
    });
  }
  function save() {
    if (!project || !draft || !dirty || !draft.name.trim()) return;
    write("settings", async (guard) => {
      const current = await client.updateProject(project, draft);
      guard();
      setProject(current);
      setDraft(toDraft(current));
      props.onChanged();
      onDirtyChange(false);
      props.onClose();
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
  const fieldNames: Record<ProjectField, string> = {
    name: copy("项目名称", "Project name"),
    description: copy("项目说明", "Project description"),
    instructions: copy("项目指令", "Project instructions"),
    icon: copy("项目图标", "Project icon"),
    color: copy("项目颜色", "Project color"),
  };
  const retryRead =
    failedRead?.kind === "files"
      ? {
          label: copy("重试加载项目资料", "Retry loading project files"),
          run: () => loadFiles(failedRead.before),
        }
      : failedRead?.kind === "library"
        ? {
            label: copy("重试加载资料库", "Retry loading library"),
            run: () => loadLibrary(failedRead.before),
          }
        : failedRead || verifyWrite
          ? { label: copy("重新读取项目", "Read current project"), run: readCurrentProject }
          : null;
  let notice = error;
  if (failedRead?.kind === "files") {
    notice = copy(
      "暂时无法读取项目资料。已加载的资料仍保留。",
      "Could not load project files. Previously loaded files are still shown.",
    );
  } else if (failedRead?.kind === "library") {
    notice = copy(
      "暂时无法读取资料库。已加载的资料仍保留。",
      "Could not load the library. Previously loaded files are still shown.",
    );
  } else if (failedRead?.kind === "project") {
    notice = copy(
      "暂时无法读取当前项目，已有草稿仍保留。",
      "Could not load the current project. Existing edits are kept.",
    );
  } else if (verifyWrite?.conflict) {
    notice = copy(
      "项目已在其他位置更新。读取当前内容后可继续处理你的修改。",
      "This project changed elsewhere. Read the current values to continue with your edits.",
    );
  } else if (verifyWrite) {
    notice = copy(
      "修改尚未确认。请读取当前项目后再继续。",
      "Your change hasn't been confirmed. Read the current project before continuing.",
    );
  }
  function showFieldValue(field: ProjectField, value: ProjectFields) {
    if (field === "icon" || field === "color") {
      return (
        <span className="inline-flex items-center gap-2">
          <CloudProjectIcon
            icon={field === "icon" ? value.icon : "folder"}
            color={field === "color" ? value.color : "default"}
          />
          {projectAppearanceLabel(field, value[field], locale)}
        </span>
      );
    }
    return value[field] || copy("空白", "Blank");
  }
  function resolveConflict(field: ProjectField, keepLocal: boolean) {
    if (!saved || busy) return;
    if (!keepLocal) change({ [field]: saved[field] });
    setConflicts((current) => current.filter((item) => item !== field));
    reviewHeading.current?.focus();
  }
  return (
    <>
      <DialogBody className="cloud-project-settings-body space-y-5">
        <fieldset
          className="cloud-project-settings-tabs"
          aria-label={copy("项目设置内容", "Project settings sections")}
        >
          <Button
            variant="ghost"
            className="rounded-full aria-pressed:bg-accent"
            aria-pressed={tab === "settings"}
            disabled={busy}
            onClick={() => setTab("settings")}
          >
            {copy("设置", "Settings")}
          </Button>
          <Button
            variant="ghost"
            className="rounded-full aria-pressed:bg-accent"
            aria-pressed={tab === "files"}
            disabled={busy}
            onClick={() => {
              setTab("files");
              if (!filesReady && project) loadFiles();
            }}
          >
            {copy("项目资料", "Project files")}
          </Button>
        </fieldset>
        {notice ? (
          <CloudChatFeedback
            tone={verifyWrite ? "warning" : "error"}
            message={notice}
            actions={
              retryRead && (
                <button
                  ref={verifyWrite && !failedRead ? verifyButton : undefined}
                  type="button"
                  className="app-status-action"
                  disabled={busy}
                  onClick={retryRead.run}
                >
                  {retryRead.label}
                </button>
              )
            }
          />
        ) : null}
        {reviewed && saved && draft ? (
          <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
            <h3 ref={reviewHeading} tabIndex={-1} className="text-sm font-medium">
              {conflicts.length > 0
                ? copy("核对双方修改的字段", "Review fields changed in both places")
                : copy("已读取当前项目", "Current project loaded")}
            </h3>
            {conflicts.length > 0 ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                {copy(
                  "为每个字段选择要保留的值，再保存。",
                  "Choose a value for each field, then save.",
                )}
              </p>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {dirty
                  ? copy(
                      "你的修改已保留，可以继续编辑或保存。",
                      "Your edits are kept. You can keep editing or save.",
                    )
                  : copy("当前内容已经保存。", "The current values are already saved.")}
              </p>
            )}
            {conflicts.map((field) => (
              <fieldset key={field} className="min-w-0 space-y-2 border-t pt-2">
                <legend className="pr-2 text-sm font-medium">{fieldNames[field]}</legend>
                <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      {copy("当前保存", "Currently saved")}
                    </dt>
                    <dd className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words">
                      {showFieldValue(field, saved)}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{copy("我的修改", "My edit")}</dt>
                    <dd className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words">
                      {showFieldValue(field, draft)}
                    </dd>
                  </div>
                </dl>
                <div className="grid grid-cols-2 justify-items-start gap-2">
                  <Button
                    variant="outline"
                    className="h-auto min-h-9 whitespace-normal rounded-full max-[820px]:min-h-11"
                    disabled={busy}
                    onClick={() => resolveConflict(field, false)}
                  >
                    {copy("使用当前值", "Use saved value")}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-auto min-h-9 whitespace-normal rounded-full max-[820px]:min-h-11"
                    disabled={busy}
                    onClick={() => resolveConflict(field, true)}
                  >
                    {copy("保留我的修改", "Keep my edit")}
                  </Button>
                </div>
              </fieldset>
            ))}
          </div>
        ) : null}
        {!draft || !project ? (
          <p role="status" className="py-10 text-center text-sm text-muted-foreground">
            {busy ? copy("正在加载项目设置…", "Loading project settings…") : null}
          </p>
        ) : (
          <>
            {tab === "settings" ? (
              <form
                id={formId}
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  save();
                }}
              >
                <div className="space-y-2">
                  <label htmlFor={`${formId}-name`} className="text-sm font-medium">
                    {fieldNames.name}
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
                      aria-label={fieldNames.name}
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
                    {fieldNames.description}{" "}
                    <span className="font-normal text-muted-foreground">
                      {copy("（可选）", "(optional)")}
                    </span>
                  </label>
                  <Input
                    id={`${formId}-description`}
                    aria-label={fieldNames.description}
                    value={draft.description}
                    disabled={busy}
                    maxLength={4096}
                    className="h-11 rounded-xl"
                    placeholder={copy(
                      "记录项目目标和背景",
                      "Add the project's goals and background",
                    )}
                    onChange={(event) => change({ description: event.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor={`${formId}-instructions`} className="text-sm font-medium">
                    {fieldNames.instructions}
                  </label>
                  <p
                    id={`${formId}-instructions-hint`}
                    className="text-sm leading-relaxed text-muted-foreground"
                  >
                    {copy(
                      "设置上下文，并自定义 ZeroAgent 在此项目中的回复方式。",
                      "Add context and customize how ZeroAgent responds in this project.",
                    )}
                  </p>
                  <Textarea
                    id={`${formId}-instructions`}
                    aria-label={fieldNames.instructions}
                    aria-describedby={`${formId}-instructions-hint`}
                    value={draft.instructions}
                    disabled={busy}
                    maxLength={16384}
                    className="min-h-28 resize-y rounded-xl p-3"
                    placeholder={copy(
                      "先给结论，再简要说明依据。",
                      "Start with the conclusion, then briefly explain your reasoning.",
                    )}
                    onChange={(event) => change({ instructions: event.target.value })}
                  />
                </div>
              </form>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">
                    {copy("此项目可使用的资料", "Files available in this project")}
                  </p>
                  <Button
                    variant="outline"
                    className="rounded-full"
                    disabled={busy}
                    onClick={() => {
                      setAdding(true);
                      loadLibrary();
                    }}
                  >
                    <Plus className="size-4" />
                    {copy("添加资料", "Add files")}
                  </Button>
                </div>
                {adding ? (
                  <div className="rounded-2xl border p-3">
                    <div className="mb-2 flex gap-2">
                      <Input
                        aria-label={copy("搜索已加载资料", "Search loaded files")}
                        placeholder={copy("搜索资料库", "Search library")}
                        className="rounded-xl"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={copy("关闭资料选择", "Close file picker")}
                        onClick={() => setAdding(false)}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                    <div className="max-h-48 overflow-auto">
                      {matchingFiles.map((file) => (
                        <button
                          type="button"
                          key={file.id}
                          disabled={writeBlocked}
                          className="cloud-project-catalog-row"
                          onClick={() => write("files", (guard) => setFile(file, true, guard))}
                        >
                          <FileText className="size-4 shrink-0" />
                          <span className="truncate">{file.name}</span>
                        </button>
                      ))}
                      {libraryNext && failedRead?.kind !== "library" ? (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => loadLibrary(libraryNext)}
                        >
                          {copy("查看更多资料", "Load more library files")}
                        </Button>
                      ) : null}
                      {libraryReady &&
                      !busy &&
                      failedRead?.kind !== "library" &&
                      !matchingFiles.length ? (
                        <p className="p-4 text-sm text-muted-foreground">
                          {search.trim()
                            ? copy("已加载的资料中没有匹配项", "No matches in loaded files")
                            : libraryNext
                              ? copy(
                                  "加载更多资料以查看其他选项。",
                                  "Load more files to see other options.",
                                )
                              : copy(
                                  "暂无可添加的资料，可先到资料空间上传。",
                                  "No files to add. You can upload files in the library.",
                                )}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <div
                  data-project-reference-list=""
                  className="max-h-[35dvh] space-y-1 overflow-auto"
                >
                  {files.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center gap-2 rounded-xl px-2 py-1 hover:bg-accent/50"
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate py-2 text-left text-sm max-[820px]:min-h-11"
                        title={file.name}
                        disabled={busy}
                        onClick={(event) => props.onPreviewFile(file, event.currentTarget)}
                      >
                        {file.name}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={copy(
                          `解除关联：${file.name}`,
                          `Remove ${file.name} from project`,
                        )}
                        disabled={writeBlocked}
                        onClick={() => write("files", (guard) => setFile(file, false, guard))}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}
                  {filesReady && !files.length && failedRead?.kind !== "files" ? (
                    <p className="rounded-2xl bg-muted/40 px-4 py-8 text-center text-sm text-muted-foreground">
                      {copy(
                        "添加参考资料，让项目中的对话更了解你的工作。",
                        "Add reference files to give conversations in this project more context.",
                      )}
                    </p>
                  ) : null}
                  {filesNext && failedRead?.kind !== "files" ? (
                    <Button variant="ghost" disabled={busy} onClick={() => loadFiles(filesNext)}>
                      {copy("查看更多项目资料", "Load more project files")}
                    </Button>
                  ) : null}
                </div>
                {busy ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {copy("正在更新资料…", "Updating files…")}
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}
      </DialogBody>
      {draft && project ? (
        <>
          <DialogFooter className="flex-row items-center justify-between gap-2 border-t px-0 pb-0 pt-4 max-[820px]:flex-row max-[820px]:items-center max-[820px]:px-0 max-[820px]:pb-0">
            <Button
              variant="ghost"
              className="mr-auto rounded-full bg-destructive/5 text-destructive hover:bg-destructive/10 hover:text-destructive max-[820px]:min-h-11"
              disabled={writeBlocked}
              onClick={() => setDeleting(true)}
            >
              <Trash2 className="size-4" />
              {copy("删除项目", "Delete project")}
            </Button>
            <Button
              variant="ghost"
              className="rounded-full max-[820px]:min-h-11"
              disabled={busy}
              onClick={() => props.onCloseRequest()}
            >
              {copy("关闭", "Close")}
            </Button>
            {dirty ? (
              <Button
                type={tab === "settings" ? "submit" : "button"}
                form={tab === "settings" ? formId : undefined}
                className="rounded-full px-5 max-[820px]:min-h-11"
                disabled={writeBlocked || !draft.name.trim()}
                onClick={tab === "files" ? save : undefined}
              >
                {busy ? copy("正在处理…", "Working…") : copy("保存", "Save")}
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
                <AlertDialogTitle>
                  {copy(`删除“${project.name}”？`, `Delete “${project.name}”?`)}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {copy(
                    "项目指令和资料关联将被移除。对话会保留在最近列表，资料原件仍保存在资料空间。",
                    "Project instructions and file associations will be removed. Conversations stay in your recent list and the original files stay in your library.",
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <Button variant="ghost" disabled={busy} onClick={() => setDeleting(false)}>
                  {copy("取消", "Cancel")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={writeBlocked}
                  onClick={() =>
                    write("delete", async (guard) => {
                      await client.removeProject(project);
                      guard();
                      props.onChanged();
                      onDirtyChange(false);
                      props.onClose();
                    })
                  }
                >
                  {busy ? copy("正在删除…", "Deleting…") : copy("确认删除项目", "Confirm deletion")}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </>
  );
}

export function CloudProjectSettingsDialog(props: Props) {
  const copy = useProjectCopy();
  const [dirty, setDirty] = useState(false);
  const { onDirtyChange } = props;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [preview, setPreview] = useState<CloudChatFile | null>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const previewOrigin = useRef<{
    trigger: HTMLButtonElement;
    scroll: { element: HTMLElement; top: number }[];
  } | null>(null);
  const dialogTitle = useRef<HTMLHeadingElement | null>(null);
  useLayoutEffect(() => {
    if (preview || !previewOrigin.current) return;
    const { trigger, scroll } = previewOrigin.current;
    previewOrigin.current = null;
    for (const { element, top } of scroll) element.scrollTop = top;
    (trigger.isConnected ? trigger : dialogTitle.current)?.focus({ preventScroll: true });
  }, [preview]);
  function requestClose() {
    if (preview) {
      setPreview(null);
      return;
    }
    if (busy) return;
    if (dirty) setDiscard(true);
    else props.onClose();
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
          showCloseButton={!preview}
          closeDisabled={busy}
          layout={preview ? "fullscreen-mobile" : "center"}
          closeLabel={
            props.projectId
              ? copy("关闭项目设置", "Close project settings")
              : copy("关闭项目列表", "Close project list")
          }
          className={
            preview
              ? "cloud-project-file-reader max-w-5xl overflow-hidden"
              : "cloud-project-settings-dialog max-w-xl rounded-3xl p-6"
          }
        >
          {preview ? (
            <>
              <DialogTitle className="sr-only">{preview.name}</DialogTitle>
              <DialogDescription className="sr-only">
                {copy("预览项目参考资料。", "Preview a project reference file.")}
              </DialogDescription>
            </>
          ) : (
            <DialogHeader>
              <DialogTitle ref={dialogTitle} tabIndex={-1} className="text-xl">
                {props.projectId ? copy("项目设置", "Project settings") : copy("项目", "Projects")}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {props.projectId
                  ? copy(
                      "编辑项目的名称、外观、上下文与参考资料。",
                      "Edit the project name, appearance, context, and reference files.",
                    )
                  : copy("打开或创建项目。", "Open or create a project.")}
              </DialogDescription>
            </DialogHeader>
          )}
          {props.projectId ? (
            <div className={preview ? "hidden" : "cloud-project-settings-content contents"}>
              <ProjectSettings
                {...props}
                projectId={props.projectId}
                onDirtyChange={setDirty}
                onBusyChange={setBusy}
                onCloseRequest={requestClose}
                onPreviewFile={(file, trigger) => {
                  previewOrigin.current = {
                    trigger,
                    scroll: [
                      trigger.closest<HTMLElement>(".cloud-project-settings-body"),
                      trigger.closest<HTMLElement>("[data-project-reference-list]"),
                    ].flatMap((element) => (element ? [{ element, top: element.scrollTop }] : [])),
                  };
                  setPreview(file);
                }}
              />
            </div>
          ) : (
            <ProjectCatalog {...props} />
          )}
          {preview ? (
            <CloudChatResourcePresentation.Provider value="inline">
              <CloudChatFilePanel
                key={preview.id}
                client={props.filesClient}
                initialFileId={preview.id}
                backLabel={copy("返回项目资料", "Back to project files")}
                canAttach={false}
                isCurrent={() => previewRef.current === preview}
                onClose={() => setPreview(null)}
              />
            </CloudChatResourcePresentation.Provider>
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog open={discard} onOpenChange={setDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {copy("放弃未保存的修改？", "Discard unsaved changes?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {copy(
                "放弃这次项目设置的修改，返回当前对话。",
                "Discard these project settings edits and return to your conversation.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setDiscard(false)}>
              {copy("继续编辑", "Continue editing")}
            </Button>
            <Button variant="destructive" onClick={props.onClose}>
              {copy("放弃修改并关闭", "Discard and close")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
