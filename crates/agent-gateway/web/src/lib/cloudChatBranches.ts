type Request = (path: string, init?: RequestInit) => Promise<Response>;
type CaptureGuard = () => () => void;
export type CloudBranchRequest = {
  client_request_id: string;
  message_id: string;
  action: "edit" | "regenerate" | "fork";
  content?: unknown;
};
export type CloudBranch = {
  conversation: { id: string; title: string; model: string; updated_at: string };
  source_conversation_id: string;
  source_message_id: string;
  action: CloudBranchRequest["action"];
  draft_content?: unknown;
};
export class CloudBranchUnconfirmedError extends Error {
  constructor() {
    super("分支结果尚未确认，请核对原请求后继续。");
  }
}
export class CloudBranchRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudBranchRequestError";
  }
}
const MAX_BYTES = 34 * 1024 * 1024;

export function createCloudChatBranchesClient(request: Request, captureGuard: CaptureGuard) {
  async function parse(response: Response, guard: () => void) {
    guard();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("分支响应为空");
    try {
      while (true) {
        const { done, value } = await reader.read();
        guard();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new Error("分支响应过大");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    guard();
    if (!response.ok)
      throw new CloudBranchRequestError(
        typeof payload?.error === "string" ? payload.error : `请求失败 (HTTP ${response.status})`,
        response.status,
      );
    const branch = payload?.branch as CloudBranch | undefined;
    if (
      !branch ||
      typeof branch.conversation?.id !== "string" ||
      typeof branch.conversation.title !== "string" ||
      typeof branch.conversation.model !== "string" ||
      typeof branch.conversation.updated_at !== "string" ||
      typeof branch.source_conversation_id !== "string" ||
      typeof branch.source_message_id !== "string" ||
      !["edit", "regenerate", "fork"].includes(branch.action)
    )
      throw new Error("分支响应无效");
    return branch;
  }
  return {
    async create(conversationId: string, input: CloudBranchRequest, signal?: AbortSignal) {
      const guard = captureGuard();
      let response: Response;
      try {
        response = await request(
          `/api/web-chat/conversations/${encodeURIComponent(conversationId)}/branch`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
            signal,
          },
        );
      } catch (error) {
        guard();
        if (signal?.aborted) throw error;
        throw new CloudBranchUnconfirmedError();
      }
      guard();
      if (response.status >= 500) throw new CloudBranchUnconfirmedError();
      try {
        return await parse(response, guard);
      } catch (error) {
        guard();
        if (response.ok) throw new CloudBranchUnconfirmedError();
        throw error;
      }
    },
    async find(requestId: string, signal?: AbortSignal) {
      const guard = captureGuard();
      const response = await request(`/api/web-chat/branches/${encodeURIComponent(requestId)}`, {
        credentials: "include",
        signal,
      });
      guard();
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      return parse(response, guard);
    },
    async exportConversation(
      conversationId: string,
      format: "markdown" | "json",
      signal?: AbortSignal,
    ) {
      const guard = captureGuard();
      const response = await request(
        `/api/web-chat/conversations/${encodeURIComponent(conversationId)}/export?format=${format}`,
        { credentials: "include", headers: { Accept: "application/octet-stream" }, signal },
      );
      guard();
      if (!response.ok) await parse(response, guard);
      const declared = response.headers.get("Content-Length");
      if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(MAX_BYTES))) {
        await response.body?.cancel();
        throw new Error("导出内容超过当前大小限制");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("导出响应为空");
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const next = await reader.read();
          guard();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > MAX_BYTES) throw new Error("导出内容超过当前大小限制");
          chunks.push(next.value);
        }
      } catch (cause) {
        await reader.cancel().catch(() => undefined);
        throw cause;
      } finally {
        reader.releaseLock();
      }
      guard();
      return {
        blob: new Blob(chunks as BlobPart[], { type: "application/octet-stream" }),
        filename: `zeroagent-conversation.${format === "json" ? "json" : "md"}`,
        guard,
      };
    },
  };
}
