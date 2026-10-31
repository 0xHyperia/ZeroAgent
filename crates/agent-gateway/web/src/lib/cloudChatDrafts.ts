import type { MentionComposerDraft } from "@liveagent/ui/components/chat/MentionComposer";
import type { CloudChatArtifactVersion } from "./cloudChatArtifacts";
import type { CloudChatFile } from "./cloudChatFiles";

export type CloudChatDraftView = { userId: number; conversationId: string };

/** The editor owns one draft; navigation snapshots are private to this account and page. */
export type CloudChatDraft = {
  composer: MentionComposerDraft | null;
  files: CloudChatFile[];
  artifacts: CloudChatArtifactVersion[];
  presentation: "chat" | "work";
  researchEnabled: boolean;
  /** An unsent project selection; the server rechecks ownership when it is applied. */
  projectId?: string;
};

export function emptyCloudChatDraft(): CloudChatDraft {
  return {
    composer: null,
    files: [],
    artifacts: [],
    presentation: "work",
    researchEnabled: false,
  };
}

export function cloneCloudChatDraft(draft: CloudChatDraft): CloudChatDraft {
  return structuredClone(draft);
}

/** JSONB and wire encoders may reorder object keys; arrays retain their semantic order. */
export function cloudChatCanonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/** Presentation changes do not turn an accepted request into a new unsent message. */
export function cloudChatDraftContentMatches(left: CloudChatDraft, right: CloudChatDraft): boolean {
  const content = (draft: CloudChatDraft) => ({
    composer: draft.composer?.isEmpty ? null : draft.composer,
    files: draft.files,
    artifacts: draft.artifacts,
  });
  return cloudChatCanonicalJSON(content(left)) === cloudChatCanonicalJSON(content(right));
}

/** No browser storage: account invalidation and host disposal remove all private drafts. */
export class CloudChatDraftStore {
  private ownerId: number;
  private drafts = new Map<string, CloudChatDraft>();

  constructor(ownerId: number) {
    this.ownerId = ownerId;
  }

  reset(ownerId: number) {
    this.drafts.clear();
    this.ownerId = ownerId;
  }

  read(view: CloudChatDraftView): CloudChatDraft | undefined {
    if (view.userId !== this.ownerId) return;
    const draft = this.drafts.get(view.conversationId);
    return draft ? cloneCloudChatDraft(draft) : undefined;
  }

  write(view: CloudChatDraftView, draft: CloudChatDraft) {
    if (view.userId === this.ownerId)
      this.drafts.set(view.conversationId, cloneCloudChatDraft(draft));
  }

  remove(view: CloudChatDraftView) {
    if (view.userId === this.ownerId) this.drafts.delete(view.conversationId);
  }
}
