import type {
  MentionComposerDraft,
  MentionComposerDraftSegment,
} from "@liveagent/ui/components/chat/MentionComposer";
import {
  clipboardRecord,
  clipboardString,
  normalizeComposerClipboardSegment,
  serializeDraftSegments,
} from "@liveagent/ui/components/chat/MentionComposerInternals";
import {
  type ComposerCommentInput,
  createComposerComment,
} from "@liveagent/ui/lib/chat/composerComments";
import { createTextComposerDraft } from "@liveagent/ui/lib/chat/composerDraft";
import { parseFileMentionPath } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { normalizeWorkspaceExcerpt } from "@liveagent/ui/lib/chat/workspaceExcerpt";
import { parseExtensionReference } from "@liveagent/ui/lib/extensions/reference";
import type { AppSettings } from "@liveagent/ui/lib/settings/types";
import { workspaceProjectPathKey } from "@liveagent/ui/lib/settings/workspaceProjects";
import { MAX_UPLOAD_FILES } from "./constants";
import { findDeviceDraftProject } from "./gatewayDeviceDraftWorkspace";

const prefix = "zeroagent.device-composer.v1:";
const maximumStoredLength = 1_000_000;
const kinds: ReadonlySet<string> = new Set([
  "text",
  "image",
  "pdf",
  "notebook",
  "word",
  "spreadsheet",
  "archive",
]);

export type GatewayDeviceDraftScope = { ownerId: number; agentId: string };
export type GatewayDeviceDraftTarget = { kind: "session" | "local"; id: string };
export type GatewaySavedDeviceDraftState = "saved" | "workspace" | "work-mode" | "current-draft";
export type GatewayDeviceReplyIdentity = { sessionId: string; workdir: string };
export type GatewayDevicePaneDraft = {
  draft: MentionComposerDraft;
  identity?: GatewayDeviceReplyIdentity;
  submitting: boolean;
};
type DraftWorkspace = { id: string; path: string };
type DraftContent = {
  workspace: DraftWorkspace | null;
  segments: MentionComposerDraftSegment[];
  attachments: PendingUploadedFile[];
  unfinishedUpload: boolean;
  exceedsLimit?: boolean;
};

function ownerPrefix(ownerId: number) {
  return Number.isSafeInteger(ownerId) && ownerId > 0 ? `${prefix}${ownerId}:` : "";
}

function storageKey(scope: GatewayDeviceDraftScope, target?: GatewayDeviceDraftTarget) {
  const owner = ownerPrefix(scope.ownerId);
  const agent = scope.agentId.trim();
  const device = owner && agent ? owner + encodeURIComponent(agent) : "";
  return device && target
    ? target.id.trim() && `${device}:${target.kind}:${encodeURIComponent(target.id.trim())}`
    : device;
}

export function listGatewayLocalDeviceDrafts(scope: GatewayDeviceDraftScope) {
  const device = storageKey(scope);
  if (!device) return [];
  const localPrefix = `${device}:local:`;
  try {
    const storage = window.sessionStorage;
    return Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(localPrefix)))
      .map((key) => decodeURIComponent(key.slice(localPrefix.length)));
  } catch {
    return [];
  }
}

export function createGatewayDevicePaneDraftRegistry() {
  const readers = new Map<string, () => GatewayDevicePaneDraft | undefined>();
  return {
    register(id: string, reader: () => GatewayDevicePaneDraft | undefined) {
      readers.set(id, reader);
      return () => {
        if (readers.get(id) === reader) readers.delete(id);
      };
    },
    entries(resolve: (id: string) => string) {
      const mounted = new Map<string, { id: string; snapshot: GatewayDevicePaneDraft }>();
      for (const [id, read] of readers) {
        let snapshot: GatewayDevicePaneDraft | undefined;
        try {
          snapshot = read();
        } catch {
          // One unmounted or failed editor cannot stop the other panes saving.
        }
        if (!snapshot) continue;
        const resolved = resolve(id);
        if (id === resolved || !mounted.has(resolved)) mounted.set(resolved, { id, snapshot });
      }
      return mounted;
    },
    clear: () => readers.clear(),
  };
}

function normalizeSegment(value: unknown) {
  const segment = clipboardRecord(value);
  if (segment?.type === "comment") {
    const raw = clipboardRecord(segment.comment);
    const comment = raw && createComposerComment(raw as ComposerCommentInput);
    return comment ? { type: "comment" as const, comment } : null;
  }
  if (segment?.type === "workspaceExcerpt") {
    const excerpt = normalizeWorkspaceExcerpt(segment.excerpt);
    return excerpt ? { type: "workspaceExcerpt" as const, excerpt } : null;
  }
  if (segment?.type !== "skillMention") {
    const normalized = normalizeComposerClipboardSegment(value, []);
    // Git's transport remote can contain embedded credentials. Only keep the
    // canonical GitHub reference and the display name of the remote.
    const git =
      normalized?.type === "commitMention"
        ? normalized.commit
        : normalized?.type === "gitFileMention"
          ? normalized.file
          : undefined;
    if (git) {
      git.remoteUrl = "";
      if (git.githubUrl && /^[a-z]+:\/\/[^/]+@/i.test(git.githubUrl)) git.githubUrl = undefined;
    }
    return normalized;
  }
  const skill = clipboardRecord(segment.skill);
  if (!skill) return null;
  const name = clipboardString(skill, "name").trim();
  const skillFile = clipboardString(skill, "skillFile").trim();
  const baseDir = clipboardString(skill, "baseDir").trim();
  const pinned = parseExtensionReference(skillFile);
  if (
    !name ||
    !skillFile ||
    !baseDir ||
    (pinned
      ? baseDir !== "cloud" || pinned.skillName !== name
      : baseDir === "cloud" || /^(?:[a-z]+:\/\/|blob:|data:)/i.test(skillFile))
  )
    return null;
  return normalizeComposerClipboardSegment(segment, [
    {
      name,
      skillFile,
      baseDir,
      description: clipboardString(skill, "description"),
      displayName: clipboardString(skill, "displayName") || undefined,
    },
  ]);
}

function normalizeAttachment(value: unknown): PendingUploadedFile | null {
  const file = clipboardRecord(value);
  if (!file) return null;
  const reference = parseFileMentionPath(clipboardString(file, "relativePath"));
  const fileName = clipboardString(file, "fileName").trim();
  const kind = clipboardString(file, "kind");
  const absolutePath = clipboardString(file, "absolutePath").trim();
  const forwardPath = absolutePath.replace(/\\/g, "/");
  if (
    !reference ||
    reference.kind !== "file" ||
    !fileName ||
    !kinds.has(kind) ||
    typeof file.sizeBytes !== "number" ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes < 0 ||
    !/^(?:\/|[a-z]:\/)/i.test(forwardPath) ||
    !forwardPath.endsWith(`/${reference.path}`) ||
    forwardPath.split("/").some((part) => part === "." || part === "..")
  )
    return null;
  return {
    relativePath: reference.path,
    // An import may live in the device's staging root outside the workspace.
    // Retain the host-issued path and let the existing device attachment checks
    // authorize it on read/send. Never rebuild it under the project root.
    absolutePath,
    fileName,
    kind: kind as PendingUploadedFile["kind"],
    sizeBytes: file.sizeBytes,
    dedupeKey: clipboardString(file, "dedupeKey") || undefined,
    ...(file.displayMode === "largePaste"
      ? {
          displayMode: "largePaste",
          displayLabel: clipboardString(file, "displayLabel"),
          displayCharCount:
            typeof file.displayCharCount === "number" ? file.displayCharCount : undefined,
          displayLineCount:
            typeof file.displayLineCount === "number" ? file.displayLineCount : undefined,
        }
      : {}),
  };
}

export function readGatewayDeviceDraft(
  scope: GatewayDeviceDraftScope,
  target?: GatewayDeviceDraftTarget,
): DraftContent | null {
  const key = storageKey(scope, target);
  if (!key) return null;
  try {
    const stored = window.sessionStorage.getItem(key);
    if (!stored || stored.length > maximumStoredLength) return null;
    const parsed = clipboardRecord(JSON.parse(stored));
    if (
      !parsed ||
      !Array.isArray(parsed.segments) ||
      !Array.isArray(parsed.attachments) ||
      parsed.segments.length > 10_000 ||
      parsed.attachments.length > MAX_UPLOAD_FILES
    )
      return null;
    const segments = parsed.segments.map(normalizeSegment);
    const attachments = parsed.attachments.map(normalizeAttachment);
    if (segments.some((item) => item === null) || attachments.some((item) => item === null))
      return null;
    const workspace = clipboardRecord(parsed.workspace);
    if (
      parsed.workspace !== null &&
      (typeof workspace?.id !== "string" || typeof workspace?.path !== "string" || !workspace.path)
    )
      return null;
    return {
      workspace: workspace ? { id: String(workspace.id), path: String(workspace.path) } : null,
      segments: segments.filter((item) => item !== null),
      attachments: attachments.filter((item) => item !== null),
      unfinishedUpload: parsed.unfinishedUpload === true,
      exceedsLimit: parsed.exceedsLimit === true,
    };
  } catch {
    return null;
  }
}

export function gatewayLocalDraftCaptureTarget(
  scope: GatewayDeviceDraftScope,
  id: string,
  currentId: string,
  activeSlotOwner?: string,
): GatewayDeviceDraftTarget | undefined {
  // A previous mount can leave an unconsumed draft in the active slot.
  // Keep new input in the current pane's own slot until the old draft is recovered.
  if (id !== currentId || (id !== activeSlotOwner && readGatewayDeviceDraft(scope)))
    return { kind: "local", id };
}

export function saveGatewayDeviceDraft(
  scope: GatewayDeviceDraftScope,
  draft: DraftContent,
  target?: GatewayDeviceDraftTarget,
) {
  const key = storageKey(scope, target);
  if (!key) return;
  try {
    const segments = draft.segments.map(normalizeSegment).filter((item) => item !== null);
    const attachments = draft.attachments.map(normalizeAttachment).filter((item) => item !== null);
    const storage = window.sessionStorage;
    const content = JSON.stringify({ ...draft, segments, attachments });
    if (content.length <= maximumStoredLength) {
      try {
        storage.setItem(key, content);
        return;
      } catch {
        // Never resurrect an older version after a failed overwrite.
        storage.removeItem(key);
      }
    }
    storage.setItem(
      key,
      JSON.stringify({
        workspace: draft.workspace,
        segments: [],
        attachments,
        unfinishedUpload: draft.unfinishedUpload,
        exceedsLimit: true,
      }),
    );
  } catch {
    // Browser policy can prevent tab-local draft persistence.
  }
}

export function clearGatewayDeviceDraft(
  scope: GatewayDeviceDraftScope,
  target?: GatewayDeviceDraftTarget,
) {
  const key = storageKey(scope, target);
  if (!key) return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {}
}

export function clearGatewayDeviceDraftsForAccount(ownerId: number) {
  const owner = ownerPrefix(ownerId);
  if (!owner) return;
  try {
    const storage = window.sessionStorage;
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(owner)) storage.removeItem(key);
    }
  } catch {}
}

export function resolveGatewayDraftWorkspace(
  system: AppSettings["system"],
  workspace: DraftWorkspace | null,
) {
  if (!workspace) return { path: "" };
  const project = findDeviceDraftProject(system, workspace);
  if (project) return { path: project.path, project };
  const key = workspaceProjectPathKey(workspace.path);
  const unavailable = [
    ...system.archivedWorkspaceProjectPaths,
    ...system.missingWorkspaceProjectPaths,
  ];
  if (
    !workspace.id &&
    key &&
    workspaceProjectPathKey(system.workdir) === key &&
    !unavailable.some((path) => workspaceProjectPathKey(path) === key)
  )
    return { path: system.workdir };
  return null;
}

export function planGatewaySavedDeviceDraftRecovery(
  saved: DraftContent,
  system: AppSettings["system"],
  current: { workdir: string; workMode: boolean; hasInput: boolean },
) {
  if (current.hasInput) return { state: "current-draft" } as const;
  const workspace = resolveGatewayDraftWorkspace(system, saved.workspace);
  if (
    !workspace ||
    (saved.attachments.length > 0 && !workspace.path) ||
    (current.workMode &&
      !workspace.project &&
      workspaceProjectPathKey(workspace.path) !== workspaceProjectPathKey(current.workdir))
  )
    return { state: "workspace" } as const;
  if (saved.attachments.length && !current.workMode) return { state: "work-mode" } as const;
  return { state: "ready", workspace } as const;
}

export function restoreGatewayDeviceDraft(draft: DraftContent) {
  const text = serializeDraftSegments(draft.segments);
  const composer: MentionComposerDraft = {
    ...createTextComposerDraft(text),
    segments: draft.segments,
  };
  return { composer, attachments: draft.attachments };
}

export function readGatewayDeviceReplyDraft(
  scope: GatewayDeviceDraftScope,
  identity: GatewayDeviceReplyIdentity,
) {
  const target = { kind: "session", id: identity.sessionId } as const;
  const saved = readGatewayDeviceDraft(scope, target);
  if (
    !saved ||
    workspaceProjectPathKey(saved.workspace?.path ?? "") !==
      workspaceProjectPathKey(identity.workdir) ||
    (saved.attachments.length && !identity.workdir)
  )
    return null;
  return { saved, target };
}
