import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

test("display excerpts never split surrogate pairs or replace complete protocol text", () => {
  const api = createWebModuleLoader().loadModule("src/lib/cloudChatMessagePreview.ts");
  const text = "A".repeat(4095) + "😀" + "B".repeat(8190) + "🧑‍💻";
  const preview = api.cloudMessageTranscriptPreview(text);
  assert.equal(preview.truncated, true);
  assert.ok(preview.text.length <= api.CLOUD_MESSAGE_TRANSCRIPT_CHARS);
  assert.equal(preview.text, "A".repeat(4095));
  assert.match(preview.notice, /仅显示|完整正文/);
  const chunks = [];
  for (let page = 0; page < api.cloudMessageTextPage(text, 0).pages; page++) chunks.push(api.cloudMessageTextPage(text, page).text);
  assert.equal(chunks.join(""), text, "display paging must not lose or duplicate code units");
  assert.deepEqual(api.cloudMessageTranscriptPreview("complete"), { text: "complete", truncated: false, notice: "" });
  assert.equal(api.cloudMessageFitsTextBudget("A".repeat(65536),api.CLOUD_MESSAGE_INLINE_EDIT_BYTES),true);
  assert.equal(api.cloudMessageFitsTextBudget("中".repeat(22000),api.CLOUD_MESSAGE_INLINE_EDIT_BYTES),false);
  assert.equal(api.cloudMessageFitsTextBudget("中".repeat(8192),api.CLOUD_MESSAGE_INLINE_EDIT_BYTES),true);
  assert.equal(api.cloudMessageFitsTextBudget("A".repeat(2*1024*1024),api.CLOUD_MESSAGE_CLIPBOARD_BYTES),false);
});
