import { configurationVersionHeaders, readKBrainConfiguration } from "./configurationVersion";
import { fetchKBrain } from "./transport";
import type { KBrainClientOptions } from "./types";

export type KBrainAgentTemplate = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
};

export type KBrainPromptSnapshot = {
  readonly configurationVersion?: string;
  version?: "kbrain.agent.v1";
  revision: number;
  globalTemplates: KBrainAgentTemplate[];
  globalPrompt?: string;
  projectPrompt: string;
  projectPromptStrategy: "append" | "replace";
  effectivePrompt?: string;
  projectPrompts?: Record<
    string,
    {
      workdir?: string;
      prompt?: string;
      strategy?: "append" | "replace";
    }
  >;
  files?: Array<{ name: string; description?: string; argumentHint?: string; path: string }>;
};

type PromptMutationResponse = {
  readonly configurationVersion?: string;
  version?: "kbrain.agent.v1";
  revision: number;
  templates?: KBrainAgentTemplate[];
};

export type KBrainPromptClient = {
  get(workdir?: string): Promise<KBrainPromptSnapshot>;
  replaceTemplates(
    templates: KBrainAgentTemplate[],
    baseRevision?: number,
    configurationVersion?: string,
  ): Promise<PromptMutationResponse>;
  createTemplate(
    template: KBrainAgentTemplate,
    configurationVersion?: string,
  ): Promise<PromptMutationResponse>;
  patchTemplate(
    id: string,
    patch: Partial<Omit<KBrainAgentTemplate, "id">>,
    configurationVersion?: string,
  ): Promise<PromptMutationResponse>;
  deleteTemplate(id: string, configurationVersion?: string): Promise<PromptMutationResponse>;
  setProject(
    workdir: string,
    prompt: string,
    strategy: "append" | "replace",
    configurationVersion?: string,
  ): Promise<PromptMutationResponse>;
  /**
   * 展开 Markdown 提示词模板。args 为已切分的参数；传 `{ text }` 时由 K-brain
   * 按 commandline.Split 切分原始参数文本（输入框“/”指令走这条）。
   */
  expandMarkdown(
    name: string,
    args: string[] | { text: string },
    workdir?: string,
  ): Promise<{ name: string; text: string }>;
};

export function createKBrainPromptClient(
  inputOptions: KBrainClientOptions = {},
): KBrainPromptClient {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchKBrain(path, init, inputOptions);
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try {
        const parsed = JSON.parse(body) as { error?: string; message?: string };
        message = parsed.error ?? parsed.message ?? body;
      } catch {
        // Preserve non-JSON backend errors.
      }
      throw Object.assign(
        new Error(message || `ZeroAgent engine prompt request failed (${response.status})`),
        {
          status: response.status,
        },
      );
    }
    return readKBrainConfiguration<T>(response);
  }

  function promptPath(workdir?: string): string {
    if (!workdir?.trim()) return "/v1/prompts";
    return `/v1/prompts?workdir=${encodeURIComponent(workdir.trim())}`;
  }

  return {
    get: (workdir) => request<KBrainPromptSnapshot>(promptPath(workdir)),
    replaceTemplates: (templates, baseRevision, configurationVersion) =>
      request<PromptMutationResponse>("/v1/prompts/templates", {
        method: "PUT",
        headers: configurationVersionHeaders(configurationVersion),
        body: JSON.stringify({
          templates,
          ...(baseRevision === undefined ? {} : { baseRevision }),
        }),
      }),
    createTemplate: (template, configurationVersion) =>
      request<PromptMutationResponse>("/v1/prompts/templates", {
        method: "POST",
        headers: configurationVersionHeaders(configurationVersion),
        body: JSON.stringify(template),
      }),
    patchTemplate: (id, patch, configurationVersion) =>
      request<PromptMutationResponse>(`/v1/prompts/templates/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: configurationVersionHeaders(configurationVersion),
        body: JSON.stringify(patch),
      }),
    deleteTemplate: (id, configurationVersion) =>
      request<PromptMutationResponse>(`/v1/prompts/templates/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: configurationVersionHeaders(configurationVersion),
      }),
    setProject: (workdir, prompt, strategy, configurationVersion) =>
      request<PromptMutationResponse>("/v1/prompts/project", {
        method: "PUT",
        headers: configurationVersionHeaders(configurationVersion),
        body: JSON.stringify({ workdir, prompt, strategy }),
      }),
    expandMarkdown: async (name, args, workdir) => {
      const query = workdir?.trim() ? `?workdir=${encodeURIComponent(workdir.trim())}` : "";
      return request<{ name: string; text: string }>(
        `/v1/prompts/templates/${encodeURIComponent(name)}/expand${query}`,
        {
          method: "POST",
          body: JSON.stringify(Array.isArray(args) ? { args } : { text: args.text }),
        },
      );
    },
  };
}
