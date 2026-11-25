import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { AnnotationDocument } from "@liveagent/ui/lib/chat/imageAnnotation/model";
import type {
  PendingUploadedFile,
  ReplacePendingUpload,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import {
  loadUploadedImagePreview,
  type UploadedImagePreviewLoader,
} from "@liveagent/ui/lib/chat/uploadedImagePreview";
import {
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ImageAnnotationDialog, type ImageAnnotationResult } from "./ImageAnnotationDialog";

/** What the composer remembers about an attachment it replaced with an annotated copy. */
export type ComposerImageAnnotationEntry = {
  /** The staged original, swapped back in on revert and re-annotated on edit. */
  original: PendingUploadedFile;
  document: AnnotationDocument;
  includeNote: boolean;
};

type Session = {
  scope: object;
  file: PendingUploadedFile;
  imageSrc: string;
  document: AnnotationDocument | null;
  includeNote: boolean;
};

const noEntries: Record<string, ComposerImageAnnotationEntry> = {};

/** Stable composer comment id for an image's marker notes (keyed by the original). */
export function annotationNoteCommentId(original: Pick<PendingUploadedFile, "relativePath">) {
  return `annotation:${original.relativePath}`;
}

export function annotatedUploadFileName(originalName: string, mimeType: string) {
  const base = originalName.replace(/\.[^./\\]+$/u, "") || "image";
  return `${base}-annotated.${mimeType === "image/jpeg" ? "jpg" : "png"}`;
}

/**
 * Image annotation for pending composer attachments. Saving stages the
 * flattened image as a new upload and swaps it in place of the attachment;
 * the original stays staged so the chip can revert or re-open the editor
 * with the same shapes. Marker labels travel as a composer comment.
 */
export function useComposerImageAnnotation(params: {
  conversationId: string;
  authority?: string;
  workdir: string;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  imagePreviewLoader?: UploadedImagePreviewLoader;
  onReplacePendingUpload?: ReplacePendingUpload;
}) {
  const {
    conversationId,
    authority,
    workdir,
    composerRef,
    imagePreviewLoader,
    onReplacePendingUpload,
  } = params;
  const enabled = Boolean(onReplacePendingUpload);
  const scope = useMemo(
    () => ({ conversationId, authority, workdir, enabled }),
    [conversationId, authority, workdir, enabled],
  );
  const { t } = useLocale();
  const activeScope = useRef<object | null>(scope);
  activeScope.current = scope;
  useEffect(() => {
    activeScope.current = scope;
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
    };
  }, [scope]);
  const [stored, setEntries] = useState({ scope, entries: noEntries });
  const entries = stored.scope === scope ? stored.entries : noEntries;
  const [storedSession, setSession] = useState<Session | null>(null);
  const session = storedSession?.scope === scope ? storedSession : null;
  const startRequest = useRef(0);

  const startAnnotation = useCallback(
    async (file: PendingUploadedFile, currentImageSrc: string) => {
      const request = ++startRequest.current;
      const entry = entries[file.relativePath];
      if (entry && imagePreviewLoader && workdir) {
        // Re-edit: reopen the original with the saved shapes.
        const originalSrc = await loadUploadedImagePreview({
          workspaceRoot: workdir,
          file: entry.original,
          loader: imagePreviewLoader,
          scope: authority,
        });
        if (activeScope.current !== scope || request !== startRequest.current) return;
        if (originalSrc) {
          setSession({
            scope,
            file,
            imageSrc: originalSrc,
            document: entry.document,
            includeNote: entry.includeNote,
          });
          return;
        }
        toast.error(t("chat.annotate.loadFailed"));
        return;
      }
      setSession({ scope, file, imageSrc: currentImageSrc, document: null, includeNote: true });
    },
    [authority, entries, imagePreviewLoader, scope, t, workdir],
  );

  const syncNoteComment = useCallback(
    (original: PendingUploadedFile, fileName: string, note: string, include: boolean) => {
      const composer = composerRef.current;
      if (!composer) return;
      const id = annotationNoteCommentId(original);
      if (include && note.trim()) {
        composer.upsertComment({
          id,
          quote: "",
          comment: note,
          source: { kind: "image", path: fileName },
        });
      } else {
        composer.removeComment(id);
      }
    },
    [composerRef],
  );

  const saveAnnotation = useCallback(
    async (result: ImageAnnotationResult) => {
      const current = session;
      if (!current || !onReplacePendingUpload || activeScope.current !== scope) {
        throw new Error("annotation unavailable");
      }
      const previous = entries[current.file.relativePath];
      const original = previous?.original ?? current.file;
      const upload = new File(
        [result.blob],
        annotatedUploadFileName(original.fileName, result.mimeType),
        { type: result.mimeType },
      );
      const staged = await onReplacePendingUpload(current.file.relativePath, upload);
      if (activeScope.current !== scope) return;
      if (!staged) throw new Error("annotated image was not staged");
      setEntries((previousState) => {
        const next = { ...(previousState.scope === scope ? previousState.entries : noEntries) };
        delete next[current.file.relativePath];
        next[staged.relativePath] = {
          original,
          document: result.document,
          includeNote: result.includeNote,
        };
        return { scope, entries: next };
      });
      syncNoteComment(original, staged.fileName, result.note, result.includeNote);
    },
    [entries, onReplacePendingUpload, scope, session, syncNoteComment],
  );

  const revertAnnotation = useCallback(
    async (file: PendingUploadedFile) => {
      const entry = entries[file.relativePath];
      if (!entry || !onReplacePendingUpload) return;
      const restored = await onReplacePendingUpload(file.relativePath, entry.original);
      if (!restored || activeScope.current !== scope) return;
      setEntries((previousState) => {
        const next = { ...previousState.entries };
        delete next[file.relativePath];
        return { scope, entries: next };
      });
      composerRef.current?.removeComment(annotationNoteCommentId(entry.original));
    },
    [composerRef, entries, onReplacePendingUpload, scope],
  );

  /** Call when an attachment is removed so its marker-note comment goes too. */
  const forgetAnnotation = useCallback(
    (relativePath: string) => {
      const entry = entries[relativePath];
      if (!entry) return;
      composerRef.current?.removeComment(annotationNoteCommentId(entry.original));
      setEntries((previousState) => {
        const next = { ...previousState.entries };
        delete next[relativePath];
        return { scope, entries: next };
      });
    },
    [composerRef, entries, scope],
  );

  const dialog: ReactNode = session ? (
    <ImageAnnotationDialog
      open
      imageSrc={session.imageSrc}
      fileName={(entries[session.file.relativePath]?.original ?? session.file).fileName}
      initialDocument={session.document}
      initialIncludeNote={session.includeNote}
      onOpenChange={(open) => {
        if (!open) {
          setSession(null);
          composerRef.current?.focus();
        }
      }}
      onSave={saveAnnotation}
    />
  ) : null;

  return {
    enabled,
    isAnnotated: (relativePath: string) => Boolean(entries[relativePath]),
    startAnnotation,
    revertAnnotation,
    forgetAnnotation,
    dialog,
  };
}
