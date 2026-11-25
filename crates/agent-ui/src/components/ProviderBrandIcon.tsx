import {
  ClaudeIcon,
  DeepseekIcon,
  GeminiIcon,
  GrokIcon,
  MoonshotIcon,
  OpenaiChatgptIcon,
  QwenIcon,
  ZaiIcon,
} from "@liveagent/ui/components/IconSet";
import { resolveModelVendor } from "@liveagent/ui/lib/providers/modelVendor";
import type { ProviderId } from "@liveagent/ui/lib/settings/types";
import { cn } from "@liveagent/ui/lib/shared/utils";

const KNOWN_PROVIDER_IDS: readonly ProviderId[] = [
  "codex",
  "claude_code",
  "gemini",
  "xai",
  "deepseek",
];

// Sidebar rows carry providerId as a wide string: legacy rows persist "",
// GUI optimistic rows may fall back to "pending", and web optimistic rows
// store a custom provider *instance* id. Only enum hits may reach the icon —
// anything else would render as the OpenAI fallback below.
export function isKnownProviderId(value: string | undefined): value is ProviderId {
  return (KNOWN_PROVIDER_IDS as readonly string[]).includes(value ?? "");
}

// Unmatched types (including "codex") fall through to the OpenAI icon; callers
// that need "unknown renders nothing" must guard with isKnownProviderId first.
export function ProviderBrandIcon({
  type,
  model,
  className,
}: {
  type?: ProviderId;
  model?: string;
  className?: string;
}) {
  const cls = cn("size-4 shrink-0", className);
  // Protocol/provider type is a fallback: one USA-Zero key can serve many model vendors.
  switch (resolveModelVendor({ id: model ?? "" })) {
    case "Moonshot":
      return <MoonshotIcon className={cn(cls, "dark:invert")} />;
    case "智谱":
      return <ZaiIcon className={cls} />;
    case "Qwen":
      return <QwenIcon className={cls} />;
    case "DeepSeek":
      return <DeepseekIcon className={cls} />;
    case "Anthropic":
      return <ClaudeIcon className={cls} />;
    case "Google":
      return <GeminiIcon className={cls} />;
    case "xAI":
      return <GrokIcon className={cls} />;
    case "OpenAI":
      return <OpenaiChatgptIcon className={cn(cls, "fill-current dark:text-white")} />;
  }
  if (type === "claude_code") return <ClaudeIcon className={cls} />;
  if (type === "gemini") return <GeminiIcon className={cls} />;
  if (type === "xai") return <GrokIcon className={cls} />;
  if (type === "deepseek") return <DeepseekIcon className={cls} />;
  return <OpenaiChatgptIcon className={cn(cls, "fill-current dark:text-foreground")} />;
}
