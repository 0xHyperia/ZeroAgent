import { Component, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { PreviewIdentityContext } from "./PreviewChrome";
import {
  checkPreviewSignature,
  RESOURCE_PREVIEW_MAX_BYTES,
  type ResourcePreviewDescriptor,
  resourcePreviewKind,
} from "./previewPolicy";
import type { DocumentRevisionComment } from "./ResourceDocumentComments";
import { getResourceFileIcon } from "./ResourceFileIcon";
import "./resource-preview.css";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewReadingTarget, usePreviewReadingScope } from "./readingSession";

export { PreviewUnavailable } from "./PreviewFeedback";
export { ResourcePreviewReadingSession } from "./readingSession";

const ResourcePreviewContent = lazy(() => import("./ResourcePreviewContent"));

export type ResourcePreviewProps = {
  resource: ResourcePreviewDescriptor;
  /** The host owns authentication and resource/version access; it never passes a URL or key. */
  load: (signal: AbortSignal) => Promise<{ blob: Blob; assertCurrent: () => void }>;
  onDownload?: () => void;
  onRequestRevision?: (comments: readonly DocumentRevisionComment[]) => Promise<boolean> | boolean;
  /** A non-interactive, bounded cover rendered from the same verified original. */
  variant?: "reader" | "thumbnail";
};

class PreviewBoundary extends Component<
  { children: ReactNode } & PreviewRecovery,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <PreviewUnavailable
        onDownload={this.props.onDownload}
        onRetry={this.props.onRetry}
        message="预览组件加载失败，请重新打开或下载原件。"
      />
    ) : (
      this.props.children
    );
  }
}

/** Pure shared presentation. Does not import account clients, stores or native bridges. */
export function ResourcePreview(props: ResourcePreviewProps) {
  const { resource } = props;
  const TypeIcon = getResourceFileIcon(resource.name);
  const thumbnail = props.variant === "thumbnail";
  const readingScope = usePreviewReadingScope();
  const current = useRef(props);
  current.current = props;
  const [attempt, setAttempt] = useState(0);
  const [paused, setPaused] = useState<string | null>(null);
  // A host may reuse a logical ID while refreshing metadata. Never paint old bytes for it.
  const identity = JSON.stringify([
    readingScope,
    resource.identity,
    resource.name,
    resource.mime,
    resource.size,
    resource.sha256,
    thumbnail,
  ]);
  const [loaded, setLoaded] = useState<{
    identity: string;
    bytes: Uint8Array;
    assertCurrent: () => void;
  } | null>(null);
  const [error, setError] = useState<{ identity: string; message: string } | null>(null);
  const kind = resourcePreviewKind(resource);
  const thumbnailUnavailable =
    thumbnail &&
    (resource.size > 4 * 1024 * 1024 ||
      !["docx", "pptx", "pdf", "image", "svg", "text", "markdown", "sheet"].includes(kind));
  // biome-ignore lint/correctness/useExhaustiveDependencies: an explicit retry owns a fresh abort lifetime
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoaded(null);
    setError(null);
    if (kind === "unsupported" || thumbnailUnavailable || paused === identity)
      return () => {
        active = false;
        controller.abort();
      };
    void (async () => {
      if (
        !Number.isSafeInteger(resource.size) ||
        resource.size < 0 ||
        resource.size > RESOURCE_PREVIEW_MAX_BYTES ||
        !/^[a-f0-9]{64}$/.test(resource.sha256)
      )
        throw new Error("此文件超出预览范围，请下载原件查看。");
      if (kind === "image" && resource.size > 8 * 1024 * 1024)
        throw new Error("图片较大，请下载原件查看。");
      const result = await current.current.load(controller.signal);
      result.assertCurrent();
      if (result.blob.size !== resource.size) throw new Error("文件读取不完整，请重试。");
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      if (
        [...digest].map((part) => part.toString(16).padStart(2, "0")).join("") !== resource.sha256
      )
        throw new Error("文件完整性校验失败，请刷新后重试。");
      checkPreviewSignature(kind, bytes);
      result.assertCurrent();
      if (active && !controller.signal.aborted)
        setLoaded({ identity, bytes, assertCurrent: result.assertCurrent });
    })().catch((cause: unknown) => {
      if (active && !controller.signal.aborted)
        setError({
          identity,
          message: cause instanceof Error ? cause.message : "文件预览失败，请下载原件。",
        });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    resource.identity,
    resource.name,
    resource.mime,
    resource.size,
    resource.sha256,
    kind,
    attempt,
    paused,
    identity,
    thumbnailUnavailable,
  ]);

  const retry = () => {
    setLoaded(null);
    setError(null);
    setPaused(null);
    setAttempt((value) => value + 1);
  };

  return (
    <PreviewIdentityContext.Provider
      value={{
        name: resource.name,
        mime: resource.mime,
        onRequestRevision: props.onRequestRevision,
      }}
    >
      <section
        className="za-resource-preview"
        data-kind={kind}
        data-variant={props.variant ?? "reader"}
        aria-label={`${resource.name}预览`}
      >
        <div className="za-preview-body">
          {thumbnail && (thumbnailUnavailable || error?.identity === identity) ? (
            <div className="za-thumbnail-fallback">
              <TypeIcon />
              <span>{resource.name.split(".").pop()?.toUpperCase()}</span>
            </div>
          ) : kind === "unsupported" ? (
            <PreviewUnavailable
              onDownload={props.onDownload}
              message="此格式暂不支持在线预览，原件已保留。"
            />
          ) : paused === identity ? (
            <PreviewUnavailable
              message="已取消预览读取，原件保持不变。"
              onRetry={retry}
              onDownload={props.onDownload}
            />
          ) : error?.identity === identity ? (
            <PreviewUnavailable
              message={error.message}
              onRetry={retry}
              onDownload={props.onDownload}
            />
          ) : loaded?.identity === identity ? (
            <PreviewBoundary
              key={`${identity}:${attempt}`}
              onDownload={props.onDownload}
              onRetry={retry}
            >
              <Suspense
                fallback={
                  thumbnail ? (
                    <div className="za-thumbnail-loading">
                      <TypeIcon />
                    </div>
                  ) : (
                    <PreviewLoading onCancel={() => setPaused(identity)} />
                  )
                }
              >
                <PreviewReadingTarget identity={identity}>
                  <ResourcePreviewContent
                    key={`${identity}:${attempt}`}
                    kind={kind}
                    thumbnail={thumbnail}
                    name={resource.name}
                    mime={resource.mime}
                    bytes={loaded.bytes}
                    assertCurrent={loaded.assertCurrent}
                    onDownload={props.onDownload}
                    onRetry={retry}
                    onCancel={() => setPaused(identity)}
                  />
                </PreviewReadingTarget>
              </Suspense>
            </PreviewBoundary>
          ) : thumbnail ? (
            <div className="za-thumbnail-loading">
              <TypeIcon />
            </div>
          ) : (
            <PreviewLoading onCancel={() => setPaused(identity)} />
          )}
        </div>
      </section>
    </PreviewIdentityContext.Provider>
  );
}

/** Horizontal clipping is respected: offscreen draft cards do not read or parse files. */
export function ResourceThumbnail(props: Omit<ResourcePreviewProps, "variant" | "onDownload">) {
  const TypeIcon = getResourceFileIcon(props.resource.name);
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = host.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) =>
      setVisible(entries.some((entry) => entry.isIntersecting)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={host} className="za-resource-thumbnail" inert aria-hidden="true">
      {visible ? (
        <ResourcePreview {...props} variant="thumbnail" />
      ) : (
        <div className="za-thumbnail-loading" data-idle="true">
          <TypeIcon />
        </div>
      )}
    </div>
  );
}
