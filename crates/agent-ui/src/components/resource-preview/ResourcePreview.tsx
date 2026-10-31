import { Component, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import {
  checkPreviewSignature,
  RESOURCE_PREVIEW_MAX_BYTES,
  type ResourcePreviewDescriptor,
  resourcePreviewKind,
} from "./previewPolicy";
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
  ]);
  const [loaded, setLoaded] = useState<{
    identity: string;
    bytes: Uint8Array;
    assertCurrent: () => void;
  } | null>(null);
  const [error, setError] = useState<{ identity: string; message: string } | null>(null);
  const kind = resourcePreviewKind(resource);
  // biome-ignore lint/correctness/useExhaustiveDependencies: an explicit retry owns a fresh abort lifetime
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoaded(null);
    setError(null);
    if (kind === "unsupported" || paused === identity)
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
  ]);

  const retry = () => {
    setLoaded(null);
    setError(null);
    setPaused(null);
    setAttempt((value) => value + 1);
  };

  return (
    <section className="za-resource-preview" data-kind={kind} aria-label={`${resource.name}预览`}>
      <div className="za-preview-body">
        {kind === "unsupported" ? (
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
            <Suspense fallback={<PreviewLoading onCancel={() => setPaused(identity)} />}>
              <PreviewReadingTarget identity={identity}>
                <ResourcePreviewContent
                  key={`${identity}:${attempt}`}
                  kind={kind}
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
        ) : (
          <PreviewLoading onCancel={() => setPaused(identity)} />
        )}
      </div>
    </section>
  );
}
