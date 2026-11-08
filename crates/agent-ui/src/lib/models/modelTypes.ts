export const MODEL_TYPES = ["text", "image", "video", "other"] as const;
export type ModelType = (typeof MODEL_TYPES)[number];

export function modelListEntries(response: unknown) {
  const payload = response as { data?: unknown; models?: unknown } | null;
  const items = Array.isArray(response)
    ? response
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  return items.flatMap((entry): { id: string; modelTypes?: ModelType[] }[] =>
    entry != null && typeof entry === "object" && typeof entry.id === "string"
      ? [
          {
            id: entry.id,
            modelTypes:
              readModelTypes(entry) ?? (entry.imageModel === true ? ["image"] : undefined),
          },
        ]
      : [],
  );
}

function uniqueTypes(types: readonly (ModelType | undefined)[]): ModelType[] | undefined {
  const result = MODEL_TYPES.filter((type) => types.includes(type));
  return result.length ? result : undefined;
}

function endpointType(value: unknown): ModelType | undefined {
  if (typeof value !== "string") return undefined;
  const endpoint = value.toLowerCase().replace(/\/$/, "");
  if (/\/(chat\/completions|responses|messages)$/.test(endpoint)) return "text";
  if (/\/images\/(generations|edits)$/.test(endpoint)) return "image";
  if (/\/videos?(\/generations)?$/.test(endpoint)) return "video";
  if (/\/(embeddings|rerank|moderations|audio\/[^/]+)$/.test(endpoint)) return "other";
  return undefined;
}

/** Read output metadata from provider discovery or a normalized model configuration. */
export function readModelTypes(model: Record<string, unknown>): ModelType[] | undefined {
  const declared = model.modelTypes;
  if (Array.isArray(declared)) {
    const configured = MODEL_TYPES.filter((type) => declared.includes(type));
    if (configured.length) return configured;
  }
  if (Array.isArray(model.supported_endpoints)) {
    const types = uniqueTypes(model.supported_endpoints.map(endpointType));
    if (types) return types;
  }
  const modalities = model.modalities as { output?: unknown } | undefined;
  const outputs = model.output_modalities ?? model.outputModalities ?? modalities?.output;
  if (!Array.isArray(outputs)) return undefined;
  return uniqueTypes(
    outputs.map((value) => {
      if (typeof value !== "string" || !value.trim()) return undefined;
      const output = value.trim().toLowerCase();
      return output === "text" || output === "image" || output === "video" ? output : "other";
    }),
  );
}

export function modelTypesFor(
  modelId: string,
  config?: { modelTypes?: readonly ModelType[]; imageModel?: boolean; imageAdapter?: string },
): readonly ModelType[] {
  if (config?.modelTypes?.length) return config.modelTypes;
  if (config?.imageModel === true || (config?.imageAdapter && config.imageAdapter !== "disabled"))
    return ["image"];

  const id = modelId.trim().toLowerCase().split("/").pop() ?? "";
  if (
    /^(?:(?:doubao-)?seedance|sora|veo|kling|hailuo|wanx?|vidu|hunyuan-video|grok-imagine-video)(?:[-_.@0-9]|$)/.test(
      id,
    )
  )
    return ["video"];
  if (
    /^(?:gpt-image|chatgpt-image|dall-e|imagen|flux|(?:doubao-)?seedream|qwen-image|z-image|nano-banana|grok-imagine)(?:[-_.@0-9]|$)/.test(
      id,
    ) ||
    /^gemini-.+-(?:image(?:[-_.@]|$)|image-generation)/.test(id)
  )
    return ["image"];
  if (
    /(?:^|[-_.])(?:embeddings?|rerank(?:er)?|whisper|tts|transcribe|moderation|realtime)(?:[-_.@0-9]|$)/.test(
      id,
    )
  )
    return ["other"];
  return ["text"];
}
