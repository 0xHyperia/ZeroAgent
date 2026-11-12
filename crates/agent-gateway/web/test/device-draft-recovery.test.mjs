import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const owner = { ownerId: 17, agentId: "device-a" };
const otherOwner = { ownerId: 18, agentId: "device-a" };
const otherDevice = { ownerId: 17, agentId: "device-b" };
const workspace = { id: "workspace-a", path: "C:\\repo\\demo" };
const system = {
  workspaceProjects: [{ ...workspace, name: "Demo" }],
  workdir: workspace.path,
  archivedWorkspaceProjectPaths: [],
  missingWorkspaceProjectPaths: [],
};
const uploaded = {
  relativePath: "uploads/1888/report.pdf",
  absolutePath: "C:\\ZeroAgent-data\\uploads\\1888\\report.pdf",
  fileName: "report.pdf",
  kind: "pdf",
  sizeBytes: 54,
  dedupeKey: "sha256:fixture",
  previewUrl: "blob:https://example.invalid/do-not-store",
};
const accountSkill = {
  name: "review",
  displayName: "Review",
  description: "Pinned review",
  skillFile: "zeroagent-skill:workspace-tools/2/review",
  baseDir: "cloud",
};
const deviceSkill = {
  name: "notes",
  description: "Device notes",
  skillFile: "C:/repo/demo/skills/notes/SKILL.md",
  baseDir: "C:/repo/demo/skills",
};
const draft = {
  workspace,
  segments: [
    { type: "text", text: "Keep this paragraph.\n\n" },
    { type: "fileMention", reference: { path: "docs/context.md", kind: "file" } },
    { type: "text", text: " " },
    { type: "skillMention", skill: accountSkill },
    { type: "text", text: " " },
    { type: "skillMention", skill: deviceSkill },
    { type: "largePaste", paste: { id: "paste-1", label: "Pasted text 1", text: "Original first line\nOriginal second line" } },
  ],
  attachments: [uploaded],
  unfinishedUpload: true,
};

async function setup(t) {
  const env = await createWebDomTestEnv();
  t.after(() => env.cleanup());
  return { env, recovery: env.loadModule("src/app/gatewayDeviceDraftRecovery.ts") };
}

test("a new composer rehydrates paragraphs, structured pins and full paste text with original staging receipts", async (t) => {
  const { env, recovery } = await setup(t);
  recovery.saveGatewayDeviceDraft(owner, draft);
  const stored = window.sessionStorage.getItem(window.sessionStorage.key(0));
  assert.doesNotMatch(stored, /blob:|previewUrl/);
  assert.equal(recovery.readGatewayDeviceDraft(otherOwner), null);
  assert.equal(recovery.readGatewayDeviceDraft(otherDevice), null);
  const saved = recovery.readGatewayDeviceDraft(owner);
  assert.equal(saved.unfinishedUpload, true);
  const target = recovery.resolveGatewayDraftWorkspace(system, saved.workspace);
  assert.equal(target.project.id, workspace.id);
  const restored = recovery.restoreGatewayDeviceDraft(saved);
  assert.equal(restored.attachments[0].absolutePath, uploaded.absolutePath);
  assert.equal(restored.attachments[0].relativePath, uploaded.relativePath);
  const { MentionComposer } = env.loadModule("@liveagent/ui/components/chat/MentionComposer.tsx");
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  const ref = env.React.createRef();
  let sends = 0;
  await env.act(async () => root.render(env.React.createElement(MentionComposer, {
    ref,
    workdir: target.path,
    onSend() { sends++; },
  })));
  try {
    await env.act(async () => ref.current.setDraft(restored.composer));
    const next = ref.current.getDraft();
    assert.equal(next.segments[0].text, draft.segments[0].text);
    assert.deepEqual(next.skillMentions.map((item) => item.skillFile), [accountSkill.skillFile, deviceSkill.skillFile]);
    assert.equal(next.largePastes[0].text, draft.segments.at(-1).paste.text);
    assert.equal(next.segments.find((segment) => segment.type === "fileMention").reference.path, "docs/context.md");
    assert.equal(sends, 0);
  } finally {
    await env.act(async () => root.unmount());
  }
  recovery.clearGatewayDeviceDraft(owner);
  assert.equal(recovery.readGatewayDeviceDraft(owner), null);
});

test("a missing, reassigned or archived workspace cannot acquire an existing browser draft", async (t) => {
  const { recovery } = await setup(t);
  recovery.saveGatewayDeviceDraft(owner, draft);
  const { workspace: saved } = recovery.readGatewayDeviceDraft(owner);
  assert.equal(recovery.resolveGatewayDraftWorkspace({ ...system, workspaceProjects: [{ ...workspace, id: "replacement" }] }, saved), null);
  assert.equal(recovery.resolveGatewayDraftWorkspace({ ...system, workspaceProjects: [{ ...workspace, path: "C:/repo/elsewhere" }] }, saved), null);
  assert.equal(recovery.resolveGatewayDraftWorkspace({ ...system, missingWorkspaceProjectPaths: [workspace.path] }, saved), null);
  assert.equal(recovery.resolveGatewayDraftWorkspace({ ...system, archivedWorkspaceProjectPaths: [workspace.path] }, saved), null);
  assert.ok(recovery.readGatewayDeviceDraft(owner));
});

test("Markdown excerpts stay outside the textbox and round-trip in the scoped device draft", async (t) => {
  const { env, recovery } = await setup(t);
  const { MentionComposer } = env.loadModule("@liveagent/ui/components/chat/MentionComposer.tsx");
  const { buildTextFromComposerDraft } = env.loadModule("@liveagent/ui/lib/chat/composerDraft.ts");
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  const ref = env.React.createRef();
  const emptyStates = [];
  let sends = 0;
  await env.act(async () => root.render(env.React.createElement(MentionComposer, {
    ref,
    workdir: workspace.path,
    onSend() { sends++; },
    onEmptyChange(empty) { emptyStates.push(empty); },
  })));
  const textbox = document.querySelector('[role="textbox"]');
  const pill = () => document.querySelector("[data-composer-workspace-excerpts]");
  try {
    await env.act(async () => {
      assert.ok(ref.current.insertWorkspaceExcerpt("Header\r\nNext line", "docs/api.md", "Explain this"));
    });
    assert.ok(pill());
    assert.equal(textbox.textContent, "");
    assert.equal(emptyStates.at(-1), false);
    assert.equal(ref.current.hasContent(), true);
    const quoteOnly = ref.current.getDraft();
    assert.equal(quoteOnly.isEmpty, false);
    assert.match(buildTextFromComposerDraft(quoteOnly), /docs\/api\.md\n> Header\n> Next line\n\nComment: Explain this/);
    await env.act(async () => {
      ref.current.setDraft({ ...quoteOnly, segments: [{ type: "text", text: "My question" }, ...quoteOnly.segments] });
    });
    recovery.saveGatewayDeviceDraft(owner, { workspace, segments: ref.current.getDraft().segments, attachments: [], unfinishedUpload: false });
    await env.act(async () => ref.current.clear());
    assert.equal(pill(), null);
    assert.equal(recovery.readGatewayDeviceDraft(otherOwner), null);
    assert.equal(recovery.readGatewayDeviceDraft(otherDevice), null);
    const restored = recovery.restoreGatewayDeviceDraft(recovery.readGatewayDeviceDraft(owner));
    await env.act(async () => ref.current.setDraft(restored.composer));
    assert.equal(textbox.textContent, "My question");
    assert.ok(pill());
    assert.equal(ref.current.getDraft().segments.at(-1).type, "workspaceExcerpt");
    await env.act(async () => pill().querySelector("button[aria-label]").click());
    assert.equal(pill(), null);
    assert.equal(textbox.textContent, "My question");
    assert.equal(buildTextFromComposerDraft(ref.current.getDraft()), "My question");
    assert.equal(sends, 0);
  } finally {
    await env.act(async () => root.unmount());
  }
});

test("retry preserves a blocked original workspace draft and later edits in a different workspace", async (t) => {
  const { recovery } = await setup(t);
  const newId = "__local_draft__:fallback";
  const fallback = { id: "workspace-b", path: "C:/repo/fallback" };
  const current = { workdir: fallback.path, workMode: true, hasInput: false };
  recovery.saveGatewayDeviceDraft(owner, draft);
  const saved = recovery.readGatewayDeviceDraft(owner);
  const unavailable = { ...system, missingWorkspaceProjectPaths: [workspace.path] };
  assert.equal(recovery.planGatewaySavedDeviceDraftRecovery(saved, unavailable, current).state, "workspace");

  const target = recovery.gatewayLocalDraftCaptureTarget(owner, newId, newId);
  assert.deepEqual(target, { kind: "local", id: newId });
  recovery.saveGatewayDeviceDraft(owner, {
    workspace: fallback,
    segments: [{ type: "text", text: "Another workspace draft" }],
    attachments: [],
    unfinishedUpload: false,
  }, target);
  assert.deepEqual(recovery.listGatewayLocalDeviceDrafts(owner), [newId]);
  assert.deepEqual(recovery.readGatewayDeviceDraft(owner), saved);
  assert.equal(recovery.gatewayLocalDraftCaptureTarget(otherOwner, newId, newId), undefined);
  assert.equal(recovery.gatewayLocalDraftCaptureTarget(otherDevice, newId, newId), undefined);

  assert.equal(recovery.planGatewaySavedDeviceDraftRecovery(saved, system, { ...current, hasInput: true }).state, "current-draft");
  assert.equal(recovery.planGatewaySavedDeviceDraftRecovery(saved, system, { ...current, workMode: false }).state, "work-mode");
  const restored = recovery.planGatewaySavedDeviceDraftRecovery(saved, system, current);
  assert.equal(restored.state, "ready");
  assert.equal(restored.workspace.path, workspace.path);
  assert.equal(recovery.restoreGatewayDeviceDraft(saved).attachments[0].absolutePath, uploaded.absolutePath);
  recovery.clearGatewayDeviceDraft(owner);
  assert.equal(recovery.readGatewayDeviceDraft(owner, target).segments[0].text, "Another workspace draft");

  const restoredId = "__local_draft__:restored";
  assert.equal(recovery.gatewayLocalDraftCaptureTarget(owner, restoredId, restoredId), undefined);
  recovery.saveGatewayDeviceDraft(owner, draft);
  assert.equal(recovery.gatewayLocalDraftCaptureTarget(owner, restoredId, restoredId, restoredId), undefined);
  assert.deepEqual(recovery.gatewayLocalDraftCaptureTarget(owner, newId, restoredId, restoredId), target);
});

test("account logout removes that account’s drafts on every device only", async (t) => {
  const { recovery } = await setup(t);
  for (const scope of [owner, otherOwner, otherDevice]) recovery.saveGatewayDeviceDraft(scope, draft);
  recovery.clearGatewayDeviceDraftsForAccount(owner.ownerId);
  assert.equal(recovery.readGatewayDeviceDraft(owner), null);
  assert.equal(recovery.readGatewayDeviceDraft(otherDevice), null);
  assert.ok(recovery.readGatewayDeviceDraft(otherOwner));
});

test("oversized text preserves completed file receipts and exposes the recovery limit", async (t) => {
  const { recovery } = await setup(t);
  recovery.saveGatewayDeviceDraft(owner, {
    ...draft,
    segments: [{ type: "text", text: "a".repeat(1_000_000) }],
  });
  const saved = recovery.readGatewayDeviceDraft(owner);
  assert.equal(saved.exceedsLimit, true);
  assert.equal(saved.segments.length, 0);
  assert.equal(saved.attachments[0].absolutePath, uploaded.absolutePath);
});

test("stored path or capability-shaped tampering cannot restore an attachment", async (t) => {
  const { recovery } = await setup(t);
  recovery.saveGatewayDeviceDraft(owner, draft);
  const key = window.sessionStorage.key(0);
  const valid = JSON.parse(window.sessionStorage.getItem(key));
  for (const attachment of [
    { ...uploaded, relativePath: "../report.pdf" },
    { ...uploaded, absolutePath: "https://example.invalid/uploads/1888/report.pdf" },
    { ...uploaded, absolutePath: "C:/ZeroAgent-data/../secret/uploads/1888/report.pdf" },
    { ...uploaded, absolutePath: "C:/ZeroAgent-data/uploads/1888/different.pdf" },
  ]) {
    window.sessionStorage.setItem(key, JSON.stringify({ ...valid, attachments: [attachment] }));
    assert.equal(recovery.readGatewayDeviceDraft(owner), null);
  }
});

test("Git references preserve their identity without persisting a credentialed transport remote", async (t) => {
  const { recovery } = await setup(t);
  const sha = "0123456789abcdef";
  recovery.saveGatewayDeviceDraft(owner, {
    ...draft,
    segments: [{
      type: "commitMention",
      commit: {
        sha,
        shortSha: sha.slice(0, 7),
        subject: "Review changes",
        remoteName: "origin",
        remoteUrl: "https://account:fixture-secret@github.com/example/project.git",
      },
    }],
  });
  const stored = window.sessionStorage.getItem(window.sessionStorage.key(0));
  assert.doesNotMatch(stored, /fixture-secret/);
  const [restored] = recovery.readGatewayDeviceDraft(owner).segments;
  assert.equal(restored.commit.sha, sha);
  assert.equal(restored.commit.remoteName, "origin");
});

test("split panes capture distinct active inputs and favor the current binding during draft promotion", async (t) => {
  const { env, recovery } = await setup(t);
  const { MentionComposer } = env.loadModule("@liveagent/ui/components/chat/MentionComposer.tsx");
  const registry = recovery.createGatewayDevicePaneDraftRegistry();
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  const a = env.React.createRef();
  const b = env.React.createRef();
  let sends = 0;
  const onSend = () => sends++;
  await env.act(async () => root.render(env.React.createElement(
    env.React.Fragment, null,
    env.React.createElement(MentionComposer, { ref: a, workdir: workspace.path, onSend }),
    env.React.createElement(MentionComposer, { ref: b, workdir: workspace.path, onSend }),
  )));
  try {
    await env.act(async () => {
      a.current.setText("Reply in the left conversation");
      b.current.setText("A different reply in the right conversation");
    });
    const removeStale = registry.register("left-new-alias", () => ({
      draft: b.current.getDraft(), submitting: false,
    }));
    registry.register("left-new-alias", () => ({
      draft: a.current.getDraft(),
      identity: { sessionId: "left-session", workdir: workspace.path },
      submitting: false,
    }));
    registry.register("__local_draft__:left-before-binding", () => ({
      draft: b.current.getDraft(), submitting: false,
    }));
    registry.register("right-alias", () => ({
      draft: b.current.getDraft(),
      identity: { sessionId: "right-session", workdir: workspace.path },
      submitting: false,
    }));
    registry.register("detached", () => { throw new Error("stale pane"); });
    removeStale();
    const resolveAlias = (id) => id.startsWith("__local_draft__:") ? "left-new-alias" : id;
    const snapshots = registry.entries(resolveAlias);
    assert.deepEqual([...snapshots.keys()], ["left-new-alias", "right-alias"]);
    for (const { snapshot } of snapshots.values()) {
      recovery.saveGatewayDeviceDraft(owner, {
        ...draft,
        segments: snapshot.draft.segments,
        attachments: snapshot.identity.sessionId === "right-session" ? [uploaded] : [],
      }, { kind: "session", id: snapshot.identity.sessionId });
    }
    const restoredLeft = recovery.readGatewayDeviceReplyDraft(owner, {
      sessionId: "left-session", workdir: workspace.path,
    });
    const restoredRight = recovery.readGatewayDeviceReplyDraft(owner, {
      sessionId: "right-session", workdir: workspace.path,
    });
    assert.equal(recovery.restoreGatewayDeviceDraft(restoredLeft.saved).composer.text, "Reply in the left conversation");
    assert.equal(recovery.restoreGatewayDeviceDraft(restoredRight.saved).composer.text, "A different reply in the right conversation");
    assert.equal(restoredLeft.saved.attachments.length, 0);
    assert.equal(restoredRight.saved.attachments[0].absolutePath, uploaded.absolutePath);
    assert.equal(sends, 0);
    registry.clear();
    assert.equal(registry.entries(resolveAlias).size, 0);
  } finally {
    await env.act(async () => root.unmount());
  }
});

test("reply recovery follows canonical session identity, the original workspace and the current account/device", async (t) => {
  const { recovery } = await setup(t);
  const session = { kind: "session", id: "stable-backend-session" };
  recovery.saveGatewayDeviceDraft(owner, draft, session);
  const identities = [
    { sessionId: session.id, workdir: "C:/repo/demo" },
    { sessionId: session.id, workdir: "C:/repo/different" },
    { sessionId: "another-session", workdir: "C:/repo/demo" },
  ];
  const expected = recovery.readGatewayDeviceReplyDraft(owner, identities[0]);
  assert.ok(expected);
  assert.equal(expected.target.id, session.id);
  assert.equal(recovery.readGatewayDeviceReplyDraft(owner, identities[1]), null);
  assert.equal(recovery.readGatewayDeviceReplyDraft(owner, identities[2]), null);
  assert.equal(recovery.readGatewayDeviceReplyDraft(otherOwner, identities[0]), null);
  assert.equal(recovery.readGatewayDeviceReplyDraft(otherDevice, identities[0]), null);
  recovery.clearGatewayDeviceDraft(owner, expected.target);
  assert.equal(recovery.readGatewayDeviceReplyDraft(owner, identities[0]), null);
});

test("unbound split drafts are listed separately from replies and the active new draft", async (t) => {
  const { recovery } = await setup(t);
  const local = { kind: "local", id: "__local_draft__:other-pane" };
  recovery.saveGatewayDeviceDraft(owner, draft);
  recovery.saveGatewayDeviceDraft(owner, draft, local);
  recovery.saveGatewayDeviceDraft(owner, draft, { kind: "session", id: local.id });
  recovery.saveGatewayDeviceDraft(otherDevice, draft, local);
  assert.deepEqual(recovery.listGatewayLocalDeviceDrafts(owner), [local.id]);
  assert.deepEqual(recovery.listGatewayLocalDeviceDrafts(otherOwner), []);
  recovery.clearGatewayDeviceDraft(owner, local);
  assert.deepEqual(recovery.listGatewayLocalDeviceDrafts(owner), []);
  assert.deepEqual(recovery.listGatewayLocalDeviceDrafts(otherDevice), [local.id]);
  assert.ok(recovery.readGatewayDeviceDraft(owner));
});

test("quota failure cannot resurrect the prior version of a pane draft", async (t) => {
  const { recovery } = await setup(t);
  const session = { kind: "session", id: "stable-backend-session" };
  recovery.saveGatewayDeviceDraft(owner, draft, session);
  const storagePrototype = Object.getPrototypeOf(window.sessionStorage);
  const setItem = storagePrototype.setItem;
  storagePrototype.setItem = function (key, value) {
    if (value.includes("newer text exceeds available quota")) throw new Error("quota");
    return setItem.call(this, key, value);
  };
  try {
    recovery.saveGatewayDeviceDraft(owner, {
      ...draft, segments: [{ type: "text", text: "newer text exceeds available quota" }],
    }, session);
    const recovered = recovery.readGatewayDeviceDraft(owner, session);
    assert.deepEqual(recovered.segments, []);
    assert.equal(recovered.exceedsLimit, true);
    assert.equal(recovered.attachments[0].absolutePath, uploaded.absolutePath);
  } finally {
    storagePrototype.setItem = setItem;
  }
});
