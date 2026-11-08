import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function setup(t) {
  const icons = new Proxy({}, { get: () => () => null });
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]: icons,
    "@liveagent/ui/components/markdown/DocumentMarkdown": { DocumentMarkdown: () => null },
  } });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage });
  t.after(() => {
    if (priorStorage) Object.defineProperty(globalThis, "sessionStorage", priorStorage);
    else delete globalThis.sessionStorage;
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); });
  const render = async (node) => env.act(async () => { root.render(node); await tick(); });
  const renderConversation = item => env.React.createElement("button", { "data-conversation": item.id }, item.title);
  const click = async (label) => env.act(async () => {
    const button = [...document.querySelectorAll("button")].find((node) => node.textContent === label);
    assert.ok(button, label); button.click(); await tick();
  });
  const chooseTaskAction = async (label) => {
    await env.act(async () => {
      host.querySelector('button[aria-label="Task actions"]').click();
      await tick();
    });
    await env.act(async () => {
      const item = [...document.querySelectorAll('[role="menuitem"]')]
        .find((node) => node.textContent === label);
      assert.ok(item, label);
      item.click();
      await tick();
    });
  };
  return { env, host, render, click, chooseTaskAction, renderConversation };
}

test("desktop task navigation keeps sources independent and supports local creation without cloud access", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  let localTasks = [{
    id: "local-job", name: "Local report", description: "", type: "prompt",
    cron: "0 0 9 * * *", enabled: true, prompt: "Summarize the project",
  }];
  const writes = [];
  const device = {
    targetId: "local",
    label: "This computer",
    list: async () => ({ tasks: localTasks, next: {} }),
    runs: async () => [],
    save: async (data, id, existing) => {
      writes.push({ id, existing });
      const saved = { ...existing, ...data, id, enabled: existing?.enabled ?? true };
      localTasks = [...localTasks.filter((item) => item.id !== id), saved];
      return saved;
    },
  };
  function Harness({ schedules }) {
    const [route, onNavigate] = app.env.React.useState({ page: "tasks" });
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42,
      route,
      locale: "en-US",
      onNavigate,
      onBack: () => {},
      schedules,
      onRetryCloud: () => {},
      device,
      renderDeviceEditor: ({ task, onSave }) => app.env.React.createElement("button", {
        onClick: () => void onSave({
          name: task ? "Updated device task" : "Created device task",
          description: "",
          type: "prompt",
          prompt: "Local test only",
          cron: "0 30 10 * * 1-5",
        }),
      }, task ? "Save device edit" : "Save new device task"),
      defaultCreationTarget: "local",
      environments: [],
      models: [],
      currentModel: { name: "", model: "", keyId: 0 },
    }));
  }
  await app.render(app.env.React.createElement(Harness, { schedules: null }));
  assert.match(app.host.textContent, /Local report/);
  assert.match(app.host.textContent, /Cloud tasks are unavailable/);
  await app.click("New task");
  await app.click("Save new device task");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].existing, undefined);
  assert.equal(app.host.querySelector('[aria-current="page"]')?.textContent, "Created device taskThis computer · Active");
  await app.click("Open");
  await app.click("Save device edit");
  assert.equal(writes[1].id, writes[0].id);
  assert.match(app.host.textContent, /Updated device task/);
  await app.render(app.env.React.createElement(Harness, { schedules: {
    list: async () => ({ enabled: true, tasks: [{ id: "cloud-job", name: "Cloud report", enabled: false }] }),
  } }));
  const localTask = [...app.host.querySelectorAll("button")].find((button) => button.textContent.includes("Local report"));
  assert.ok(localTask);
  await app.env.act(async () => { localTask.click(); await tick(); });
  assert.equal(localTask.getAttribute("aria-current"), "page");
  assert.match(app.host.textContent, /Cloud report/);
  const details = app.host.querySelector('button[aria-label="Task details"]');
  assert.ok(details);
  await app.env.act(async () => { details.click(); await tick(); });
  assert.match(app.host.textContent, /Run history/);
});

test("device task results resolve the selected run's exact message and retain raw shell output", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const runs = [
    { id: "new-run", runId: "canonical-new", sessionId: "shared-session", state: "done", success: true, startedAt: 2000, output: "New raw output" },
    { id: "old-run", runId: "canonical-old", sessionId: "shared-session", state: "done", success: true, startedAt: 1000, output: "Old raw output" },
  ];
  let releaseFirstRead;
  let oldReads = 0;
  const cancellations = [];
  const device = {
    targetId: "local",
    label: "This computer",
    list: async () => ({
      tasks: [
        { id: "prompt", name: "Prompt task", type: "prompt", prompt: "Scheduled prompt", enabled: true, cron: "0 0 9 * * *" },
        { id: "shell", name: "Shell task", type: "bash", enabled: true, cron: "0 0 9 * * *" },
      ],
      next: {},
    }),
    runs: async (id) => id === "prompt" ? runs : [
      { ...runs[0], id: "shell-run", sessionId: undefined, output: "Raw shell output" },
    ],
    runAnchor: async (task, execution) => {
      assert.equal(task, "prompt");
      if (execution === "old-run" && ++oldReads === 1) {
        await new Promise((resolve) => { releaseFirstRead = resolve; });
      }
      const run = runs.find(({ id }) => id === execution);
      return { sessionId: run.sessionId, runId: run.runId, messageId: `message-${execution}` };
    },
    cancel: async (task, runId) => {
      cancellations.push([task, runId]);
      runs.find((run) => run.runId === runId).state = "expired";
    },
  };
  function Harness({ id, run }) {
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42,
      locale: "en-US",
      route: { page: "tasks", target: "local", id, run },
      onNavigate: () => {},
      onBack: () => {},
      includeCloud: false,
      schedules: null,
      device,
      renderDeviceConversation: (conversationId, result, jump, activity) =>
        app.env.React.createElement("section", {
          "aria-label": "Result conversation",
          "data-jump": jump?.messageId,
          "data-active": activity?.active,
          "data-latest": activity?.run.id,
        }, `${conversationId} ${result.id}`, activity?.cancel &&
          app.env.React.createElement("button", { onClick: activity.cancel }, "Stop from composer")),
      environments: [],
      models: [],
      currentModel: { name: "", model: "", keyId: 0 },
    }));
  }
  await app.render(app.env.React.createElement(Harness, { id: "prompt", run: "old-run" }));
  const result = () => app.host.querySelector('[aria-label="Result conversation"]');
  assert.equal(result()?.textContent, "shared-session old-run");
  assert.equal(result()?.getAttribute("data-jump"), null);
  assert.equal(app.host.querySelector("main"), null, "result opens without a pinned task card");
  await app.render(app.env.React.createElement(Harness, { id: "prompt", run: "new-run" }));
  assert.equal(result()?.getAttribute("data-jump"), "message-new-run");
  await app.env.act(async () => { releaseFirstRead(); await tick(); });
  assert.equal(result()?.getAttribute("data-jump"), "message-new-run");
  await app.render(app.env.React.createElement(Harness, { id: "prompt", run: "old-run" }));
  assert.equal(result()?.getAttribute("data-jump"), "message-old-run");
  await app.render(app.env.React.createElement(Harness, { id: "shell" }));
  assert.equal(result(), null);
  assert.match(app.host.querySelector("main").textContent, /Raw shell output/);
  runs.unshift(
    { id: "other-session", runId: "canonical-other", sessionId: "other", state: "leased", startedAt: 4000 },
    { id: "live-run", runId: "canonical-live", sessionId: "shared-session", state: "leased", startedAt: 3000 },
  );
  await app.render(app.env.React.createElement(Harness, { id: "prompt", run: "old-run" }));
  assert.equal(result()?.getAttribute("data-jump"), "message-old-run");
  assert.equal(result()?.getAttribute("data-active"), "true");
  assert.equal(result()?.getAttribute("data-latest"), "live-run");
  await app.click("Stop from composer");
  assert.deepEqual(cancellations, [["prompt", "canonical-live"]]);
  assert.equal(result()?.getAttribute("data-active"), "false");
  assert.equal(result()?.getAttribute("data-latest"), "live-run");
  assert.equal(result()?.getAttribute("data-jump"), "message-old-run");
});

test("settling a run started from the task card does not jump to its prompt", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = { id: "task", name: "Task", type: "prompt", prompt: "Test", cron: "0 0 9 * * *" };
  let runs = [];
  let anchorReads = 0;
  const device = {
    targetId: "local",
    label: "This computer",
    list: async () => ({ tasks: [task], next: {} }),
    runs: async () => runs,
    runNow: async () => {
      runs = [{ id: "manual", sessionId: "session", runId: "canonical", state: "leased", startedAt: 1000 }];
      return { executionId: "manual", startedAt: 1000 };
    },
    runAnchor: async () => {
      anchorReads++;
      return { sessionId: "session", runId: "canonical", messageId: "prompt" };
    },
  };
  const initialRoute = { page: "tasks", target: "local", id: "task" };
  function Harness({ device, deepLink }) {
    const [route, onNavigate] = app.env.React.useState(
      deepLink ? { ...initialRoute, run: "manual" } : initialRoute,
    );
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42,
      route,
      locale: "en-US",
      device,
      onNavigate,
      onBack: () => {},
      schedules: null,
      includeCloud: false,
      renderDeviceConversation: (_session, _run, jump) =>
        app.env.React.createElement("output", { "data-jump": jump?.messageId }),
      environments: [],
      models: [],
      currentModel: { name: "", model: "", keyId: 0 },
    }));
  }
  await app.render(app.env.React.createElement(Harness, { device }));
  await app.click("Run now");
  assert.ok(app.host.querySelector("output"), "run selected on receipt");
  runs = [{ ...runs[0], state: "done", success: true }];
  await app.render(app.env.React.createElement(Harness, { device: { ...device } }));
  assert.equal(anchorReads, 0, "the live reader's position takes precedence");
  assert.equal(app.host.querySelector("output")?.dataset.jump, undefined);

  await app.render(app.env.React.createElement(Harness, { key: "reopened", device, deepLink: true }));
  assert.equal(anchorReads, 1, "an explicit run link still resolves its prompt");
  assert.equal(app.host.querySelector("output")?.dataset.jump, "prompt");
});

test("cloud task completion preserves live reading and explicit records request their own prompt", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {
    id: "cloud-task", name: "Cloud task", enabled: false, new_conversation: false,
    rule: { frequency: "daily", start: "2026-11-07T09:00", time_zone: "UTC" },
    run: { model: "fixture", content: "Scheduled prompt" },
  };
  const previous = {
    id: "previous", run_id: "previous-run", conversation_id: "result",
    trigger_at: "2026-11-07T09:00:00Z", state: "completed", manual: false,
  };
  const pending = {
    id: "manual", trigger_at: "2026-11-07T10:00:00Z", state: "pending", manual: true,
  };
  let history = [previous];
  const schedules = {
    list: async () => ({ enabled: true, tasks: [task] }),
    runs: async () => ({ runs: history }),
    run: async () => ({ id: "manual" }),
  };
  const reads = [];
  const selections = [];
  const runClient = {
    getRun: async (id) => {
      reads.push(id);
      return { id, conversation_id: "result", user_message_id: `prompt-${id}` };
    },
  };
  function Harness({ client, initialRun }) {
    const [route, onNavigate] = app.env.React.useState({ page: "tasks", id: task.id, run: initialRun });
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42,
      locale: "en-US",
      route,
      onNavigate,
      onBack: () => {},
      schedules: client,
      runClient,
      onSelectConversation: (selection) => selections.push(selection),
      renderConversation: (id) => app.env.React.createElement("output", { "data-conversation": id }),
      environments: [],
      models: [],
      currentModel: { name: "", model: "", keyId: 0 },
    }));
  }
  await app.render(app.env.React.createElement(Harness, { client: schedules }));
  const reader = app.host.querySelector("output");
  const taskNavigation = app.host.querySelector('[aria-label="Scheduled task navigation"]');
  assert.ok(taskNavigation);
  assert.doesNotMatch(taskNavigation.textContent, /Revoke background authorization/);
  assert.equal(reader?.dataset.conversation, "result");
  assert.equal(app.host.querySelector('[aria-label="Task conversation"]'), null);
  await app.chooseTaskAction("Run now");
  assert.equal(app.host.querySelector("output"), reader, "the acceptance receipt retains the reader");
  assert.match(app.host.textContent, /Waiting/);
  assert.equal(selections.at(-1)?.runId, "previous-run");
  history = [pending, previous];
  await app.render(app.env.React.createElement(Harness, { client: { ...schedules } }));
  assert.equal(app.host.querySelector("output"), reader, "admission may take more than one poll");
  await app.env.act(async () => {
    app.host.querySelector('button[aria-label="Task actions"]').click();
    await tick();
  });
  assert.ok([...document.querySelectorAll('[role="menuitem"]')]
    .some((node) => node.textContent === "Cancel this run"));
  history = [{ ...pending, run_id: "manual-run", conversation_id: "result", state: "running" }, previous];
  await app.render(app.env.React.createElement(Harness, { client: { ...schedules } }));
  assert.equal(app.host.querySelector("output"), reader);
  assert.deepEqual(selections.at(-1), { id: "result", runId: "manual-run", followLatest: true, jump: undefined });
  history = [{ ...history[0], state: "completed" }, previous];
  await app.render(app.env.React.createElement(Harness, { client: { ...schedules } }));
  assert.equal(selections.at(-1)?.jump, undefined);
  assert.deepEqual(reads, [], "completion alone must not start a history lookup");

  await app.render(app.env.React.createElement(Harness, { key: "link", client: schedules, initialRun: "previous" }));
  assert.deepEqual(reads, ["previous-run"]);
  const located = selections.at(-1);
  assert.equal(located.followLatest, false);
  assert.equal(located.jump?.messageId, "prompt-previous-run");
  await app.env.act(async () => { located.jump.onUnavailable(); await tick(); });
  assert.match(app.host.textContent, /This run cannot be located/);
});

test("scheduled reply retains the submitted prompt while resuming and isolates accounts", async (t) => {
  const app = await setup(t);
  const { useScheduledRunPreview } = app.env.loadModule("src/components/cloudchat/useScheduledRunPreview.ts");
  const run = { id: "execution", taskId: "task", sessionId: "session", runId: "run", state: "leased" };
  const requests = [];
  const device = {
    targetId: "local",
    runProgress(task, execution, cursor) {
      return new Promise((resolve) => requests.push({ task, execution, cursor, resolve }));
    },
  };
  function Preview({ owner, state }) {
    const preview = useScheduledRunPreview(owner, device, { ...run, state });
    return app.env.React.createElement("output", {
      "data-done": preview?.done,
      "data-prompt": preview?.prompt?.text,
    }, preview?.text);
  }
  const render = (owner, state = "leased") => app.render(app.env.React.createElement(Preview, { owner, state }));
  const finish = (request, chunk) => app.env.act(async () => {
    request.resolve({ sessionId: "session", runId: "run", more: false, done: false, ...chunk });
    await tick();
  });
  await render(42);
  assert.deepEqual(requests.map(({ task, execution, cursor }) => [task, execution, cursor]), [
    ["task", "execution", 0],
  ]);
  await finish(requests[0], {
    cursor: 8,
    text: "",
    more: true,
    prompt: { messageId: "submitted-message", text: "Frozen task instruction" },
  });
  assert.equal(app.host.querySelector("output")?.dataset.prompt, "Frozen task instruction");
  assert.equal(app.host.textContent, "");
  await app.env.act(async () => new Promise((resolve) => setTimeout(resolve, 75)));
  assert.equal(requests[1]?.cursor, 8);
  await finish(requests[1], { cursor: 10, text: "First reply chunk", more: true });
  assert.equal(app.host.textContent, "First reply chunk");
  assert.equal(app.host.querySelector("output")?.dataset.prompt, "Frozen task instruction");
  await app.env.act(async () => new Promise((resolve) => setTimeout(resolve, 75)));
  assert.equal(requests[2]?.cursor, 10);
  await render(73);
  assert.equal(app.host.textContent, "");
  assert.equal(app.host.querySelector("output")?.dataset.prompt, undefined);
  assert.equal(requests[3]?.cursor, 0);
  await finish(requests[2], { cursor: 11, text: "stale content", done: true });
  assert.equal(app.host.textContent, "");
  await finish(requests[3], { cursor: 15, text: "Current reply", done: true });
  await render(73, "done");
  assert.equal(app.host.textContent, "Current reply");
  assert.equal(app.host.querySelector("output")?.dataset.done, "true");
});

test("device task saves reconcile a lost creation reply and preserve live counters or concurrent edits", async (t) => {
  const { env } = await setup(t);
  const { createDeviceScheduleHost } = env.loadModule("src/lib/deviceScheduleHost.ts");
  let tasks = [];
  let revision = 1;
  let loseReply = true;
  let current = true;
  const ops = [];
  const backend = {
    fetchSnapshot: async () => ({ cron: { revision, tasks: structuredClone(tasks) } }),
    cronApply: async ({ baseRevision, ops: [op] }) => {
      assert.equal(baseRevision, revision++);
      ops.push(op);
      if (op.op === "create") tasks.push(op.item);
      if (op.op === "update") tasks = tasks.map((task) => task.id === op.id ? { ...task, ...op.patch } : task);
      if (loseReply) { loseReply = false; throw new Error("lost reply"); }
      return { status: "ok", cron: { revision, tasks: structuredClone(tasks) } };
    },
    canCancelRun: () => false,
  };
  const device = createDeviceScheduleHost({
    backend, targetId: "this-pc", label: "Device", locale: "en-US",
    requireCurrent: () => { if (!current) throw new Error("connection retired"); },
  });
  const data = { name: "Test", description: "", type: "prompt", prompt: "Local task", cron: "0 0 9 * * *", remainingExecutions: 2 };
  await assert.rejects(device.save(data, "job-1"), /lost reply/);
  const existing = await device.save(data, "job-1");
  assert.equal(existing.id, "job-1");
  assert.equal(ops.length, 1);
  tasks[0].remainingExecutions = 1;
  tasks[0].prompt = "Edited on the device";
  await device.save({ ...data, name: "Renamed" }, "job-1", existing);
  assert.deepEqual(Object.keys(ops[1].patch), ["name"]);
  assert.equal(tasks[0].remainingExecutions, 1);
  assert.equal(tasks[0].prompt, "Edited on the device");
  await assert.rejects(device.save({ ...data, prompt: "Stale change" }, "job-1", existing), /changed/);
  current = false;
  await assert.rejects(device.save(data, "job-2"), /retired/);
  assert.equal(ops.length, 2);
});

test("history paging does not jump to a run after a different run has been selected", async (t) => {
  const app = await setup(t);
  const { useTranscriptMessageJump } = app.env.loadModule(
    "../../agent-ui/src/lib/transcript-virtual/useTranscriptMessageJump.ts",
  );
  const latest = { key: "latest", messageId: "new" };
  const older = { key: "older", messageId: "old" };
  const jumps = [];
  const missing = [];
  let completePage;
  let pageReads = 0;
  function Harness({ id }) {
    const [rows, setRows] = app.env.React.useState([latest]);
    useTranscriptMessageJump({
      target: { key: id, messageId: id, onUnavailable: () => missing.push(id) },
      rowKey: rows.find((row) => row.messageId === id)?.key,
      historyBoundary: rows[0].key,
      hasMoreHistory: rows.length === 1,
      loadEarlier: async () => {
        pageReads += 1;
        await new Promise((resolve) => { completePage = resolve; });
        setRows([older, latest]);
      },
      ready: true,
      jumpToRow: (key) => jumps.push(key),
    });
    return null;
  }
  const frame = () => app.env.act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  });
  await app.render(app.env.React.createElement(Harness, { id: "old" }));
  assert.equal(pageReads, 1);
  await app.render(app.env.React.createElement(Harness, { id: "new" }));
  await frame();
  await app.env.act(async () => { completePage(); await tick(); });
  assert.deepEqual(jumps, ["latest"]);
  await app.render(app.env.React.createElement(Harness, { id: "old" }));
  await frame();
  assert.deepEqual(jumps, ["latest", "older"]);
  await app.render(app.env.React.createElement(Harness, { id: "deleted" }));
  assert.deepEqual(missing, ["deleted"]);
});

test("device task deletion waits for an active run and retries against the same task ID", async (t) => {
  const { env } = await setup(t);
  const { createDeviceScheduleHost } = env.loadModule("src/lib/deviceScheduleHost.ts");
  const task = { id: "job-1", name: "Test" };
  let tasks = [task];
  let runs = [{ state: "leased" }];
  const writes = [];
  const device = createDeviceScheduleHost({
    backend: {
      fetchSnapshot: async () => ({ cron: { revision: 7, tasks } }),
      listRuns: async () => runs,
      cronApply: async (input) => {
        writes.push(input);
        tasks = [];
        throw new Error("lost reply");
      },
      canCancelRun: () => false,
    },
    targetId: "this-pc", label: "Device", locale: "en-US", requireCurrent: () => {},
  });
  await assert.rejects(device.remove(task), /active run/);
  assert.equal(writes.length, 0);
  runs = [{ state: "done" }];
  await assert.rejects(device.remove(task), /lost reply/);
  await device.remove(task);
  assert.deepEqual(writes, [{ baseRevision: 7, ops: [{ op: "delete", id: "job-1" }] }]);
});

test("device next run uses authoritative future occurrences and unmixed schedule buckets", async (t) => {
  const { env } = await setup(t);
  const { createDeviceScheduleHost } = env.loadModule("src/lib/deviceScheduleHost.ts");
  const device = createDeviceScheduleHost({
    backend: {
      fetchSnapshot: async () => ({ cron: { tasks: [] } }),
      cronOccurrences: async (from) => ({
        now: from + 15,
        timeZone: "Asia/Hong_Kong",
        occurrences: [{ taskId: "often", at: from + 10 }, { taskId: "normal", at: from + 25 }],
        summaries: [
          { taskId: "often", firstAt: from + 17, planned: 10, ran: 1 },
          { taskId: "often", firstAt: from + 20, planned: 10, ran: 0 },
          { taskId: "past", firstAt: from + 18, planned: 0, ran: 10 },
        ],
      }),
      canCancelRun: () => false,
    },
    targetId: "dev-1", label: "Device", locale: "en-US", requireCurrent: () => {},
  });
  const result = await device.list();
  assert.deepEqual(Object.keys(result.next).sort(), ["normal", "often"]);
  assert.equal(result.next.normal - result.next.often, 5);
  assert.equal(result.timeZone, "Asia/Hong_Kong");
});

test("project edits protect navigation and unload; a retired account cannot confirm old navigation", async (t) => {
  const app = await setup(t);
  const { useUnsavedChangesPrompt } = app.env.loadModule("../../agent-ui/src/application/useUnsavedChangesPrompt.tsx");
  let prompt;
  let navigations = 0;
  function Harness({ account }) {
    prompt = useUnsavedChangesPrompt(account);
    return app.env.React.createElement("div", null,
      app.env.React.createElement("button", { onClick: () => prompt.request(() => navigations++) }, "离开"), prompt.dialog);
  }
  await app.render(app.env.React.createElement(Harness, { account: "a" }));
  prompt.setDirty(true);
  const unload = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  await app.click("离开"); assert.equal(navigations, 0);
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /未保存/);
  await app.click("继续编辑"); assert.equal(navigations, 0);
  await app.click("离开");
  await app.render(app.env.React.createElement(Harness, { account: "b" }));
  await app.env.waitFor(()=>!document.querySelector('[role="alertdialog"]'),'retired account prompt to finish closing');
  assert.equal(Boolean(document.querySelector('[role="alertdialog"]')), false);
  assert.equal(navigations, 0);
  prompt.setDirty(true);
  await app.click("离开"); await app.click("放弃修改并离开");
  assert.equal(navigations, 1);
});

test("deep links retain library filters and skill identity while normalizing legacy chat links", async t => {
  const app = await setup(t);
  const { readCloudChatRoute, cloudChatRouteHref } = app.env.loadModule("src/lib/cloudChatRoute.ts");
  const normalize = path => {
    const url = new URL(path,"http://localhost");
    return cloudChatRouteHref(readCloudChatRoute(url),url);
  };
  assert.equal(normalize("/?conversation=chat-123&oauth=success"),"/c/chat-123");
  assert.equal(normalize("/?conversation=chat-123&settings=system"),"/settings/system");
  assert.equal(normalize("/settings/connections?oauth=success"),"/settings");
  assert.equal(normalize("/space/sites/version-1?folder=folder-1&scope=starred"),
    "/space/sites/version-1?folder=folder-1&scope=starred");
  assert.equal(normalize("/skills?skill_id=skill-creator"),"/skills?skill_id=skill-creator");
  assert.equal(normalize("/plugins/product-design/manage?skill_id=design-qa"),
    "/plugins/product-design/manage?skill_id=design-qa");
  assert.equal(normalize("/c/%2fprivate"),"/");
  assert.equal(normalize("/tasks/job-1?task_status=paused&task_run=run-1&task_target=local"),
    "/tasks/job-1?task_status=paused&task_run=run-1&task_target=local");
  assert.equal(normalize("/tasks?task_status=unknown&task_run=unowned"), "/tasks");
  assert.equal(normalize("/tasks?task_status=paused,enabled"), "/tasks?task_status=enabled%2Cpaused");
  assert.equal(normalize("/tasks?task_status=none"), "/tasks?task_status=none");
  assert.equal(normalize("/tasks/job-1?task_target=local&task_scope=cloud"),
    "/tasks/job-1?task_target=local&task_scope=cloud");
  const deviceHref = "/tasks/job-1?task_run=run-1&task_target=dev-1&task_device=1";
  const deviceURL = new URL(deviceHref, "https://zeroagent.example");
  const deviceTask = readCloudChatRoute(deviceURL);
  assert.equal(deviceTask.deviceView, true);
  assert.equal(deviceTask.target, "dev-1");
  assert.equal(deviceTask.run, "run-1");
  assert.equal(normalize(deviceHref), deviceHref);
  assert.equal(normalize("/tasks/job-1?task_device=1"), "/tasks/job-1");
  assert.equal(cloudChatRouteHref({ page: "chat", id: "" }, deviceURL), "/");
  const { readCloudChatLocation } = app.env.loadModule("src/lib/useCloudChatHistory.ts");
  window.history.replaceState({ zeroagentCloudRoute: { owner: 1, index: 1, conversation: "private" } }, "", "/c/private");
  assert.deepEqual(readCloudChatLocation(2), { route: { page: "chat", id: "" }, conversation: "" });
});

test("Back from dirty project settings keeps its URL until navigation is confirmed", async t => {
  const app = await setup(t);
  const { useCloudChatHistory } = app.env.loadModule("src/lib/useCloudChatHistory.ts");
  const { useUnsavedChangesPrompt } = app.env.loadModule("../../agent-ui/src/application/useUnsavedChangesPrompt.tsx");
  let guard;
  function Harness() {
    const [route,setRoute] = app.env.React.useState({ page: "chat", id: "" });
    guard = useUnsavedChangesPrompt(1);
    useCloudChatHistory({
      owner: 1, active: true, route, conversation: "",
      apply: ({route}) => setRoute(route),
      isDirty: guard.isDirty, confirm: guard.request,
    });
    return app.env.React.createElement("div", null,
      app.env.React.createElement("button", { onClick: () => setRoute({ page: "projects", id: "p1" }) }, "项目设置"),
      guard.dialog,
    );
  }
  await app.render(app.env.React.createElement(Harness));
  await app.click("项目设置");
  guard.setDirty(true);
  window.history.back();
  await app.env.waitFor(() => document.querySelector('[role="alertdialog"]'),"history leave prompt");
  assert.equal(window.location.pathname,"/projects/p1");
  await app.click("继续编辑");
  assert.equal(window.location.pathname,"/projects/p1");
  await app.env.waitFor(() => !document.querySelector('[role="alertdialog"]'),"first history prompt to close");
  window.history.back();
  await app.env.waitFor(() => document.querySelector('[role="alertdialog"]'),"second history leave prompt");
  await app.click("放弃修改并离开");
  await app.env.waitFor(() => window.location.pathname === "/","confirmed history destination");
});

test("the same resource shell renders an accessible full page without a modal or backdrop", async (t) => {
  const app = await setup(t);
  const { CloudChatResourcePanel, CloudChatResourcePresentation } = app.env.loadModule("src/components/cloudchat/CloudChatResourcePanel.tsx");
  let closed = 0;
  await app.render(app.env.React.createElement(CloudChatResourcePresentation.Provider, { value: "page" },
    app.env.React.createElement(CloudChatResourcePanel, { title: "文件库", description: "账户资料", onClose: () => closed++ }, "受保护的资料内容")));
  assert.ok(app.host.querySelector('[data-cloud-resource-page]'));
  assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
  assert.equal(Boolean(document.querySelector('[data-slot="sheet-backdrop"]')), false);
  await app.click("返回对话"); assert.equal(closed, 1);
});

test("a project list arriving after account retirement never enters the navigation", async (t) => {
  const app = await setup(t);
  const { CloudChatProjectNavigation } = app.env.loadModule("src/components/cloudchat/CloudChatProjectNavigation.tsx");
  let retired = false, finish;
  const client = { listProjects: () => new Promise((resolve) => { finish = resolve; }) };
  const captureGuard = () => () => { if (retired) throw new Error("retired account"); };
  await app.render(app.env.React.createElement(CloudChatProjectNavigation, { client, captureGuard, revision: 0, onOpen() {}, onCreate() {}, renderConversation: app.renderConversation }));
  retired = true;
  await app.env.act(async () => { finish({ items: [{ id: "private-a", name: "PRIVATE_PROJECT_A" }] }); await tick(); });
  assert.doesNotMatch(app.host.textContent, /PRIVATE_PROJECT_A/);
});


test("new-project shortcuts use the creation dialog callback while existing projects keep their own navigation",async(t)=>{
 const app=await setup(t),opened=[];let created=0;
 const {CloudChatProjectNavigation}=app.env.loadModule("src/components/cloudchat/CloudChatProjectNavigation.tsx");
 await app.render(app.env.React.createElement(CloudChatProjectNavigation,{client:{listProjects:async()=>({items:[]})},captureGuard:()=>()=>{},revision:0,onOpen:id=>opened.push(id),onCreate:()=>created++,renderConversation:app.renderConversation}));
 await app.env.act(async()=>{document.querySelector('button[aria-label="新建项目"]').click();await tick();});
 await app.click("创建第一个项目");assert.equal(created,2);assert.deepEqual(opened,[]);
});

test("project groups load on expansion, retain collapse state, highlight and open their own conversations", async t => {
 const app=await setup(t),opened=[],created=[];let reads=0;
 const {CloudChatProjectNavigation}=app.env.loadModule("src/components/cloudchat/CloudChatProjectNavigation.tsx");
 const project={id:"p",name:"研发项目"};
 const client={listProjects:async()=>({items:[project]}),listConversations:async()=>{reads++;return {items:[{conversation_id:"c",created_at:"2026-11-01",conversation:{title:"项目内的方案",updated_at:"2026-11-01"}},{conversation_id:"archived",conversation:{title:"归档内容",archived:true}}],next_before_id:""};}};
 const registrations=[];
 const props={client,captureGuard:()=>()=>{},revision:0,onOpen(){},onCreate(){},onNewConversation:p=>created.push(p.id),renderConversation:item=>app.env.React.createElement("button",{"aria-current":item.id==="c"?"page":undefined,onClick:()=>opened.push(item.id)},item.title),onVisibleConversationsChange:(id,items)=>registrations.push([id,items]),currentConversationId:"c"};
 await app.render(app.env.React.createElement(CloudChatProjectNavigation,props));assert.equal(reads,0);
 await app.click("研发项目");assert.equal(reads,1);assert.doesNotMatch(app.host.textContent,/归档内容/);
 assert.equal(app.host.querySelector('.cloud-project-conversation [aria-current="page"]').textContent,"项目内的方案");
 assert.deepEqual(registrations.at(-1)[1].map(item=>item.id),["c"]);
 await app.click("项目内的方案");assert.deepEqual(opened,["c"]);
 await app.env.act(async()=>{app.host.querySelector('[aria-label="在研发项目中新建对话"]').click();await tick();});assert.deepEqual(created,["p"]);
 await app.click("研发项目");assert.equal(app.host.querySelector('.cloud-project-disclosure').getAttribute('aria-hidden'),"true");
 assert.deepEqual(registrations.at(-1),["p",[]]);
 await app.click("研发项目");assert.equal(reads,1);
});

test("a selected project outside the first five is revealed, and late membership reads are retired", async t => {
 const app=await setup(t);let finish,retired=false;
 const {CloudChatProjectNavigation}=app.env.loadModule("src/components/cloudchat/CloudChatProjectNavigation.tsx");
 const client={listProjects:async()=>({items:Array.from({length:6},(_,i)=>({id:`p${i}`,name:`项目${i}`}))}),listConversations:()=>new Promise(resolve=>finish=resolve)};
 await app.render(app.env.React.createElement(CloudChatProjectNavigation,{client,captureGuard:()=>()=>{if(retired)throw Error('retired');},revision:0,activeProjectId:"p5",onOpen(){},onCreate(){},renderConversation:app.renderConversation}));
 assert.equal([...app.host.querySelectorAll('[aria-expanded="true"]')][0].textContent,"项目5");
 retired=true;await app.env.act(async()=>{finish({items:[{conversation_id:"private",conversation:{title:"PRIVATE_MEMBER"}}],next_before_id:""});await tick();});
 assert.doesNotMatch(app.host.textContent,/PRIVATE_MEMBER/);
});

test("task chrome stays in the conversation column when the result reader opens", async (t) => {
  const app = await setup(t);
  const { React, act } = app.env;
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { CloudChatResourceWorkbench } = app.env.loadModule("src/components/cloudchat/CloudChatResourceWorkbench.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {
    id: "report", name: "Daily report", enabled: false,
    rule: { frequency: "daily", start: "2026-11-10T09:00", time_zone: "UTC" },
    run: { content: "Read the report" },
  };
  const run = { id: "run", run_id: "cloud-run", conversation_id: "result", state: "completed", trigger_at: "2026-11-10T09:00:00Z" };
  const schedules = {
    list: async () => ({ enabled: true, tasks: [task] }),
    runs: async () => ({ runs: [run] }),
  };
  const prototype = window.HTMLElement.prototype;
  const bounds = prototype.getBoundingClientRect;
  prototype.getBoundingClientRect = function() {
    return this.classList.contains("cloud-resource-workbench")
      ? { width: 1150, height: 700, top: 0, left: 0, right: 1150, bottom: 700 }
      : bounds.call(this);
  };
  t.after(() => { prototype.getBoundingClientRect = bounds; });
  const noop = () => {};
  function Harness({ open }) {
    return React.createElement(SidebarProvider, null,
      React.createElement(CloudScheduleWorkspace, {
        owner: 42, route: { page: "tasks", id: task.id }, onNavigate: noop, onBack: noop,
        locale: "en-US", schedules, environments: [], models: [],
        currentModel: { name: "", model: "", keyId: 0 },
        renderConversation: (_id, onChromeTarget) => React.createElement(CloudChatResourceWorkbench, {
          open, primaryVisible: true, onSplitAvailabilityChange: noop, headerInFlow: true,
          header: React.createElement("div", { ref: onChromeTarget, "data-task-result-chrome": "" }),
          primary: React.createElement("textarea", { defaultValue: "Keep this draft" }),
        }, open ? React.createElement("section", { "data-test-reader": "" }, "Saved report") : null),
      }));
  }
  await app.render(React.createElement(Harness, { open: false }));
  const primary = app.host.querySelector(".cloud-workspace-primary");
  const draft = primary.querySelector("textarea");
  const header = primary.querySelector("header");
  assert.ok(header.querySelector('button[aria-label="Task actions"]'));
  await act(async () => {
    header.querySelector('button[aria-label="Task details"]').click();
    await tick();
  });
  const details = primary.querySelector('aside[aria-label="Task details"]');
  assert.ok(details);
  await app.render(React.createElement(Harness, { open: true }));
  const reader = app.host.querySelector("[data-test-reader]");
  assert.equal(reader.parentElement, primary.parentElement);
  assert.equal(primary.querySelector("header"), header);
  assert.equal(primary.querySelector("aside"), details);
  assert.equal(primary.querySelector("textarea"), draft);
  assert.equal(draft.value, "Keep this draft");
});
