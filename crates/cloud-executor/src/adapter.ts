import type { Config, Operation } from "./protocol.ts";
export type Context = {
  signal: AbortSignal;
  checkpoint: (result: Record<string, unknown>) => Promise<void>;
};
export interface Adapter {
  enabled: boolean;
  execute(operation: Operation, context: Context): Promise<Record<string, unknown>>;
}
export function redact(value: unknown, config: Config): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of [config.token, config.scopeKey, config.apiKey])
      if (secret) text = text.split(secret).join("[redacted]");
    return text;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, config));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, config)]));
  return value;
}
