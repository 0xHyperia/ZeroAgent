import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const load = () => createTsModuleLoader({ rootDir: fileURLToPath(new URL("..", import.meta.url)) }).loadModule("src/lib/cloudChatDrafts.ts");
const view = (conversationId, userId = 1) => ({ userId, conversationId });
const richDraft = api => ({
  ...api.emptyCloudChatDraft(), presentation: "chat", researchEnabled: true,
  composer: {
    text: "问题与长文本", textWithoutLargePastes: "问题", isEmpty: false,
    segments: [{ type: "text", text: "问题" }, { type: "largePaste", paste: { id: "paste-a", text: "不可丢失的长文本" } }],
    largePastes: [{ id: "paste-a", text: "不可丢失的长文本" }],
    skillMentions: [], appMentions: [], commitMentions: [], gitFileMentions: [], conversationMentions: [], codeMentions: [],
  },
  files: [{ id: "file-a", name: "原件.docx", version: 3 }],
  artifacts: [{ id: "version-a", family_id: "artifact-a", number: 2, name: "工作产物.pptx" }],
});

test("conversation draft snapshots preserve structured content, resources and presentation without sharing mutable data", () => {
  const api = load(), store = new api.CloudChatDraftStore(1), draft = richDraft(api);
  store.write(view("a"), draft);
  store.write(view("b"), api.emptyCloudChatDraft());
  const restored = store.read(view("a"));
  assert.deepEqual(restored, draft);
  draft.composer.segments[1].paste.text = "changed by editor";
  restored.artifacts[0].name = "changed by preview";
  assert.equal(store.read(view("a")).composer.segments[1].paste.text, "不可丢失的长文本");
  assert.equal(store.read(view("a")).artifacts[0].name, "工作产物.pptx");
  assert.deepEqual(store.read(view("b")), api.emptyCloudChatDraft());
});

test("account reset erases old drafts and rejects late writes from the previous account", () => {
  const api = load(), store = new api.CloudChatDraftStore(1), draft = richDraft(api);
  store.write(view("a"), draft);
  store.reset(2);
  store.write(view("a"), draft);
  assert.equal(store.read(view("a")), undefined);
  assert.equal(store.read(view("a", 2)), undefined);
  store.write(view("a", 2), draft);
  store.reset(0);
  assert.equal(store.read(view("a", 2)), undefined);
});

test("accepted-message matching ignores presentation but detects changed structure and resource versions", () => {
  const api = load(), submitted = richDraft(api), current = api.cloneCloudChatDraft(submitted);
  current.presentation = "work";
  current.researchEnabled = false;
  assert.equal(api.cloudChatDraftContentMatches(submitted, current), true);
  current.composer.segments[1].paste.text += "用户后来输入";
  assert.equal(api.cloudChatDraftContentMatches(submitted, current), false);
  const changedVersion = api.cloneCloudChatDraft(submitted);
  changedVersion.artifacts[0].id = "version-b";
  assert.equal(api.cloudChatDraftContentMatches(submitted, changedVersion), false);
  const empty = api.emptyCloudChatDraft();
  assert.equal(api.cloudChatDraftContentMatches(empty, { ...empty, composer: { isEmpty: true } }), true);
});

test("clearing the blank draft or a deleted conversation does not discard another conversation", () => {
  const api = load(), store = new api.CloudChatDraftStore(1), draft = richDraft(api);
  store.write(view(""), draft);
  store.write(view("a"), draft);
  store.write(view(""), api.emptyCloudChatDraft());
  assert.deepEqual(store.read(view("")), api.emptyCloudChatDraft());
  assert.deepEqual(store.read(view("a")), draft);
  store.remove(view("a", 2));
  assert.deepEqual(store.read(view("a")), draft);
  store.remove(view("a"));
  assert.equal(store.read(view("a")), undefined);
});
