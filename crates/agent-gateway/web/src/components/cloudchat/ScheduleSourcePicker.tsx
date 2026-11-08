import { FileText, ImageIcon, X } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Checkbox } from "@liveagent/ui/components/ui/checkbox";
import { Input } from "@liveagent/ui/components/ui/input";
import { StatusNotice } from "@liveagent/ui/components/ui/status-notice";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  CloudChatArtifactError,
  type CloudChatArtifactsClient,
} from "../../lib/cloudChatArtifacts";
import { CloudChatFileError, type CloudChatFilesClient } from "../../lib/cloudChatFiles";
import { SCHEDULE_CONTENT_PART_LIMIT, type ScheduleContent } from "../../lib/cloudSchedules";
import { type CloudSpaceClient, CloudSpaceError, type CloudSpaceItem } from "../../lib/cloudSpace";

type ContentParts = Exclude<ScheduleContent, string>;
type Source = Exclude<ContentParts[number], { type: "text" }>;
type LibrarySource = Exclude<Source, { type: "image_url" }>;
type Text = (zh: string, en: string) => string;
export type ScheduleSourceMetadata = {
  files?: Pick<CloudChatFilesClient, "get">;
  artifacts?: Pick<CloudChatArtifactsClient, "get">;
};

const maximumReferences = 8;
const touchAction = "min-h-11 md:min-h-8";
const recentLibrary = { category: "recent", scope: "all", folder: "" } as const;

function libraryKey(source: LibrarySource) {
  return source.type === "file_reference"
    ? `file:${source.file_id}`
    : `artifact:${source.version_id}`;
}

function librarySource(item: CloudSpaceItem): LibrarySource {
  return item.kind === "file"
    ? { type: "file_reference", file_id: item.target_id }
    : { type: "artifact_reference", version_id: item.target_id };
}

export function ScheduleSourcePicker({
  content,
  space,
  files,
  artifacts,
  active,
  text,
  onChange,
}: ScheduleSourceMetadata & {
  content: ScheduleContent;
  active: boolean;
  space?: Pick<CloudSpaceClient, "list">;
  text: Text;
  onChange: (content: ScheduleContent) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const browse = useRef<HTMLElement>(null);
  const sourceCountLabel = useRef<HTMLSpanElement>(null);
  const selectedList = useRef<HTMLUListElement>(null);
  const focusAfterRemoval = useRef<number>(undefined);
  const pickerId = useId();
  const parts: ContentParts =
    typeof content === "string" ? [{ type: "text", text: content }] : content;
  const selectedReferences = new Map<string, number>();
  const occurrences = new Map<string, number>();
  let referenceCount = 0;
  const sources = parts.flatMap((source, index) => {
    if (source.type === "text") return [];
    const key = source.type === "image_url" ? "image" : libraryKey(source);
    if (source.type !== "image_url") {
      referenceCount++;
      if (!selectedReferences.has(key)) selectedReferences.set(key, index);
    }
    const position = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, position);
    return [{ source, index, key: `${key}:${position}`, position }];
  });
  const addLimit =
    referenceCount >= maximumReferences
      ? "references"
      : parts.length >= SCHEDULE_CONTENT_PART_LIMIT
        ? "content"
        : undefined;
  useLayoutEffect(() => {
    const rowIndex = focusAfterRemoval.current;
    if (rowIndex === undefined) return;
    focusAfterRemoval.current = undefined;
    const buttons = selectedList.current?.querySelectorAll("button");
    const next =
      buttons?.[Math.min(rowIndex, sources.length - 1)] ??
      (space ? browse.current : sourceCountLabel.current);
    next?.focus({ preventScroll: true });
  }, [sources.length, space]);

  const removePart = (index: number) =>
    onChange(parts.filter((_, partIndex) => partIndex !== index));

  return (
    <div className="min-w-0 px-3 py-1">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-2 text-sm">
        <span ref={sourceCountLabel} tabIndex={-1}>
          {text("来源", "Sources")} · {sources.length}
        </span>
        <Button
          ref={browse}
          type="button"
          variant="ghost"
          className={touchAction}
          aria-expanded={open}
          aria-controls={open ? pickerId : undefined}
          disabled={!space}
          onClick={() => setOpen(!open)}
        >
          {text("从资料空间选择", "Choose from library")}
        </Button>
      </div>
      {sources.length > 0 && (
        <ul
          ref={selectedList}
          aria-label={text("已选来源", "Selected sources")}
          className="min-w-0 divide-y divide-border/50"
        >
          {sources.map(({ source, index, key, position }, rowIndex) => (
            <SelectedSource
              key={key}
              source={source}
              position={source.type === "image_url" ? position : rowIndex + 1}
              files={files}
              artifacts={artifacts}
              active={active}
              text={text}
              onRemove={() => {
                focusAfterRemoval.current = rowIndex;
                removePart(index);
              }}
            />
          ))}
        </ul>
      )}
      {open && space && active && (
        <div id={pickerId} className="min-w-0 space-y-2 border-t border-border/60 py-2">
          <Input
            value={query}
            maxLength={200}
            className="min-h-11 md:min-h-9"
            aria-label={text("搜索资料", "Search files")}
            placeholder={text("搜索资料", "Search files")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <SourceLibrary
            key={query.trim()}
            query={query.trim()}
            space={space}
            text={text}
            selectedReferences={selectedReferences}
            addLimit={addLimit}
            onToggle={(source) => {
              const index = selectedReferences.get(libraryKey(source));
              if (index !== undefined) removePart(index);
              else if (!addLimit) onChange([...parts, source]);
            }}
          />
        </div>
      )}
    </div>
  );
}

function SelectedSource({
  source,
  position,
  files,
  artifacts,
  active,
  text,
  onRemove,
}: ScheduleSourceMetadata & {
  source: Source;
  position: number;
  active: boolean;
  text: Text;
  onRemove: () => void;
}) {
  const [metadata, setMetadata] = useState<
    { name: string; version?: number } | { status: "missing" | "unreadable" }
  >();
  const fileId = source.type === "file_reference" ? source.file_id : undefined;
  const versionId = source.type === "artifact_reference" ? source.version_id : undefined;
  useEffect(() => {
    if (!active || (!fileId && !versionId)) return;
    const controller = new AbortController();
    const { signal } = controller;
    const result = fileId
      ? files?.get(fileId, signal).then((file) => ({ name: file.name }))
      : versionId &&
        artifacts
          ?.get(versionId, signal)
          .then((version) => ({ name: version.name, version: version.number }));
    if (result)
      void result
        .then((value) => {
          if (!signal.aborted) setMetadata(value);
        })
        .catch((cause: unknown) => {
          if (signal.aborted) return;
          const missing =
            (cause instanceof CloudChatFileError || cause instanceof CloudChatArtifactError) &&
            cause.status === 404;
          setMetadata({ status: missing ? "missing" : "unreadable" });
        });
    return () => controller.abort();
  }, [active, files, artifacts, fileId, versionId]);

  const image = source.type === "image_url" ? source.image_url : undefined;
  const imageFormat = image
    ? /^data:image\/(png|jpeg|gif|webp);base64,/i.exec(image.url)?.[1]?.toUpperCase()
    : undefined;
  const Icon = image ? ImageIcon : FileText;
  const resolved = metadata && "name" in metadata ? metadata : undefined;
  const name =
    resolved?.name ??
    (image
      ? text(`内嵌图片 ${position}`, `Embedded image ${position}`)
      : fileId
        ? text(`文件来源 ${position}`, `File source ${position}`)
        : text(`成果来源 ${position}`, `Artifact source ${position}`));
  const detail = resolved?.version
    ? text(`版本 ${resolved.version}`, `Version ${resolved.version}`)
    : metadata && "status" in metadata
      ? metadata.status === "missing"
        ? text("资料已不可用", "Source unavailable")
        : text("暂时无法读取名称", "Couldn't read the source name")
      : imageFormat;
  return (
    <li className="flex min-h-11 min-w-0 items-center gap-2 py-0.5 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate" title={name}>
          {name}
        </p>
        {detail && <p className="break-words text-xs text-muted-foreground">{detail}</p>}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-11 shrink-0 text-muted-foreground md:size-8"
        aria-label={text(`移除 ${name}`, `Remove ${name}`)}
        onClick={onRemove}
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
    </li>
  );
}

function SourceLibrary({
  query,
  space,
  text,
  selectedReferences,
  addLimit,
  onToggle,
}: {
  query: string;
  space: Pick<CloudSpaceClient, "list">;
  text: Text;
  selectedReferences: ReadonlyMap<string, number>;
  addLimit?: "references" | "content";
  onToggle: (source: LibrarySource) => void;
}) {
  const [request, setRequest] = useState({ cursor: "" });
  const [page, setPage] = useState<{
    request: typeof request;
    items: CloudSpaceItem[];
    next: string;
    error?: "changed" | "unreadable";
  }>();
  const prefix = useId();
  const pending = page?.request !== request;
  const error = pending ? undefined : page?.error;
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const { cursor } = request;
    const timer = window.setTimeout(
      () => {
        void space
          .list(recentLibrary, query, "updated", cursor, signal)
          .then((value) => {
            if (signal.aborted) return;
            const ready = value.items.filter(
              (item) => item.kind !== "folder" && item.state === "ready",
            );
            setPage((previous) => {
              const items = new Map(
                (cursor ? (previous?.items ?? []) : []).map((item) => [item.id, item]),
              );
              for (const item of ready) items.set(item.id, item);
              return { request, items: [...items.values()], next: value.next_cursor };
            });
          })
          .catch((cause: unknown) => {
            if (signal.aborted) return;
            setPage((previous) => ({
              request,
              items: previous?.items ?? [],
              next: previous?.next ?? "",
              error:
                cause instanceof CloudSpaceError && cause.status === 409 ? "changed" : "unreadable",
            }));
          });
      },
      cursor ? 0 : 160,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [request, query, space]);

  return (
    <>
      {!!page?.items.length && (
        <ul
          className="max-h-40 overflow-y-auto"
          aria-label={text("资料搜索结果", "Library results")}
        >
          {page.items.map((item) => {
            const source = librarySource(item);
            const selected = selectedReferences.has(libraryKey(source));
            const inputId = `${prefix}-${item.id}`;
            return (
              <li key={item.id}>
                <label
                  htmlFor={inputId}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-muted md:min-h-9"
                >
                  <Checkbox
                    id={inputId}
                    checked={selected}
                    disabled={!selected && !!addLimit}
                    onCheckedChange={() => onToggle(source)}
                  />
                  <span className="min-w-0 truncate" title={item.name}>
                    {item.name}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {pending && (
        <p role="status" className="text-xs text-muted-foreground">
          {text("正在读取资料…", "Loading library…")}
        </p>
      )}
      {error ? (
        <StatusNotice
          compact
          tone="warning"
          message={
            error === "changed"
              ? text("资料列表已更新。", "The library changed.")
              : text("暂时无法读取资料。", "Couldn't load the library.")
          }
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={touchAction}
              onClick={() => setRequest({ cursor: error === "changed" ? "" : request.cursor })}
            >
              {text("重试读取资料", "Retry library")}
            </Button>
          }
        />
      ) : page?.next ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={touchAction}
          aria-disabled={pending}
          onClick={() => {
            if (!pending) setRequest({ cursor: page.next });
          }}
        >
          {text("显示更多资料", "Show more sources")}
        </Button>
      ) : !pending && !page?.items.length ? (
        <p role="status" className="text-xs text-muted-foreground">
          {query
            ? text("没有匹配的可选资料。", "No matching sources.")
            : text("资料空间里暂无可选资料。", "No sources in the library yet.")}
        </p>
      ) : null}
      {addLimit && (
        <p className="text-xs text-muted-foreground">
          {addLimit === "references"
            ? text("最多可选 8 项资料引用。", "You can select up to 8 library sources.")
            : text("任务最多包含 32 个内容块。", "A task can include up to 32 content items.")}
        </p>
      )}
    </>
  );
}
