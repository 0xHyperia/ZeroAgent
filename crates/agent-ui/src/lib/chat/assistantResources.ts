import type { ChatFileLink } from "./chatFileLinks";

/** Display identity supplied by a host; opening always goes back through that host. */
export type AssistantResource = {
  id: string;
  kind: "file" | "artifact" | "site" | "source";
  name: string;
  role: "input" | "output" | "source";
  mime?: string;
  version?: number;
  link: ChatFileLink;
};

export type AssistantDeliverable = AssistantResource & {
  kind: "artifact" | "site";
  role: "output";
  /** Saved is a confirmed write receipt, not a promise of current access or publication. */
  status: "saved" | "unconfirmed";
};
