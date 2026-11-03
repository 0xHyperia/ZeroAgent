import {
  AudioLines,
  FolderClosed,
  Globe,
  ImageIcon,
  Video,
} from "@liveagent/ui/components/IconSet";
import { resourcePreviewKind } from "@liveagent/ui/components/resource-preview/previewPolicy";
import { getResourceFileIcon } from "@liveagent/ui/components/resource-preview/ResourceFileIcon";
import {
  type ResourcePreviewProps,
  ResourceThumbnail,
} from "@liveagent/ui/components/resource-preview/ResourcePreview";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { CloudChatArtifactsClient } from "@/lib/cloudChatArtifacts";
import type { CloudChatFilesClient } from "@/lib/cloudChatFiles";
import type { CloudSpaceItem } from "@/lib/cloudSpace";

export function cloudSpaceFormat(
  item: Pick<CloudSpaceItem, "name" | "kind" | "mime" | "site_version_id">,
) {
  if (item.kind === "folder") return "文件夹";
  if (item.site_version_id) return "站点";
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
  if (/^docx?$/.test(ext)) return "Word 文档";
  if (/^(xlsx?|csv|tsv|ods)$/.test(ext)) return "表格";
  if (/^pptx?$/.test(ext)) return "演示文稿";
  if (ext === "pdf") return "PDF 文档";
  if (/^(md|markdown)$/.test(ext)) return "Markdown 文档";
  if (item.mime.startsWith("image/")) return "图片";
  if (item.mime.startsWith("video/")) return "视频";
  if (item.mime.startsWith("audio/")) return "音频";
  return ext ? `${ext.toUpperCase()} 文件` : "文件";
}

type CoverProps = {
  item: CloudSpaceItem;
  showPreview: boolean;
  files: CloudChatFilesClient;
  artifacts: CloudChatArtifactsClient;
  captureGuard: () => () => void;
};

export function CloudSpaceFormatIcon({
  item,
  className,
}: {
  item: CloudSpaceItem;
  className?: string;
}) {
  const Icon =
    item.kind === "folder"
      ? FolderClosed
      : item.site_version_id
        ? Globe
        : item.mime.startsWith("image/")
          ? ImageIcon
          : item.mime.startsWith("video/")
            ? Video
            : item.mime.startsWith("audio/")
              ? AudioLines
              : getResourceFileIcon(item.name);
  return <Icon className={className} />;
}

/** Metadata edits do not replace the immutable original or its mounted cover. */
export function CloudSpaceCover(props: CoverProps) {
  const identity = `${props.item.kind}:${props.item.target_id}:${props.item.site_version_id ?? ""}`;
  return <SpaceCoverContent key={identity} {...props} identity={identity} />;
}

function SpaceCoverContent(props: CoverProps & { identity: string }) {
  const { item, files, artifacts, identity } = props;
  const current = useRef(props);
  current.current = props;
  const host = useRef<HTMLSpanElement>(null),
    previewHost = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  const [started, setStarted] = useState(false);
  const [preview, setPreview] = useState<ResourcePreviewProps | null>(null);
  const [siteCover, setSiteCover] = useState<string | null>(null);
  const [coverSize, setCoverSize] = useState({ width: 1100, height: 720 });
  const eligible =
    item.kind !== "folder" &&
    !["uploading", "deleting", "deleted", "staging"].includes(item.state) &&
    (!!item.site_version_id ||
      (item.size > 0 &&
        item.size <= 4 * 1024 * 1024 &&
        ["docx", "pptx", "pdf", "image", "svg", "markdown", "sheet"].includes(
          resourcePreviewKind(item),
        )));
  useEffect(() => {
    if (props.showPreview && near && eligible) setStarted(true);
  }, [props.showPreview, near, eligible]);
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "120px" },
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = previewHost.current;
    if (!node) return;
    const measure = () => {
      // Hidden list covers retain their grid geometry until they become visible again.
      if (!node.dataset.hidden && node.clientWidth > 0 && node.clientHeight > 0)
        setCoverSize((size) =>
          size.width === node.clientWidth && size.height === node.clientHeight
            ? size
            : { width: node.clientWidth, height: node.clientHeight },
        );
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    measure();
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => {
    if (!started || !eligible) return;
    const controller = new AbortController(),
      guard = current.current.captureGuard();
    if (item.site_version_id) {
      void artifacts.sites
        ?.cover(item.site_version_id, controller.signal)
        .then((html) => {
          guard();
          if (!controller.signal.aborted) setSiteCover(html);
        })
        .catch(() => {});
    } else {
      void Promise.resolve()
        .then(async () => {
          guard();
          if (controller.signal.aborted) throw new DOMException("封面已关闭", "AbortError");
          return item.kind === "file"
            ? await files.get(item.target_id, controller.signal)
            : await artifacts.get(item.target_id, controller.signal);
        })
        .then((resource) => {
          guard();
          if (controller.signal.aborted) return;
          setPreview({
            resource: { ...resource, identity: `space:${identity}:${resource.sha256}` },
            load: async (signal) => {
              guard();
              const result =
                item.kind === "file"
                  ? await files.download(resource as Awaited<ReturnType<typeof files.get>>, signal)
                  : await artifacts.download(
                      resource as Awaited<ReturnType<typeof artifacts.get>>,
                      signal,
                    );
              const assertCurrent = () => {
                guard();
                result.guard();
                if (controller.signal.aborted) throw new DOMException("封面已关闭", "AbortError");
              };
              assertCurrent();
              return { blob: result.blob, assertCurrent };
            },
          });
        })
        .catch(() => {
          /* The original remains accessible if a cover cannot be read. */
        });
    }
    return () => controller.abort();
  }, [
    started,
    eligible,
    identity,
    item.kind,
    item.target_id,
    item.site_version_id,
    files,
    artifacts,
  ]);
  return (
    <span
      ref={host}
      className="cloud-space-cover"
      aria-hidden="true"
      inert
      data-folder={item.kind === "folder" || undefined}
      data-site={!!item.site_version_id || undefined}
    >
      <span className="cloud-space-cover-icon">
        <CloudSpaceFormatIcon item={item} className="size-6" />
      </span>
      <span
        ref={previewHost}
        className="cloud-space-cover-preview"
        data-hidden={!props.showPreview || undefined}
        style={
          {
            "--cloud-space-cover-width": `${coverSize.width}px`,
            "--cloud-space-cover-height": `${coverSize.height}px`,
          } as CSSProperties
        }
      >
        {siteCover !== null ? (
          <iframe
            title="站点首页封面"
            tabIndex={-1}
            sandbox=""
            srcDoc={siteCover}
            style={{ width: 1100, height: 720, transform: `scale(${coverSize.width / 1100})` }}
          />
        ) : preview ? (
          <ResourceThumbnail {...preview} retainOnExit />
        ) : null}
      </span>
    </span>
  );
}
