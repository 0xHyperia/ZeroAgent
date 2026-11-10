import { createContext, useContext, useEffect, useState } from "react";
import type { PendingUploadedFile } from "./uploadTypes";

export type UploadedImagePreviewResult = {
  mimeType: string;
  data: string;
};

export type UploadedImagePreviewLoader = (
  workspaceRoot: string,
  absolutePath: string,
) => Promise<UploadedImagePreviewResult | Blob | null>;

type UploadedImagePreviewCacheEntry = {
  src: string;
  revoke?: () => void;
};

const UPLOADED_IMAGE_PREVIEW_CACHE_LIMIT = 64;
const uploadedImagePreviewCache = new Map<string, UploadedImagePreviewCacheEntry>();
const uploadedImagePreviewRequests = new Map<string, Promise<string | null>>();
const uploadedImagePreviewRevisions = new Map<string, object>();
export const UploadedImagePreviewScope = createContext("");

function normalizeCachePart(value: string | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

// 预览身份 = workspaceRoot + absolutePath：附件读取只认导入时返回的绝对
// 路径，旧版本仅持久化相对路径的附件不再提供预览。
export function getUploadedImagePreviewCacheKey(
  workspaceRoot: string | undefined,
  file: Pick<PendingUploadedFile, "absolutePath">,
  scope = "",
) {
  const root = normalizeCachePart(workspaceRoot);
  const path = normalizeCachePart(file.absolutePath);
  return path ? `${scope}\0${root}\0${path}` : "";
}

function readUploadedImagePreviewCacheByKey(cacheKey: string) {
  const cached = uploadedImagePreviewCache.get(cacheKey);
  if (!cached) return undefined;
  uploadedImagePreviewCache.delete(cacheKey);
  uploadedImagePreviewCache.set(cacheKey, cached);
  return cached.src;
}

function getUploadedImagePreviewRevision(cacheKey: string) {
  const current = uploadedImagePreviewRevisions.get(cacheKey);
  if (current) return current;
  const revision = {};
  uploadedImagePreviewRevisions.set(cacheKey, revision);
  return revision;
}

function invalidateUploadedImagePreviewCacheByKey(cacheKey: string) {
  const cached = uploadedImagePreviewCache.get(cacheKey);
  cached?.revoke?.();
  uploadedImagePreviewCache.delete(cacheKey);

  if (uploadedImagePreviewRequests.has(cacheKey)) {
    uploadedImagePreviewRevisions.set(cacheKey, {});
  } else {
    uploadedImagePreviewRevisions.delete(cacheKey);
  }
  uploadedImagePreviewRequests.delete(cacheKey);
}

export function readUploadedImagePreviewCache(
  workspaceRoot: string | undefined,
  file: Pick<PendingUploadedFile, "absolutePath">,
  scope = "",
) {
  const cacheKey = getUploadedImagePreviewCacheKey(workspaceRoot, file, scope);
  return cacheKey ? readUploadedImagePreviewCacheByKey(cacheKey) : undefined;
}

export function invalidateUploadedImagePreviewCache(
  workspaceRoot: string | undefined,
  file: Pick<PendingUploadedFile, "absolutePath">,
) {
  const cacheKey = getUploadedImagePreviewCacheKey(workspaceRoot, file);
  if (cacheKey) invalidateUploadedImagePreviewCacheByKey(cacheKey);
}

function writeUploadedImagePreviewCache(cacheKey: string, entry: UploadedImagePreviewCacheEntry) {
  const previous = uploadedImagePreviewCache.get(cacheKey);
  if (previous?.src !== entry.src) {
    previous?.revoke?.();
  }
  uploadedImagePreviewCache.delete(cacheKey);
  uploadedImagePreviewCache.set(cacheKey, entry);

  while (uploadedImagePreviewCache.size > UPLOADED_IMAGE_PREVIEW_CACHE_LIMIT) {
    const oldestKey = uploadedImagePreviewCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = uploadedImagePreviewCache.get(oldestKey);
    oldest?.revoke?.();
    uploadedImagePreviewCache.delete(oldestKey);
    if (!uploadedImagePreviewRequests.has(oldestKey)) {
      uploadedImagePreviewRevisions.delete(oldestKey);
    }
  }
}

function canCreateObjectUrl() {
  return typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

function createLocalPreviewCacheEntry(file: File): UploadedImagePreviewCacheEntry | null {
  if (!canCreateObjectUrl()) return null;
  const src = URL.createObjectURL(file);
  return {
    src,
    revoke: typeof URL.revokeObjectURL === "function" ? () => URL.revokeObjectURL(src) : undefined,
  };
}

function isImageSourceFile(file: File) {
  return typeof file.type === "string" && file.type.toLowerCase().startsWith("image/");
}

function takeMatchingSourceFile(
  uploadedFile: PendingUploadedFile,
  sourceFiles: File[],
  usedSourceIndexes: Set<number>,
) {
  const exactIndex = sourceFiles.findIndex(
    (sourceFile, index) =>
      !usedSourceIndexes.has(index) &&
      isImageSourceFile(sourceFile) &&
      sourceFile.name === uploadedFile.fileName &&
      sourceFile.size === uploadedFile.sizeBytes,
  );
  if (exactIndex >= 0) {
    const exactMatch = sourceFiles[exactIndex];
    if (!exactMatch) return null;
    usedSourceIndexes.add(exactIndex);
    return exactMatch;
  }

  const sameSizeMatches = sourceFiles
    .map((sourceFile, index) => ({ sourceFile, index }))
    .filter(
      ({ sourceFile, index }) =>
        !usedSourceIndexes.has(index) &&
        isImageSourceFile(sourceFile) &&
        sourceFile.size === uploadedFile.sizeBytes,
    );
  if (sameSizeMatches.length === 1) {
    const sameSizeMatch = sameSizeMatches[0];
    if (!sameSizeMatch) return null;
    usedSourceIndexes.add(sameSizeMatch.index);
    return sameSizeMatch.sourceFile;
  }
  return null;
}

export function registerLocalUploadedImagePreviews(params: {
  workspaceRoot: string | undefined;
  uploadedFiles: PendingUploadedFile[];
  sourceFiles: File[];
  scope?: string;
}) {
  const { workspaceRoot, uploadedFiles, sourceFiles, scope } = params;
  const usedSourceIndexes = new Set<number>();

  for (const uploadedFile of uploadedFiles) {
    if (uploadedFile.kind !== "image") continue;
    const cacheKey = getUploadedImagePreviewCacheKey(workspaceRoot, uploadedFile, scope);
    if (!cacheKey) continue;
    const sourceFile = takeMatchingSourceFile(uploadedFile, sourceFiles, usedSourceIndexes);
    if (!sourceFile) continue;
    const entry = createLocalPreviewCacheEntry(sourceFile);
    if (!entry) continue;
    invalidateUploadedImagePreviewCacheByKey(cacheKey);
    writeUploadedImagePreviewCache(cacheKey, entry);
  }
}

export async function loadUploadedImagePreview(params: {
  workspaceRoot: string;
  file: PendingUploadedFile;
  loader: UploadedImagePreviewLoader;
  scope?: string;
}) {
  const { workspaceRoot, file, loader, scope } = params;
  const cacheKey = getUploadedImagePreviewCacheKey(workspaceRoot, file, scope);
  if (!cacheKey) return null;

  const cached = readUploadedImagePreviewCacheByKey(cacheKey);
  if (cached !== undefined) return cached;

  const absolutePath = normalizeCachePart(file.absolutePath);
  if (!absolutePath) return null;

  const existing = uploadedImagePreviewRequests.get(cacheKey);
  if (existing) return existing;

  const revision = getUploadedImagePreviewRevision(cacheKey);
  let request: Promise<string | null>;
  request = loader(workspaceRoot, absolutePath)
    .then((result) => {
      if (result instanceof Blob) {
        if (!canCreateObjectUrl() || uploadedImagePreviewRevisions.get(cacheKey) !== revision)
          return null;
        const src = URL.createObjectURL(result);
        writeUploadedImagePreviewCache(cacheKey, { src, revoke: () => URL.revokeObjectURL(src) });
        return src;
      }
      const mimeType =
        typeof result?.mimeType === "string" && result.mimeType.trim()
          ? result.mimeType.trim()
          : "application/octet-stream";
      const data = typeof result?.data === "string" ? result.data.trim() : "";
      const next = data ? `data:${mimeType};base64,${data}` : null;
      if (uploadedImagePreviewRevisions.get(cacheKey) !== revision) return null;
      if (next) writeUploadedImagePreviewCache(cacheKey, { src: next });
      return next;
    })
    .catch(() => null)
    .finally(() => {
      if (uploadedImagePreviewRequests.get(cacheKey) === request) {
        uploadedImagePreviewRequests.delete(cacheKey);
      }
      if (!uploadedImagePreviewCache.has(cacheKey) && !uploadedImagePreviewRequests.has(cacheKey)) {
        uploadedImagePreviewRevisions.delete(cacheKey);
      }
    });

  uploadedImagePreviewRequests.set(cacheKey, request);
  return request;
}

export function useUploadedImagePreview(
  file?: PendingUploadedFile,
  workspaceRoot?: string,
  loader?: UploadedImagePreviewLoader,
) {
  const scope = useContext(UploadedImagePreviewScope);
  const normalizedWorkspaceRoot = normalizeCachePart(workspaceRoot);
  const absolutePath = normalizeCachePart(file?.absolutePath);
  const cacheKey = file ? getUploadedImagePreviewCacheKey(normalizedWorkspaceRoot, file, scope) : "";
  const [result, setResult] = useState<{ key: string; src: string | null } | undefined>(() => {
    const src = uploadedImagePreviewCache.get(cacheKey)?.src;
    return src === undefined ? undefined : { key: cacheKey, src };
  });
  const imageSrc = result?.key === cacheKey ? result.src : undefined;

  useEffect(() => {
    if (!file || !cacheKey) return;

    const cached = readUploadedImagePreviewCacheByKey(cacheKey);
    if (cached !== undefined) {
      setResult({ key: cacheKey, src: cached });
      return;
    }
    if (!absolutePath || !loader) return;

    let cancelled = false;
    void loadUploadedImagePreview({
      workspaceRoot: normalizedWorkspaceRoot,
      file,
      loader,
      scope,
    }).then((value) => {
      if (!cancelled) {
        setResult({ key: cacheKey, src: value });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [absolutePath, cacheKey, file, loader, normalizedWorkspaceRoot, scope]);

  return {
    imageSrc: imageSrc ?? null,
    isLoading: Boolean(cacheKey && absolutePath && loader) && imageSrc === undefined,
  };
}
