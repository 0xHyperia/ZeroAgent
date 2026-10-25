import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
test("brand icons prefer model families and use the connection protocol only for unknown models", () => {
  const names = ["ClaudeIcon", "DeepseekIcon", "GeminiIcon", "GrokIcon", "OpenaiChatgptIcon", "MoonshotIcon", "QwenIcon", "ZaiIcon"];
  const icons = Object.fromEntries(names.map(name => [name, Object.defineProperty(() => null, "name", {value: name})]));
  const { ProviderBrandIcon } = createTsModuleLoader({mocks:{"@liveagent/ui/components/IconSet": icons}}).loadModule("@liveagent/ui/components/ProviderBrandIcon.tsx");
  for (const [model, expected] of [["KIMI-K2.5", "MoonshotIcon"], ["relay/DeepSeek-V3.2", "DeepseekIcon"], ["usa0:GLM-5", "ZaiIcon"], ["usa0:Qwen3:free", "QwenIcon"], ["Claude-4.5", "ClaudeIcon"], ["unknown", "OpenaiChatgptIcon"]]) assert.equal(ProviderBrandIcon({type:"codex",model}).type.name, expected, model);
  assert.equal(ProviderBrandIcon({type:"gemini",model:"unknown"}).type.name, "GeminiIcon");
});
