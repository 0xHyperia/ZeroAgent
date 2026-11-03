import { FolderClosed, Globe } from "@liveagent/ui/components/IconSet";
import { getResourceFileIcon } from "@liveagent/ui/components/resource-preview/ResourceFileIcon";
import {
  type ResourcePreviewProps,
  ResourceThumbnail,
} from "@liveagent/ui/components/resource-preview/ResourcePreview";
import { useEffect, useRef, useState } from "react";
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

/** The library and composer use the same verified, bounded cover renderer. */
export function CloudSpaceCover(props: {
  item: CloudSpaceItem;
  files: CloudChatFilesClient;
  artifacts: CloudChatArtifactsClient;
  captureGuard: () => () => void;
}) {
  const { item, files, artifacts, captureGuard } = props;
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const [preview, setPreview] = useState<{ key: string; props: ResourcePreviewProps } | null>(null);
  const [siteCover, setSiteCover] = useState<{ key: string; html: string } | null>(null);
  const [coverWidth, setCoverWidth] = useState(0);
  const key = `${item.kind}:${item.target_id}:${item.updated_at}`;
  const Icon =
    item.kind === "folder"
      ? FolderClosed
      : item.site_version_id
        ? Globe
        : getResourceFileIcon(item.name);
  useEffect(() => {
    if (!visible || !item.site_version_id || !artifacts.sites?.cover) return;
    const controller = new AbortController(),
      guard = captureGuard();
    void artifacts.sites
      .cover(item.site_version_id, controller.signal)
      .then((html) => {
        guard();
        if (!controller.signal.aborted) setSiteCover({ key, html });
      })
      .catch(() => {});
    const node = host.current;
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (node) setCoverWidth(node.clientWidth);
          })
        : null;
    if (node) {
      setCoverWidth(node.clientWidth);
      observer?.observe(node);
    }
    return () => {
      controller.abort();
      observer?.disconnect();
    };
  }, [visible, key, item.site_version_id, artifacts, captureGuard]);
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "120px" },
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (
      !visible ||
      item.kind === "folder" ||
      item.site_version_id ||
      !item.size ||
      item.size > 4 * 1024 * 1024 ||
      ["uploading", "deleting", "deleted", "staging"].includes(item.state)
    )
      return;
    const controller = new AbortController();
    const guard = captureGuard();
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
          key,
          props: {
            resource: { ...resource, identity: `space:${key}:${resource.sha256}` },
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
          },
        });
      })
      .catch(() => {
        /* The original remains accessible if a cover cannot be read. */
      });
    return () => controller.abort();
  }, [
    visible,
    key,
    item.kind,
    item.target_id,
    item.site_version_id,
    item.size,
    item.state,
    files,
    artifacts,
    captureGuard,
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
      {siteCover?.key === key && visible ? (
        <iframe
          title="站点首页封面"
          tabIndex={-1}
          sandbox=""
          srcDoc={siteCover.html}
          style={{ width: 1100, height: 720, transform: `scale(${coverWidth / 1100})` }}
        />
      ) : preview?.key === key && visible ? (
        <ResourceThumbnail {...preview.props} />
      ) : (
        <Icon className="size-6" />
      )}
    </span>
  );
}
