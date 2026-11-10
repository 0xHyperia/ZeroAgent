import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { useLocale } from "../../../i18n";
import type { GitDiffPreview, GitDiffPreviewFile } from "../../../lib/git/types";
import { Loader2 } from "../../IconSet";
import type { PatchChunk } from "./model";

const InlinePDF = lazy(() =>
  import("../../resource-preview/ResourcePDFPreview").then((module) => ({
    default: module.GitReviewPDFPreview,
  })),
);

const rasterImage = /\.(?:avif|bmp|gif|ico|jpe?g|png|tiff?|webp)$/i;
const previewMime =
  /^image\/(?:avif|bmp|gif|jpeg|png|svg\+xml|tiff|webp|x-icon|vnd\.microsoft\.icon)$/;
const maxEncodedBytes = Math.ceil((8 * 1024 * 1024) / 3) * 4;

export function gitReviewPreviewKind(path: string, richPreview: boolean) {
  if (/\.pdf$/i.test(path)) return "pdf";
  if (rasterImage.test(path) || (richPreview && /\.svg$/i.test(path))) return "image";
  return null;
}

function readBytes(file: GitDiffPreviewFile) {
  if (!file.base64 || file.base64.length > maxEncodedBytes) return null;
  try {
    return Uint8Array.from(atob(file.base64), (value) => value.charCodeAt(0));
  } catch {
    return null;
  }
}

function ReviewPreviewStatus({ children, loading }: { children: ReactNode; loading?: boolean }) {
  return (
    <div className="za-review-preview-status" role={loading ? "status" : undefined}>
      {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
      {children}
    </div>
  );
}

function ReviewPreviewSide({
  file,
  label,
  missing,
  loading,
}: {
  file: GitDiffPreviewFile | null;
  label: string;
  missing: string;
  loading: string;
}) {
  const [decoded, setDecoded] = useState<{
    file: GitDiffPreviewFile;
    src?: string;
    pdf?: Uint8Array;
  }>();
  const [failedSource, setFailedSource] = useState("");
  useEffect(() => {
    setDecoded(undefined);
    if (!file) return;
    const bytes = readBytes(file);
    if (!bytes) return;
    if (file.mime === "application/pdf") {
      setDecoded({ file, pdf: bytes });
    } else if (previewMime.test(file.mime)) {
      // An img loads SVG in image mode, without script or external resource access.
      const src = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
      setDecoded({ file, src });
      return () => URL.revokeObjectURL(src);
    }
  }, [file]);
  const current = decoded?.file === file ? decoded : undefined;
  return (
    <section className="za-review-preview-side" aria-label={label}>
      {current?.pdf ? (
        <Suspense fallback={<ReviewPreviewStatus loading>{loading}</ReviewPreviewStatus>}>
          <InlinePDF bytes={current.pdf} />
        </Suspense>
      ) : current?.src && failedSource !== current.src ? (
        <img
          alt={label}
          src={current.src}
          data-svg={file?.mime === "image/svg+xml" || undefined}
          onError={() => setFailedSource(current.src ?? "")}
        />
      ) : (
        <ReviewPreviewStatus>{missing}</ReviewPreviewStatus>
      )}
    </section>
  );
}

type LoadPreview = (item: PatchChunk) => Promise<GitDiffPreview | null>;

export function GitBinaryReviewPreview({
  item,
  load,
  kind,
  fallback,
}: {
  item: PatchChunk;
  load: LoadPreview;
  kind: "pdf" | "image";
  fallback?: ReactNode;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const root = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [loaded, setLoaded] = useState<{
    item: PatchChunk;
    load: LoadPreview;
    result: GitDiffPreview | null;
  }>();
  useEffect(() => {
    if (!root.current || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      rootMargin: "320px 0px",
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setLoaded(undefined);
    if (!near) return;
    let active = true;
    const publish = (result: GitDiffPreview | null) => {
      if (active) setLoaded({ item, load, result });
    };
    void load(item).then(publish, () => publish(null));
    return () => {
      active = false;
    };
  }, [item, load, near]);
  const current = near && loaded?.item === item && loaded.load === load ? loaded : undefined;
  const preview = current?.result;
  const loading = zh ? "正在加载预览…" : "Loading preview…";
  const missing = zh
    ? kind === "pdf"
      ? "无 PDF 预览"
      : "无图像预览"
    : kind === "pdf"
      ? "No PDF preview"
      : "No image";
  const hasPreview = Boolean(preview?.before || preview?.after);
  return (
    <div
      ref={root}
      className="za-review-binary-preview"
      data-after-only={!preview?.before && !!preview?.after}
    >
      {!current ? (
        <ReviewPreviewStatus loading>{loading}</ReviewPreviewStatus>
      ) : preview && hasPreview ? (
        <>
          {preview.before && (
            <ReviewPreviewSide
              file={preview.before}
              label={zh ? "变更前" : "Before"}
              missing={missing}
              loading={loading}
            />
          )}
          <ReviewPreviewSide
            file={preview.after}
            label={zh ? "变更后" : "After"}
            missing={missing}
            loading={loading}
          />
        </>
      ) : (
        (fallback ?? <ReviewPreviewStatus>{missing}</ReviewPreviewStatus>)
      )}
    </div>
  );
}
