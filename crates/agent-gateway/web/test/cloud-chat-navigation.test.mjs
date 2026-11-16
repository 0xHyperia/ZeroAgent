import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function setup(t, showMarkdown = false) {
  const icons = new Proxy({}, { get: () => () => null });
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]: icons,
    "@liveagent/ui/components/markdown/DocumentMarkdown": {
      DocumentMarkdown: ({ content }) => showMarkdown ? content : null,
    },
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

test("cloud approval reviews the frozen input and checks the original receipt after history changes", async (t) => {
  const app = await setup(t, true);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const rule = { frequency: "daily", start: "2026-11-08T08:00", time_zone: "Asia/Hong_Kong" };
  const plan = {
    id: "briefing", name: "Editorial task", enabled: true, notification: "none",
    revision: 3, admitted: 0, next_at: null, latest_state: "awaiting_approval",
    rule, run: { model: "new-model", content: "Edited plan content" },
  };
  const older = { id: "older", state: "completed", trigger_at: "2026-11-08T00:00:00Z", manual: false, output: "Saved earlier run" };
  const pending = {
    id: "needs-review", state: "awaiting_approval", trigger_at: "2026-11-08T00:05:00Z", manual: true,
    approval: {
      rule, run: {
        model: "frozen-model",
        content: [{type:"text",text:"Original instructions for this run"}, {type:"file_reference",file_id:"source"}],
        public_research: {topic:"Confirmed public topic"},
      },
    },
  };
  let runs = [older, pending], receipt = "pending", finishWrite;
  const actions = [];
  const schedules = {
    list: async () => ({enabled:true,tasks:[plan]}),
    runs: async () => ({runs}),
    decide: (task, run, decision) => {
      actions.push(["POST", task, run, decision]);
      return new Promise((_, reject) => { finishWrite = () => reject(new Error("lost reply")); });
    },
    readApprovalDecision: async (task, run) => {
      actions.push(["GET", task, run]);
      return {decision:receipt};
    },
  };
  let currentRoute;
  function Harness({ run }) {
    const [route, onNavigate] = app.env.React.useState({page:"tasks",id:plan.id,run});
    currentRoute = route;
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner:42, route, onNavigate, onBack() {}, locale:"en-US", schedules, environments:[],
      models:[], currentModel:{name:"",model:"",keyId:0},
    }));
  }
  const render = run => app.render(app.env.React.createElement(Harness, {run}));
  await render(older.id);
  assert.match(app.host.querySelector('[aria-current="page"]').textContent,/Awaiting approval/);
  assert.match(app.host.textContent,/Saved earlier run/);
  await app.click("Review pending run");
  assert.equal(currentRoute.run,pending.id);
  assert.equal(document.activeElement.textContent,"Review this run");
  assert.match(app.host.textContent,/Original instructions for this run.*frozen-model.*Attached resources1.*Confirmed public topic/);
  assert.doesNotMatch(app.host.textContent,/Edited plan content|new-model/);

  await app.click("Approve this run");
  await app.click("Approve this run");
  assert.deepEqual(actions,[["POST",plan.id,pending.id,"approve"]]);
  await app.env.act(async () => { finishWrite(); await tick(); });
  assert.match(app.host.textContent,/The decision is unconfirmed/);
  await app.click("Check decision");
  assert.match(app.host.textContent,/This run still awaits approval/);
  assert.deepEqual(actions.at(-1),["GET",plan.id,pending.id]);
  await app.click("Approve this run");
  await app.env.act(async () => { finishWrite(); await tick(); });

  await app.render(null);
  runs = [older, {...pending,state:"needs_attention",approval:undefined}];
  receipt = "approve";
  await render(pending.id);
  assert.match(app.host.textContent,/Approval receipt/);
  assert.match(app.host.textContent,/Needs attention/);
  await app.click("Check decision");
  assert.match(app.host.textContent,/Approval recorded.*Execution status updates separately/);
  assert.match(app.host.textContent,/Needs attention/);
  assert.deepEqual(actions,[
    ["POST",plan.id,pending.id,"approve"], ["GET",plan.id,pending.id],
    ["POST",plan.id,pending.id,"approve"], ["GET",plan.id,pending.id],
  ]);
});

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
  await app.click("Edit task");
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
  const inspector = app.host.querySelector('aside[aria-label="Task details"]');
  assert.match(inspector.textContent, /Scheduled task.*Local report/);
  assert.doesNotMatch(inspector.textContent, /Run history/);
});

test("the task landing distinguishes reading, unavailable, filtered, and first-task states", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  let finishRead;
  let failRead;
  let reads = 0;
  let writes = 0;
  const schedules = {
    list: () => {
      reads++;
      return new Promise((resolve, reject) => {
        finishRead = resolve;
        failRead = reject;
      });
    },
    create: () => { writes++; },
    preview: async () => ({ next: "2026-11-08T10:00:00Z" }),
  };
  function Harness({ client }) {
    const [route, onNavigate] = app.env.React.useState({ page: "tasks", status: "paused" });
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, route, onNavigate, locale: "en-US", onBack: () => {}, schedules: client,
      environments: [], models: [], currentModel: { name: "", model: "", keyId: 0 },
    }));
  }
  const heading = () => app.host.querySelector("h2")?.textContent;
  await app.render(app.env.React.createElement(Harness, { client: schedules }));
  assert.equal(heading(), "Loading tasks");
  assert.equal(app.host.textContent.includes("No matching tasks"), false);
  await app.env.act(async () => { failRead(new Error("temporary failure")); await tick(); });
  assert.equal(heading(), "Tasks are temporarily unavailable");
  assert.equal(app.host.textContent.includes("No matching tasks"), false);
  await app.click("Retry loading tasks");
  assert.equal(reads, 2);
  assert.equal(heading(), "Loading tasks");
  await app.env.act(async () => {
    finishRead({ enabled: true, tasks: [{ id: "active", name: "Morning report", enabled: true, rule: {} }] });
    await tick();
  });
  assert.equal(heading(), "No matching tasks");
  await app.click("Clear filters");
  assert.equal(heading(), "Schedule tasks");
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Filter tasks");
  assert.match(app.host.textContent, /Morning report/);
  assert.equal(app.host.querySelectorAll(".conversation-starter").length, 6);

  await app.render(app.env.React.createElement(Harness, {
    client: { ...schedules, list: async () => ({ enabled: true, tasks: [] }) },
  }));
  assert.equal(heading(), "Schedule a task");
  const starters = app.host.querySelectorAll(".conversation-starter");
  assert.equal(starters.length, 6);
  await app.env.act(async () => { starters[0].click(); await tick(); });
  assert.equal(document.querySelector("[role=dialog] textarea")?.value, "Summarize notable public technology news from the past day, with sources.");
  assert.equal(writes, 0);
});

test("task status groups collapse and running an unselected task waits for its own history", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {
    id: "report", name: "Daily report", enabled: false,
    rule: { frequency: "daily", start: "2026-11-10T09:00", time_zone: "UTC" },
    run: { content: "Read the report" },
  };
  let resolveHistory;
  const history = new Promise((resolve) => { resolveHistory = resolve; });
  const writes = [];
  const schedules = {
    list: async () => ({ enabled: true, tasks: [task] }),
    runs: (id) => {
      assert.equal(id, task.id);
      return history;
    },
    run: async (id, request) => {
      writes.push([id, request]);
      return { id: "manual-run" };
    },
  };
  let route;
  function Harness() {
    const [current, onNavigate] = app.env.React.useState({ page: "tasks" });
    route = current;
    return app.env.React.createElement(SidebarProvider, null,
      app.env.React.createElement(CloudScheduleWorkspace, {
        owner: 42, route, onNavigate, onBack() {}, locale: "en-US", schedules,
        environments: [], models: [], currentModel: { name: "", model: "", keyId: 0 },
      }));
  }
  await app.render(app.env.React.createElement(Harness));
  const group = app.host.querySelector('button[data-sidebar="group-label"]');
  const list = group.nextElementSibling;
  await app.click("Paused");
  assert.equal(group.getAttribute("aria-expanded"), "false");
  assert.equal(list.hidden, true);
  await app.click("Paused");
  assert.equal(list.hidden, false);
  await app.env.act(async () => {
    app.host.querySelector('button[aria-label="Actions for Daily report"]').click();
    await tick();
  });
  await app.env.act(async () => {
    const run = [...document.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent === "Run now");
    assert.ok(run);
    run.click();
    await tick();
  });
  assert.equal(route.id, task.id);
  assert.deepEqual(writes, []);
  await app.env.act(async () => { resolveHistory({ runs: [] }); await tick(); });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], task.id);
  assert.equal(route.run, "manual-run");
});

test("device task results resolve the selected run's exact message and retain raw shell output", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const runs = [
    { id: "new-run", runId: "canonical-new", sessionId: "shared-session", state: "done", success: true, startedAt: 2000, output: "New raw output" },
    { id: "old-run", runId: "canonical-old", sessionId: "shared-session", state: "done", success: true, startedAt: 1000, output: "Old raw output" },
    { id: "missing-anchor", runId: "canonical-missing", sessionId: "shared-session", state: "done", success: true, startedAt: 900, output: "Stored fallback result" },
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
      return { sessionId: run.sessionId, runId: run.runId, messageId: execution === "missing-anchor" ? undefined : `message-${execution}` };
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
  await app.render(app.env.React.createElement(Harness, { id: "prompt", run: "missing-anchor" }));
  assert.match(app.host.querySelector("main").textContent, /Stored fallback result/);
  await app.render(app.env.React.createElement(Harness, { id: "shell" }));
  assert.equal(result(), null);
  assert.match(app.host.querySelector("main").textContent, /Raw shell output/);
  const details = app.host.querySelector('button[aria-label="Task details"]');
  await app.env.act(async () => { details.click(); await tick(); });
  const inspector = app.host.querySelector('aside[aria-label="Task details"]');
  assert.match(inspector.textContent, /Scheduled task.*Shell task/);
  assert.equal(inspector.querySelector("summary, pre"), null);
  assert.doesNotMatch(inspector.textContent, /Run history|Clear finished runs|Outputs/);
  assert.match(app.host.querySelector("main").textContent, /Raw shell output/);
  await app.env.act(async () => { details.click(); await tick(); });
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
    runNowOnce: async (_taskId, executionId) => {
      runs = [{ id: executionId, sessionId: "session", runId: "canonical", state: "leased", startedAt: 1000 }];
      return { status: "admitted", executionId, startedAt: 1000 };
    },
    runAnchor: async () => {
      anchorReads++;
      return { sessionId: "session", runId: "canonical", messageId: "prompt" };
    },
  };
  const initialRoute = { page: "tasks", target: "local", id: "task" };
  function Harness({ device, deepLink }) {
    const [route, onNavigate] = app.env.React.useState(
      deepLink ? { ...initialRoute, run: runs[0].id } : initialRoute,
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

test("a lost device run reply is checked by its original identity after remount without another write", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = { id: "task", name: "Task", type: "bash", cron: "0 0 9 * * *" };
  let started;
  const writes = [];
  const reads = [];
  const navigations = [];
  let admitted = false;
  const device = {
    targetId: "local", label: "This computer",
    list: async () => ({ tasks: [task], next: {} }),
    runs: async () => [{ id: "unrelated", state: "done", counted: false, startedAt: Date.now(), output: "unrelated" }],
    runNowOnce: async (taskId, executionId) => {
      started = executionId;
      writes.push([taskId, executionId]);
      throw new Error("lost after sending");
    },
    readRunReceipt: async (taskId, executionId) => {
      reads.push([taskId, executionId]);
      return admitted ? { status: "admitted", executionId, startedAt: 1000 } : { status: "missing" };
    },
  };
  const render = (key) => app.render(app.env.React.createElement(SidebarProvider, { key },
    app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, route: { page: "tasks", target: "local", id: "task" }, locale: "en-US",
      device, onNavigate: (route) => navigations.push(route), onBack: () => {},
      schedules: null, includeCloud: false, environments: [], models: [],
      currentModel: { name: "", model: "", keyId: 0 },
    })));
  await render("original");
  await app.click("Run now");
  assert.match(started, /^manual-[a-f0-9-]{36}$/);
  assert.match(app.host.textContent, /Run result unconfirmed/);
  assert.deepEqual(navigations, []);
  await render("reopened");
  await app.click("Check run");
  assert.match(app.host.textContent, /The device has no receipt/);
  assert.match(app.host.textContent, /Stop checking/);
  assert.deepEqual(navigations, []);
  admitted = true;
  await app.click("Check run");
  assert.deepEqual(writes, [["task", started]]);
  assert.deepEqual(reads, [["task", started], ["task", started]]);
  assert.deepEqual(navigations.map((route) => route.run), [started]);
  assert.doesNotMatch(app.host.textContent, /Run result unconfirmed/);
});

test("an admitted device run waits for its own record without offering another submit", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = { id: "task", name: "Device report", type: "prompt", prompt: "Later device plan instructions", cron: "0 0 9 * * *", enabled: true };
  const previous = { id: "previous", state: "done", startedAt: 1000, output: "Previous execution output" };
  const writes = [];
  let route;
  let currentId;
  let failRead;
  let available = false;
  const device = {
    targetId: "local", label: "This computer",
    list: async () => ({ tasks: [task], next: {} }),
    runs: async () => {
      if (!currentId) return [previous];
      if (available) return [
        { id: currentId, state: "done", startedAt: 2000, counted: false, output: "Current execution output" },
        previous,
      ];
      return new Promise((_, reject) => { failRead = reject; });
    },
    runNowOnce: async (taskId, executionId) => {
      writes.push([taskId, executionId]);
      currentId = executionId;
      return { status: "admitted", executionId, startedAt: 2000 };
    },
  };
  function Harness() {
    const [current, onNavigate] = app.env.React.useState({ page: "tasks", target: device.targetId, id: task.id });
    route = current;
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, route, locale: "en-US", device, onNavigate, onBack: () => {},
      schedules: null, includeCloud: false, environments: [], models: [],
      currentModel: { name: "", model: "", keyId: 0 },
    }));
  }
  const findButton = (label) => [...app.host.querySelectorAll("button")].find((button) => button.textContent === label);
  await app.render(app.env.React.createElement(Harness));
  await app.click("Run now");
  assert.equal(route.run, currentId);
  assert.match(app.host.textContent, /The device accepted this run.*Waiting for the device/);
  assert.doesNotMatch(app.host.textContent, /Previous execution output/);
  assert.equal(findButton("Run now"), undefined);
  await app.env.waitFor(() => failRead, "first post-admission history read");
  await app.env.act(async () => { failRead(new Error("offline")); await tick(); });
  assert.match(app.host.textContent, /The device accepted this run.*The record for this run is temporarily unavailable/);
  assert.equal(findButton("Run now"), undefined);
  const retry = findButton("Retry selected run");
  assert.ok(retry);
  available = true;
  await app.env.act(async () => { retry.focus(); retry.click(); await tick(); });
  const result = app.host.querySelector('[aria-label="Run result"]');
  const plan = app.host.querySelector('[aria-label="Current plan"]');
  assert.match(result.textContent, /Manual trigger.*Current execution output/);
  assert.ok(result.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.doesNotMatch(app.host.textContent, /Later device plan instructions/);
  assert.doesNotMatch(app.host.textContent, /Previous execution output|The device accepted this run/);
  assert.equal(route.run, currentId);
  assert.equal(document.activeElement.textContent, task.name);
  assert.deepEqual(writes, [[task.id, currentId]]);
});

test("a late device receipt leaves the selected run and workbench navigation alone", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = { id: "task", name: "Task", type: "bash", cron: "0 0 9 * * *" };
  const navigations = [];
  const pending = [];
  let started;
  const respond = (executionId) => new Promise((resolve) => {
    pending.push(() => resolve({ status: "admitted", executionId, startedAt: 1000 }));
  });
  const device = {
    targetId: "local", label: "This computer",
    list: async () => ({ tasks: [task], next: {} }),
    runs: async () => [{ id: "previous", state: "done", startedAt: 2, output: "Previous output" }],
    runNowOnce: async (_taskId, executionId) => {
      started = executionId;
      return respond(executionId);
    },
    readRunReceipt: async (_taskId, executionId) => respond(executionId),
  };
  const render = (run) => app.render(app.env.React.createElement(SidebarProvider, null,
    app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, route: { page: "tasks", target: "local", id: "task", run }, locale: "en-US",
      device, onNavigate: (route) => navigations.push(route), onBack: () => {},
      schedules: null, includeCloud: false, environments: [], models: [],
      currentModel: { name: "", model: "", keyId: 0 },
    })));
  const answer = () => app.env.act(async () => { pending.shift()(); await tick(); });
  await render();
  await app.click("Run now");
  await render("previous");
  await answer();
  assert.match(app.host.textContent, /Previous output/);
  assert.deepEqual(navigations, []);

  await app.click("Check run");
  await app.render(null);
  await answer();
  assert.deepEqual(navigations, []);

  await render();
  await app.click("Check run");
  await answer();
  assert.deepEqual(navigations.map((route) => route.run), [started]);
});

test("cloud task cancellation targets the selected run and preserves live reading", async (t) => {
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
  const cancellations = [];
  const schedules = {
    list: async () => ({ enabled: true, tasks: [task] }),
    runs: async () => ({ runs: history }),
    run: async () => ({ id: "manual" }),
    readRun: (_task, _occurrence, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    cancel: async (id) => {
      cancellations.push(id);
      history = [{ ...history[0], state: "cancelling" }, previous];
    },
    cancelPending: () => assert.fail("An admitted occurrence must be cancelled by its Cloud Run ID"),
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
  const cancelAction = () => [...document.querySelectorAll('[role="menuitem"]')]
    .find((node) => node.textContent === "Cancel this run");
  assert.ok(cancelAction());
  history = [{ ...pending, run_id: "manual-run", conversation_id: "result", state: "running" }, previous];
  await app.render(app.env.React.createElement(Harness, { client: { ...schedules } }));
  assert.equal(app.host.querySelector("output"), reader);
  assert.deepEqual(selections.at(-1), { id: "result", runId: "manual-run", occurrenceId: pending.id, followLatest: true, jump: undefined });
  assert.ok(cancelAction(), "admission must not remove the exact cancellation action");
  await app.env.act(async () => { cancelAction().click(); await tick(); });
  assert.deepEqual(cancellations, ["manual-run"]);
  assert.match(app.host.textContent, /Cancelling/);
  history = [{ ...history[0], state: "cancelled" }, previous];
  await app.render(app.env.React.createElement(Harness, { client: { ...schedules } }));
  assert.equal(app.host.querySelector("output"), reader);
  assert.match(app.host.textContent, /Cancelled/);
  assert.equal(selections.at(-1)?.jump, undefined);
  assert.deepEqual(reads, [], "settlement alone must not start a history lookup");

  history = [{ ...pending, id: "another", run_id: "another-run", conversation_id: "result", state: "running" }, ...history];
  await app.render(app.env.React.createElement(Harness, { key: "link", client: schedules, initialRun: "previous" }));
  assert.deepEqual(reads, ["previous-run"]);
  const located = selections.at(-1);
  assert.equal(located.followLatest, false);
  assert.equal(located.jump?.messageId, "prompt-previous-run");
  await app.env.act(async () => { app.host.querySelector('button[aria-label="Task actions"]').click(); await tick(); });
  assert.ok(document.querySelector('[role="menuitem"]'));
  assert.equal(cancelAction(), undefined, "a terminal occurrence cannot cancel another run in the same conversation");
  await app.env.act(async () => { located.jump.onUnavailable(); await tick(); });
  assert.match(app.host.textContent, /This run cannot be located/);
});

test("an accepted cloud run can retry its exact record without remounting the result draft", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = { id: "task", name: "Daily report", enabled: true, rule: { time_zone: "UTC" }, run: { content: "Task instructions" } };
  const previous = {
    id: "previous", state: "completed", trigger_at: "2040-01-01T08:00:00Z",
    run_id: "previous-run", conversation_id: "result",
  };
  const admitted = {
    ...previous, id: "admitted", state: "running", run_id: "admitted-run",
    trigger_at: "2040-01-01T09:00:00Z", manual: true,
  };
  const submissions = [], reads = [], selections = [];
  let route;
  let finishRetry;
  const schedules = {
    list: async () => ({ enabled: true, tasks: [task] }),
    runs: async () => ({ runs: [previous] }),
    run: async (id, request) => { submissions.push([id, request]); return { id: admitted.id }; },
    readRun: async (taskId, runId) => {
      reads.push([taskId, runId]);
      if (reads.length === 1) throw new Error("synthetic history outage");
      return new Promise((resolve) => { finishRetry = () => resolve({ run: admitted }); });
    },
  };
  function Harness() {
    const [current, onNavigate] = app.env.React.useState({ page: "tasks", id: task.id });
    route = current;
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, route, locale: "en-US", onBack: () => {}, schedules, onNavigate,
      environments: [], models: [], currentModel: { name: "", model: "", keyId: 0 },
      onSelectConversation: (selection) => selections.push(selection),
      renderConversation: () => app.env.React.createElement("textarea", { defaultValue: "Unsent follow-up" }),
    }));
  }
  await app.render(app.env.React.createElement(Harness));
  const draft = app.host.querySelector("textarea");
  assert.ok(draft);
  await app.chooseTaskAction("Run now");
  assert.equal(route.run, admitted.id);
  assert.match(app.host.textContent, /The cloud accepted this run.*Couldn't read the selected run/);
  assert.equal(selections.at(-1).runId, previous.run_id);
  assert.equal(app.host.querySelector("textarea"), draft);
  const retry = [...app.host.querySelectorAll("button")].find((button) => button.textContent === "Retry selected run");
  assert.ok(retry);
  await app.env.act(async () => { retry.focus(); retry.click(); await tick(); });
  assert.equal(app.host.querySelector("textarea"), draft);
  assert.equal(selections.at(-1).runId, previous.run_id);
  assert.deepEqual(reads, [[task.id, admitted.id], [task.id, admitted.id]]);
  assert.equal(submissions.length, 1);
  await app.env.act(async () => { finishRetry(); await tick(); });
  assert.doesNotMatch(app.host.textContent, /The cloud accepted this run/);
  assert.equal(route.run, admitted.id);
  assert.equal(app.host.querySelector("textarea"), draft);
  assert.equal(draft.value, "Unsent follow-up");
  assert.equal(selections.at(-1).runId, admitted.run_id);
  assert.equal(document.activeElement.textContent, task.name);
});

test("a historical cloud run deep link reads the exact record outside the recent page", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { ScheduleRequestError } = app.env.loadModule("src/lib/cloudSchedules.ts");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {
    id: "task", name: "Scheduled report", enabled: false, new_conversation: true,
    rule: { frequency: "daily", start: "2026-11-07T09:00", time_zone: "UTC" },
    run: { model: "fixture", content: "Current schedule prompt" },
  };
  const recent = { id: "recent", run_id: "recent-run", conversation_id: "recent-chat", state: "completed", manual: false, trigger_at: "2026-11-07T09:00:00Z" };
  const old = { ...recent, id: "old", run_id: "old-run", conversation_id: "old-chat", trigger_at: "2026-10-01T09:00:00Z" };
  const reads = [], selections = [], navigations = [];
  let pendingRead;
  const schedules = {
    list: async () => ({ enabled: true, tasks: [task] }),
    runs: async () => ({ runs: [recent] }),
    readRun: async (taskId, runId, signal) => {
      reads.push([taskId, runId]);
      if (runId === "unavailable") throw new ScheduleRequestError("missing", 404);
      if (runId === "slow") return new Promise((resolve) => { pendingRead = { resolve, signal }; });
      if (reads.length === 1) throw new ScheduleRequestError("offline", 503);
      return { run: old };
    },
  };
  const runClient = { getRun: async (id) => ({ id, conversation_id: id === old.run_id ? old.conversation_id : recent.conversation_id, user_message_id: id === old.run_id ? "old-prompt" : "recent-prompt" }) };
  const show = (run, owner = 42) => app.render(app.env.React.createElement(SidebarProvider, null,
    app.env.React.createElement(CloudScheduleWorkspace, {
      owner, locale: "en-US", route: { page: "tasks", id: task.id, run }, schedules, runClient,
      onNavigate: (route) => navigations.push(route), onBack() {},
      onSelectConversation: (value) => selections.push(value),
      renderConversation: (id) => app.env.React.createElement("output", { "data-conversation": id }),
      environments: [], models: [], currentModel: { name: "", model: "", keyId: 0 },
    })));
  await show("old");
  assert.match(app.host.textContent, /Couldn't read the selected run/);
  assert.equal(app.host.querySelector("output"), null);
  await app.click("Retry selected run");
  await app.env.waitFor(() => selections.some((selection) => selection.jump?.messageId === "old-prompt"), "exact prompt");
  assert.equal(app.host.querySelector("output").dataset.conversation, "old-chat");
  assert.deepEqual(reads, [[task.id, "old"], [task.id, "old"]]);
  assert.deepEqual(navigations, []);
  await show("unavailable");
  assert.match(app.host.textContent, /The selected run is unavailable/);
  assert.equal(app.host.querySelector("output"), null);
  assert.doesNotMatch(app.host.textContent, /Current schedule prompt/);
  assert.equal(navigations.length, 0);
  await app.click("Back to task");
  assert.deepEqual(navigations, [{ page: "tasks", id: task.id, run: undefined }]);

  await show("slow");
  assert.match(app.host.textContent, /Reading the selected run/);
  assert.ok(pendingRead);
  await show("recent", 77);
  assert.equal(pendingRead.signal.aborted, true);
  await app.env.act(async () => { pendingRead.resolve({ run: { ...old, id: "slow" } }); await tick(); });
  assert.equal(app.host.querySelector("output").dataset.conversation, "recent-chat");
  assert.equal(selections.at(-1).id, "recent-chat");
});

test("an older cloud run stays open through history-list recovery and plan edits", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { ScheduleRequestError } = app.env.loadModule("src/lib/cloudSchedules.ts");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  let task = {
    id: "report", name: "Daily report", enabled: true, new_conversation: true,
    rule: { frequency: "daily", start: "2040-01-01T09:00", time_zone: "UTC" },
    run: { model: "fixture", content: "Produce the report" },
  };
  const older = {
    id: "older", run_id: "older-run", conversation_id: "older-chat", state: "completed",
    trigger_at: "2040-01-02T09:00:00Z",
  };
  const reads = [], navigations = [], writes = [];
  let historyAvailable = false;
  let finishRead;
  const schedules = {
    list: async () => ({ enabled: true, tasks: [task] }),
    runs: async () => {
      reads.push("recent");
      if (!historyAvailable) throw new ScheduleRequestError("offline", 503);
      return { runs: [] };
    },
    readRun: (taskId, occurrence) => {
      reads.push([taskId, occurrence]);
      return new Promise((resolve) => { finishRead = resolve; });
    },
    preview: async () => ({ next_at: "2040-01-02T09:00:00Z" }),
    save: async (input, enabled, _request, existing) => {
      writes.push({ input, enabled, existing });
      task = { ...task, ...input };
      return task;
    },
  };
  const runClient = { getRun: async (id) => ({
    id, conversation_id: older.conversation_id, user_message_id: "older-prompt",
  }) };
  function Harness() {
    const [route, setRoute] = app.env.React.useState({ page: "tasks", id: task.id, run: older.id });
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, locale: "en-US", route, schedules, runClient, onBack() {},
      onNavigate: (next) => { navigations.push(next); setRoute(next); },
      renderConversation: (id) => app.env.React.createElement("textarea", {
        "data-conversation": id, defaultValue: "Keep the follow-up draft",
      }),
      environments: [], models: [], currentModel: { name: "", model: "", keyId: 0 },
    }));
  }
  await app.render(app.env.React.createElement(Harness));
  assert.deepEqual(reads, ["recent", [task.id, older.id]]);
  assert.match(app.host.textContent, /Run history is temporarily unavailable/);
  assert.match(app.host.textContent, /Reading the selected run/);
  await app.env.act(async () => { finishRead({ run: older }); await tick(); });
  const reader = app.host.querySelector("textarea");
  assert.equal(reader?.dataset.conversation, older.conversation_id);
  assert.match(app.host.textContent, /Run history is temporarily unavailable/);

  historyAvailable = true;
  await app.click("Retry");
  assert.deepEqual(reads, ["recent", [task.id, older.id], "recent", [task.id, older.id]]);
  assert.equal(app.host.querySelector("textarea"), reader);
  await app.env.act(async () => { finishRead({ run: older }); await tick(); });
  assert.equal(app.host.querySelector("textarea"), reader);
  assert.equal(reader.value, "Keep the follow-up draft");
  assert.doesNotMatch(app.host.textContent, /Run history is temporarily unavailable/);
  assert.deepEqual(navigations, []);

  const originalPlan = task;
  await app.chooseTaskAction("Edit");
  const edit = document.querySelector('[role="dialog"] textarea');
  await app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(edit, "Change the next report");
    edit.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await app.env.waitFor(() => document.querySelector('[role="dialog"] button[type="submit"]:enabled'), "task edit can save");
  await app.click("Save");
  assert.deepEqual(writes.map(({ input, enabled, existing }) => [input.run.content, enabled, existing]), [
    ["Change the next report", true, originalPlan],
  ]);
  assert.deepEqual(navigations.map(({ id, target, run }) => [id, target, run]), [[task.id, "cloud", older.id]]);
  assert.equal(app.host.querySelector("textarea"), reader);
  await app.env.act(async () => { finishRead({ run: older }); await tick(); });
  assert.equal(app.host.querySelector("textarea"), reader);
  assert.equal(reader.value, "Keep the follow-up draft");
});

test("cloud manual run recovery only reads the same receipt and cannot steal task navigation", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = (id, name) => ({
    id, name, enabled: true, rule: { time_zone: "UTC" }, run: { content: "Scheduled prompt" },
  });
  const tasks = [task("task-a", "First task"), task("task-b", "Second task")];
  const submissions = [];
  const reads = [];
  const navigations = [];
  let loseReply;
  let settleRead;
  const schedules = {
    list: async () => ({ enabled: true, tasks }),
    runs: async () => ({ runs: [] }),
    run: (id, request) => {
      submissions.push([id, request]);
      return new Promise((_, reject) => { loseReply = reject; });
    },
    readRunReceipt: async (id, request) => {
      reads.push([id, request]);
      if (reads.length === 1) return { status: "missing" };
      if (reads.length === 2) return new Promise((resolve) => { settleRead = resolve; });
      return { status: "admitted", id: "original-run" };
    },
  };
  function Harness() {
    const [route, setRoute] = app.env.React.useState({ page: "tasks", id: "task-a" });
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, route, locale: "en-US", onBack: () => {}, schedules,
      onNavigate: (next) => { navigations.push(next); setRoute(next); },
      environments: [], models: [], currentModel: { name: "", model: "", keyId: 0 },
    }));
  }
  async function selectTask(name) {
    const row = [...app.host.querySelectorAll('button[data-sidebar="menu-button"]')]
      .find((button) => button.textContent.startsWith(name));
    assert.ok(row, name);
    await app.env.act(async () => { row.click(); await tick(); });
  }
  await app.render(app.env.React.createElement(Harness));
  await app.click("Run now");
  assert.match(app.host.textContent, /Submitting this run/);
  await selectTask("Second task");
  await app.env.act(async () => { loseReply(new Error("lost HTTP response")); await tick(); });
  assert.equal(navigations.at(-1)?.id, "task-b");
  assert.doesNotMatch(app.host.textContent, /Run result unconfirmed/);
  await selectTask("First task");
  assert.match(app.host.textContent, /Run result unconfirmed/);
  assert.equal([...app.host.querySelectorAll("button")].filter((node) => node.textContent === "Check run").length, 1);
  await app.click("Check run");
  assert.match(app.host.textContent, /No receipt is available yet/);
  assert.match(app.host.textContent, /Stop checking/);
  await app.click("Stop checking");
  assert.match(document.body.textContent, /The original submission may still finish/);
  await app.click("Keep checking");
  assert.equal(submissions.length, 1);

  await app.click("Check run");
  assert.match(app.host.textContent, /Checking the original receipt/);
  await selectTask("Second task");
  await app.env.act(async () => { settleRead({ status: "admitted", id: "original-run" }); await tick(); });
  assert.equal(navigations.at(-1)?.id, "task-b", "a late receipt cannot reopen the original task");
  await selectTask("First task");
  await app.click("Check run");
  assert.equal(navigations.at(-1)?.id, "task-a");
  assert.equal(navigations.at(-1)?.run, "original-run");
  assert.equal(submissions.length, 1);
  assert.deepEqual(reads, Array(3).fill(submissions[0]));
});

test("a stalled cloud run detail read preserves the selected transcript and retries only its read", async (t) => {
  const app = await setup(t, true);
  const setTimeout = window.setTimeout.bind(window);
  let deadlines = 0;
  t.mock.method(window, "setTimeout", (handler, delay, ...args) =>
    setTimeout(handler, delay === 8_000 && ++deadlines === 1 ? 30 : delay, ...args));
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {
    id: "cloud-task", name: "Cloud task", enabled: false,
    rule: { time_zone: "UTC" }, run: { content: "Scheduled prompt" },
  };
  const record = {
    id: "history-id", run_id: "cloud-result", conversation_id: "result",
    trigger_at: "2026-11-07T09:00:00Z", state: "completed", output: "Saved run output",
  };
  const reads = [];
  const selections = [];
  const opened = [];
  let writes = 0;
  let initialSignal, finishInitial;
  let finishRetry;
  const runClient = {
    getRun: async (id, signal) => {
      reads.push(id);
      if (reads.length === 1) {
        initialSignal = signal;
        return new Promise((resolve) => { finishInitial = resolve; });
      }
      return new Promise((resolve) => { finishRetry = resolve; });
    },
  };
  await app.render(app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
    owner: 42, locale: "en-US",
    route: { page: "tasks", id: task.id, run: record.id },
    onNavigate: () => {}, onBack: () => {},
    schedules: {
      list: async () => ({ enabled: true, tasks: [task] }),
      runs: async () => ({ runs: [record] }),
      run: async () => { writes++; },
    },
    runClient,
    onSelectConversation: (selection) => selections.push(selection),
    onOpenResultResource: (conversation, resource) => opened.push([conversation, resource.id]),
    renderConversation: () => app.env.React.createElement("textarea", { defaultValue: "Unsent draft" }),
    environments: [], models: [], currentModel: { name: "", model: "", keyId: 0 },
  })));
  const draft = app.host.querySelector("textarea");
  assert.ok(draft);
  assert.deepEqual(reads, ["cloud-result"]);
  await app.env.waitFor(() => app.host.textContent.includes("Run details are temporarily unavailable"), "bounded run detail read");
  assert.equal(initialSignal.aborted, true);
  assert.match(app.host.textContent, /Run details are temporarily unavailable/);
  assert.doesNotMatch(app.host.textContent, /This run cannot be located/);
  await app.env.act(async () => {
    finishInitial({
      id: "cloud-result", conversation_id: "result", user_message_id: "late-message",
      presentation: { blocks: [{ resources: [{ id: "late", kind: "file", name: "Late.txt", role: "output" }] }] },
    });
    await tick();
  });
  assert.equal(selections.at(-1)?.jump, undefined, "timed-out metadata cannot move the transcript");
  await app.env.act(async () => {
    app.host.querySelector('button[aria-label="Task details"]').click();
    await tick();
  });
  const inspector = app.host.querySelector('aside[aria-label="Task details"]');
  assert.ok(inspector);
  assert.deepEqual(reads, ["cloud-result"], "opening the inspector does not reissue the failed read");
  assert.match(inspector.textContent, /Saved run output/);
  assert.equal((app.host.textContent.match(/Run details are temporarily unavailable/g) || []).length, 1);
  assert.doesNotMatch(inspector.textContent, /No outputs yet|No sources yet|Late\.txt/);
  const retry = [...inspector.querySelectorAll("button")].find((node) => node.textContent === "Retry reading run details");
  // Keyboard opening schedules focus into the inspector on the next frame.
  await app.env.act(async () => { await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
  retry.focus();
  await app.click("Retry reading run details");
  assert.ok(document.activeElement === retry, "the retry button retains focus while reading");
  assert.equal(retry.getAttribute("aria-disabled"), "true");
  assert.match(inspector.textContent, /Reading details for this run.*Saved run output/);
  assert.deepEqual(reads, ["cloud-result", "cloud-result"]);
  await app.env.act(async () => {
    finishRetry({
      id: "cloud-result", conversation_id: "result", user_message_id: "scheduled-message",
      presentation: { blocks: [{ resources: [
        { id: "file", kind: "file", name: "Report.txt", role: "output" },
        { id: "source", kind: "source", name: "Reference", role: "source" },
      ] }] },
    });
    await tick();
  });
  assert.ok(app.host.querySelector("textarea") === draft, "retry keeps the original draft editor");
  assert.equal(draft.value, "Unsent draft");
  assert.ok(document.activeElement === inspector, "focus returns to the inspector after retry");
  assert.equal(selections.at(-1)?.jump?.messageId, "scheduled-message");
  assert.match(inspector.textContent, /OutputsReport\.txtSourcesWeb searchReference/);
  await app.click("Report.txt");
  assert.deepEqual(opened, [["result", "file"]]);
  assert.equal(writes, 0);
});

test("a cloud run link retries a stalled task list and reads the exact run after a stalled history", async (t) => {
  const app = await setup(t, true);
  window.matchMedia = (query) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} });
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis,"setTimeout",(callback,delay,...args)=>timeout(callback,delay===8_000?45:delay,...args));
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {id:"report",name:"Saved briefing",enabled:true,next_at:"2040-01-10T09:00:00Z",rule:{time_zone:"UTC"},run:{content:"Prepare the briefing"}};
  const older = {id:"older",state:"completed",trigger_at:"2040-01-08T09:00:00Z",conversation_id:"result",run_id:"cloud-older",output:"Saved older output"};
  const newer = {...older,id:"newer",run_id:"cloud-newer",output:"A different report"};
  const original = {page:"tasks",id:task.id,run:older.id,scope:"other-device"};
  const reads = [];
  let listSignal, historySignal, lateList, lateHistory, listReads = 0;
  const schedules = {
    list: async signal => {
      if (++listReads===1) return new Promise(resolve=>{listSignal=signal;lateList=resolve;});
      return {enabled:true,tasks:[task]};
    },
    runs: async (id,signal) => {
      reads.push(["recent",id]);
      return new Promise(resolve=>{historySignal=signal;lateHistory=resolve;});
    },
    readRun: async (taskId,occurrence) => {reads.push(["exact",taskId,occurrence]);return {run:older};},
    run: async () => assert.fail("Recovering a linked run must not execute it"),
  };
  const runClient = {getRun:async id=>({id,conversation_id:older.conversation_id,user_message_id:"older-anchor",presentation:{blocks:[{resources:[{kind:"file",role:"output",id:"saved-file",name:"Earlier report.md"},{kind:"source",role:"source",id:"saved-source",name:"Earlier source"}]}]}})};
  const opened = [];
  await app.render(app.env.React.createElement(SidebarProvider,null,app.env.React.createElement(CloudScheduleWorkspace,{
    owner:42,locale:"en-US",route:original,onNavigate:()=>assert.fail("Reading keeps the original URL"),onBack(){},schedules,runClient,
    onOpenResultResource:(conversation,item,occurrence)=>opened.push([conversation,item.id,occurrence]),
    environments:[],models:[],currentModel:{name:"Fixture",model:"fixture",keyId:0},
  })));
  assert.match(app.host.querySelector("h2").textContent,/Loading tasks/);
  await app.env.waitFor(()=>app.host.textContent.includes("Retry loading tasks"),"direct-link list recovery");
  assert.equal(listSignal.aborted,true);
  await app.click("Retry loading tasks");
  await app.env.waitFor(()=>app.host.textContent.includes("Saved older output"),"exact occurrence after recent history timeout");
  assert.equal(historySignal.aborted,true);
  assert.deepEqual(reads,[["recent",task.id],["exact",task.id,older.id]]);
  assert.equal(listReads,2);
  await app.env.act(async () => {lateList({enabled:true,tasks:[]});lateHistory({runs:[newer]});await tick();});
  assert.match(app.host.textContent,/Saved older output/);
  assert.doesNotMatch(app.host.textContent,/A different report/);
  const details = app.host.querySelector('button[aria-label="Task details"]');
  await app.env.act(async () => {details.click();await tick();});
  await app.env.waitFor(()=>document.body.textContent.includes("Earlier report.md"),"the linked output and source appear");
  await app.click("Earlier source");
  assert.deepEqual(opened,[[older.conversation_id,"saved-source",older.id]]);
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

test("cloud task details show the selected stored output without a result conversation", async (t) => {
  const app = await setup(t, true);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {
    id: "report", name: "Daily report", enabled: true,
    rule: { time_zone: "UTC" }, run: { content: "Read the report" },
  };
  const newer = { id: "newer", state: "completed", trigger_at: "2040-01-04T09:00:00Z", output: "New stored result" };
  const older = { id: "older", state: "failed", trigger_at: "2040-01-03T09:00:00Z", manual: true, output: "Old stored result" };
  const schedules = {
    list: async () => ({ enabled: true, tasks: [task] }),
    runs: async () => ({ runs: [newer, older] }),
  };
  let currentRoute;
  let navigations = 0;
  function Harness({ sidebarOnly = false }) {
    const [route, setRoute] = app.env.React.useState({ page: "tasks", id: task.id, run: older.id, scope: "cloud", status: "completed" });
    currentRoute = route;
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, locale: "en-US", route, onNavigate(next) { navigations++; setRoute(next); }, onBack() {}, schedules, sidebarOnly, environments: [], models: [],
      currentModel: { name: "", model: "", keyId: 0 },
    }));
  }
  await app.render(app.env.React.createElement(Harness));
  const result = app.host.querySelector('[aria-label="Run result"]');
  const plan = app.host.querySelector('[aria-label="Current plan"]');
  assert.match(result.textContent, /Manual trigger.*Failed.*Old stored result/);
  assert.equal(result.querySelector("time").dateTime,older.trigger_at);
  assert.ok(result.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.doesNotMatch(app.host.textContent, /Read the report/);
  assert.ok([...plan.querySelectorAll("button")].some(button=>button.textContent==="Edit task"));
  const activeFilters = () => app.host.querySelector('[aria-label="Active filters"]');
  assert.match(activeFilters()?.textContent, /Cloud.*Completed.*Clear filters/);
  await app.click("Clear filters");
  assert.equal(activeFilters(), null);
  const selectedTask = app.host.querySelector('[aria-current="page"]');
  assert.match(selectedTask.textContent, /Daily report/);
  const sameRoute = currentRoute;
  await app.env.act(async () => { selectedTask.click(); await tick(); });
  assert.equal(currentRoute,sameRoute,"the current task row must not leave an exact run");
  assert.match(app.host.querySelector('[aria-label="Run result"]').textContent, /Old stored result/);
  const details = app.host.querySelector('button[aria-label="Task details"]');
  const header = details.closest("header");
  assert.equal(header.querySelector("h2").textContent, task.name);
  assert.match(header.querySelector("p").textContent, /Cloud.*Completed/);
  assert.deepEqual([...header.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")), ["Task actions", "Share", "Task details"]);
  await app.env.act(async () => { details.click(); await tick(); });
  const inspector = app.host.querySelector('aside[aria-label="Task details"]');
  const outputs = () => [...inspector.querySelectorAll("section")].find((node) => node.querySelector("h3")?.textContent === "Outputs");
  assert.match(outputs().textContent, /Old stored result/);
  assert.doesNotMatch(outputs().textContent, /New stored result|No outputs yet/);

  const history = inspector.querySelector("details");
  await app.env.act(async () => {
    history.open = true;
    history.dispatchEvent(new window.Event("toggle"));
    await tick();
  });
  const newerButton = [...history.querySelectorAll("button")].find((button) => button.textContent.endsWith("Completed"));
  await app.env.act(async () => { newerButton.click(); await tick(); });
  assert.match(outputs().textContent, /New stored result/);
  assert.doesNotMatch(outputs().textContent, /Old stored result/);
  assert.match(app.host.querySelector('[aria-label="Run result"]').textContent, /New stored result/);

  await app.render(app.env.React.createElement(Harness,{sidebarOnly:true}));
  const previewRoute = currentRoute;
  const beforeActivation = navigations;
  await app.env.act(async () => { app.host.querySelector('[aria-current="page"]').click(); await tick(); });
  assert.equal(navigations,beforeActivation+1,"the same row can still activate a sidebar-only preview");
  assert.equal(currentRoute,previewRoute);
});

test("mobile task filters restore after opening a result and expose unavailable linked targets", async (t) => {
  const app = await setup(t);
  window.matchMedia = (query) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} });
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {id:"report",name:"Daily report",enabled:false,rule:{time_zone:"UTC"},run:{content:"Read the report"}};
  const other = {...task,id:"other",name:"Weekly report",enabled:true,next_at:"2040-01-04T09:00:00Z"};
  const schedules = {
    list: async () => ({enabled:true,tasks:[task,other]}),
    runs: async () => ({runs:[]}),
  };
  const afterRemoval = {...schedules,list:async()=>({enabled:true,tasks:[other]})};
  function Harness({ scope, client }) {
    const [route, onNavigate] = app.env.React.useState({page:"tasks",scope,status:"paused"});
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner:42, route, onNavigate, onBack() {}, locale:"en-US", schedules:client,
      environments:[], models:[], currentModel:{name:"",model:"",keyId:0},
    }));
  }
  const render = (scope, client = schedules) => app.render(app.env.React.createElement(Harness,{key:scope,scope,client}));
  const summary = () => app.host.querySelector('[aria-label="Active filters"]');
  const control = label => app.host.querySelector(`button[aria-label="${label}"]`);
  const taskRow = () => [...app.host.querySelectorAll('button[data-sidebar="menu-button"]')].find(button => button.textContent.includes("Daily report"));
  const select = selector => app.env.act(async () => { selector().click(); await tick(); });
  await render("cloud");
  assert.match(summary().textContent, /Cloud.*Paused/);
  assert.doesNotMatch(app.host.textContent, /Weekly report/);
  await select(taskRow);
  assert.match(app.host.querySelector("h2").textContent, /Daily report/);
  await select(() => control("Back to tasks"));
  assert.match(summary().textContent, /Cloud.*Paused/);
  assert.equal(document.activeElement,taskRow(),"return to the row that opened the detail");
  await app.click("Clear filters");
  assert.equal(summary(), null);
  assert.equal(document.activeElement, control("Filter tasks"));
  assert.match(app.host.textContent, /Weekly report/);

  await select(taskRow);
  await render("cloud", afterRemoval);
  await app.env.waitFor(()=>app.host.querySelector("h2")?.textContent==="Task unavailable","the selected task is no longer listed");
  await app.click("Back to tasks");
  assert.equal(taskRow(),undefined);
  assert.equal(document.activeElement,control("Filter tasks"),"focus goes to filters if the original row is gone");

  await render("removed-device");
  assert.match(summary().textContent, /Execution target unavailable.*Paused/);
  await select(() => control("Filter tasks"));
  const picker = document.querySelector('[aria-label="Filter by target"]');
  assert.match(picker?.textContent, /Execution target unavailable/);
  assert.doesNotMatch(picker?.textContent, /All targets/);
});

test("choosing a pending task run from history focuses its approval without deciding", async (t) => {
  for (const mobile of [false, true]) await t.test(mobile ? "mobile sheet" : "desktop inspector", async (child) => {
    const app = await setup(child, true);
    if (mobile) window.matchMedia = (query) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} });
    const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
    const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
    const rule = {frequency:"daily",time_zone:"UTC"};
    const task = {id:"report",name:"Daily report",enabled:true,rule,run:{content:"Later plan instructions"}};
    const older = {id:"older",state:"completed",trigger_at:"2040-01-03T09:00:00Z",output:"Old stored result"};
    const pending = {id:"approval",state:"awaiting_approval",trigger_at:"2040-01-04T09:00:00Z",approval:{rule,run:{content:"Frozen request",model:"fixture"}}};
    let route;
    const schedules = {
      list: async () => ({enabled:true,tasks:[task]}),
      runs: async () => ({runs:[pending,older]}),
      decide: () => assert.fail("Selection must not decide"),
    };
    function Harness() {
      const [current, onNavigate] = app.env.React.useState({page:"tasks",id:task.id,run:older.id});
      route=current;
      return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
        owner:42,route,onNavigate,onBack(){},locale:"en-US",schedules,environments:[],models:[],currentModel:{name:"",model:"",keyId:0},
      }));
    }
    await app.render(app.env.React.createElement(Harness));
    const toggle = app.host.querySelector('button[aria-label="Task details"]');
    const details = () => document.querySelector(mobile ? '[role="dialog"][data-layout="bottom-sheet-mobile"]' : 'aside[aria-label="Task details"]');
    await app.env.act(async () => { toggle.focus(); toggle.click(); await tick(); });
    await app.env.act(async () => {
      const history = details().querySelector("details");
      history.open = true;
      history.dispatchEvent(new window.Event("toggle"));
      await tick();
    });
    const row = [...details().querySelectorAll("button")].find(button => button.textContent.endsWith("Awaiting approval"));
    await app.env.act(async () => { row.focus(); row.click(); await tick(); });
    const title = () => [...app.host.querySelectorAll("h3")].find(heading => heading.textContent === "Review this run");
    await app.env.waitFor(() => Boolean(title()) && document.activeElement === title(), "Focus the selected approval title");
    assert.equal(route.run,pending.id);
    assert.match(app.host.textContent,/Frozen request/);
    assert.equal(Boolean(details()),!mobile);
  });
});

test("mobile task details return to the selected run without remounting the conversation draft", async (t) => {
  const app = await setup(t);
  window.matchMedia = (query) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} });
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = { id:"briefing", name:"Daily briefing", enabled:true, rule:{time_zone:"UTC"}, run:{content:"Daily instructions"} };
  const otherTask = {...task,id:"weekly",name:"Weekly briefing"};
  const runs = [
    { id:"newest", run_id:"cloud-new", conversation_id:"result", state:"completed", trigger_at:"2026-11-09T08:00:00Z" },
    { id:"older", run_id:"cloud-older", conversation_id:"result", state:"failed", trigger_at:"2026-11-08T08:00:00Z" },
  ];
  const writes = [];
  let historyAvailable = true;
  const schedules = {
    list:async()=>({enabled:true,tasks:[task,otherTask]}),
    runs:async()=>{
      if (!historyAvailable) throw new Error("offline fixture");
      return {runs};
    },
    readRun:async(_task,id)=>({run:runs.find(run=>run.id===id)}),
    run:async()=>writes.push("run"),
  };
  const runClient = { getRun:async(id)=>({id,conversation_id:"result",user_message_id:id,presentation:{blocks:[]}}) };
  let route;
  function Harness() {
    const [current, onNavigate] = app.env.React.useState({page:"tasks",id:task.id});
    const [draftText, setDraftText] = app.env.React.useState("Unsent mobile draft");
    route=current;
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner:42, locale:"en-US", route, onNavigate, onBack() {}, schedules, runClient, environments:[], models:[],
      currentModel:{name:"",model:"",keyId:0},
      renderConversation:()=>app.env.React.createElement("textarea",{value:draftText,onChange:event=>setDraftText(event.target.value)}),
    }));
  }
  await app.render(app.env.React.createElement(Harness));
  const draft = app.host.querySelector("textarea");
  const trigger = app.host.querySelector('button[aria-label="Task details"]');
  const sheet = () => document.querySelector('[role="dialog"][data-layout="bottom-sheet-mobile"][data-open]');
  const settle = () => new Promise((resolve) => window.requestAnimationFrame(resolve));
  assert.ok(draft && trigger);
  assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  await app.env.act(async () => { trigger.focus(); trigger.click(); await settle(); });
  assert.ok(sheet());
  assert.match(sheet().textContent, /Task details.*Run history/);
  assert.equal(app.host.querySelector("textarea"), draft);
  const close = sheet().querySelector('[aria-label="Close task details"]');
  assert.ok(close);
  await app.env.act(async () => { close.click(); await settle(); });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  await app.env.waitFor(() => !sheet(), "task detail sheet closes before reopening");
  await app.env.act(async () => { trigger.click(); await settle(); });
  const history = () => [...sheet().querySelectorAll("summary")].find((summary) => summary.textContent === "Run history").parentElement;
  await app.env.act(async () => {
    history().open = true;
    history().dispatchEvent(new window.Event("toggle"));
    await tick();
  });
  const older = [...sheet().querySelectorAll("button")].find((button) => button.textContent.endsWith("Failed"));
  assert.ok(older);
  historyAvailable = false;
  await app.env.act(async () => { older.click(); await settle(); });
  assert.equal(route.run,runs[1].id);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(app.host.querySelector("textarea"),draft);
  assert.equal(draft.value,"Unsent mobile draft");
  await app.env.waitFor(() => !sheet(), "task detail sheet closes after selecting a run");
  await app.env.act(async () => { trigger.click(); await settle(); });
  assert.equal(history().open, true);
  assert.match(history().querySelector('[aria-current="true"]').textContent, /Failed/);
  assert.match(history().textContent, /Run history is temporarily unavailable/);
  assert.doesNotMatch(app.host.textContent, /Run history is temporarily unavailable/);
  const retry = [...history().querySelectorAll("button")].find((button) => button.textContent === "Retry run history");
  historyAvailable = true;
  await app.env.act(async () => { retry.focus(); retry.click(); await tick(); });
  assert.doesNotMatch(history().textContent, /Run history is temporarily unavailable/);
  assert.equal(document.activeElement, history().querySelector("summary"));
  assert.equal(route.run, runs[1].id);
  assert.equal(app.host.querySelector("textarea"), draft);
  assert.equal(draft.value, "Unsent mobile draft");
  await app.env.act(async () => {
    history().open = false;
    history().dispatchEvent(new window.Event("toggle"));
    sheet().querySelector('[aria-label="Close task details"]').click();
    await settle();
  });
  await app.env.waitFor(() => !sheet(), "task detail sheet closes after folding history");
  await app.env.act(async () => { trigger.click(); await settle(); });
  assert.equal(history().open, false);
  await app.env.act(async () => { sheet().querySelector('[aria-label="Close task details"]').click(); await settle(); });
  await app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set.call(draft,"Keep this reply after returning to the list");
    draft.dispatchEvent(new window.Event("input",{bubbles:true}));
  });
  const backToTasks = () => app.env.act(async () => { app.host.querySelector('button[aria-label="Back to tasks"]').click(); await tick(); });
  const openTask = name => app.env.act(async () => {
    [...app.host.querySelectorAll('button[data-sidebar="menu-button"]')].find(button=>button.textContent.startsWith(name)).click();
    await tick();
  });
  await backToTasks();
  assert.equal(route.id,undefined);
  await openTask(task.name);
  assert.equal(route.run,runs[1].id);
  assert.equal(app.host.querySelector("textarea").value,"Keep this reply after returning to the list");
  await backToTasks();
  await openTask(otherTask.name);
  assert.equal(route.id,otherTask.id);
  assert.equal(route.run,undefined,"a different task still opens its default result");
  assert.deepEqual(writes,[]);
});

test("mobile task details restore the last resource once for the same run", async (t) => {
  const app = await setup(t);
  window.matchMedia = (query) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} });
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = { id: "briefing", name: "Daily briefing", enabled: true, rule: { time_zone: "UTC" }, run: { content: "Daily instructions" } };
  const newest = { id: "newest", run_id: "cloud-new", conversation_id: "result", state: "completed", trigger_at: "2040-01-02T08:00:00Z" };
  const older = { ...newest, id: "older", run_id: "cloud-old", trigger_at: "2040-01-01T08:00:00Z" };
  const source = { kind: "source", role: "source", id: "brief-source", name: "Briefing source" };
  const output = { kind: "file", role: "output", id: "brief-output", name: "Saved briefing" };
  const schedules = { list: async () => ({ enabled: true, tasks: [task] }), runs: async () => ({ runs: [newest, older] }) };
  const runClient = { getRun: async (id) => ({
    id, conversation_id: "result", user_message_id: id, presentation: { blocks: [{ resources: [source, output] }] },
  }) };
  const opened = [];
  let navigate;
  function Harness() {
    const [route, onNavigate] = app.env.React.useState({ page: "tasks", id: task.id, run: older.id });
    navigate = onNavigate;
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, route, onNavigate, onBack() {}, locale: "en-US", schedules, runClient, environments: [], models: [],
      currentModel: { name: "", model: "", keyId: 0 },
      renderConversation: () => app.env.React.createElement("textarea", { defaultValue: "Unsent draft" }),
      onOpenResultResource: (conversation, resource, occurrence) => {
        opened.push([conversation, resource.id, occurrence]);
        onNavigate({ ...route, reader: { kind: resource.kind, id: resource.id } });
      },
    }));
  }
  await app.render(app.env.React.createElement(Harness));
  const sheet = () => document.querySelector('[role="dialog"][data-layout="bottom-sheet-mobile"]');
  const close = () => sheet().querySelector('[aria-label="Close task details"]');
  const resourceRow = (resource) => sheet()?.querySelector(`[data-task-result-resource="${resource.kind}:${resource.id}"]`);
  const act = (callback) => app.env.act(async () => { callback(); await tick(); });
  const openDetails = () => act(() => app.host.querySelector('[aria-label="Task details"]').click());
  const waitClosed = () => app.env.waitFor(() => !sheet(), "details dismissed");
  const draft = app.host.querySelector("textarea");
  await openDetails();
  await app.env.waitFor(() => resourceRow(source), "resource list");
  const body = sheet().querySelector('[data-slot="dialog-body"]');
  await act(() => { body.scrollTop = 150; body.dispatchEvent(new window.Event("scroll")); });
  await act(() => resourceRow(source).click());
  await waitClosed();
  await act(() => navigate({ page: "tasks", id: task.id, run: older.id }));
  await openDetails();
  await app.env.waitFor(() => document.activeElement === resourceRow(source), "focus restored to the source");
  assert.equal(sheet().querySelector('[data-slot="dialog-body"]').scrollTop, 150);
  assert.equal(app.host.querySelector("textarea"), draft);
  assert.equal(draft.value, "Unsent draft");
  await act(() => close().click());
  await waitClosed();
  await openDetails();
  await app.env.waitFor(() => document.activeElement === close(), "normal detail open focuses Close");

  await act(() => resourceRow(output).click());
  await waitClosed();
  await act(() => navigate({ page: "tasks", id: task.id, run: newest.id }));
  await openDetails();
  await app.env.waitFor(() => resourceRow(output), "new run resource list");
  await app.env.waitFor(() => document.activeElement === close(), "new run does not inherit focus");
  assert.deepEqual(opened, [["result", source.id, older.id], ["result", output.id, older.id]]);
});

test("confirmed pause and resume stay visible when the cloud task list cannot refresh", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const initial = {
    id: "task", name: "Daily briefing", enabled: true, new_conversation: false,
    revision: 1, admitted: 1, next_at: "2040-01-02T09:00:00Z", latest_state: "failed", notification: "all",
    rule: { frequency: "daily", start: "2040-01-01T09:00", time_zone: "UTC" },
    run: { model: "fixture", content: "Prepare the briefing" },
  };
  const original = { id: "original", run_id: "cloud-run", conversation_id: "result", state: "failed", trigger_at: "2040-01-01T09:00:00Z" };
  const writes = [], navigations = [];
  let persisted = initial;
  let readMode = "initial";
  let stale;
  const schedules = {
    list: async (signal) => {
      if (readMode === "stale") return new Promise((resolve) => { stale = { resolve, signal }; });
      if (readMode === "outage") throw new Error("synthetic offline list");
      return { enabled: true, tasks: [persisted] };
    },
    runs: async () => ({ runs: [original] }),
    preview: async () => ({ next_at: "2040-01-03T09:00:00Z" }),
    save: async (_input, enabled, _request, existing) => {
      writes.push({ enabled, revision: existing.revision });
      persisted = { ...persisted, enabled, revision: persisted.revision + 1, next_at: enabled ? "2040-01-04T09:00:00Z" : null };
      const { latest_state: _listOnly, ...confirmed } = persisted;
      return confirmed;
    },
  };
  const render = (client) => app.render(app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
    owner: 42, locale: "en-US", route: { page: "tasks", id: initial.id, run: original.id },
    onNavigate: (route) => navigations.push(route), onBack() {}, schedules: client, environments: [], models: [],
    currentModel: { name: "Fixture", model: "fixture", keyId: 0 },
    renderConversation: () => app.env.React.createElement("textarea", { defaultValue: "Keep this result draft" }),
  })));
  await render(schedules);
  const draft = app.host.querySelector("textarea");
  const row = () => app.host.querySelector('[aria-current="page"]').textContent;
  assert.match(row(), /Jan 2, 2040.*Failed/);

  readMode = "stale";
  await render({ ...schedules });
  assert.ok(stale);
  readMode = "outage";
  await app.chooseTaskAction("Pause");
  assert.deepEqual(writes, [{ enabled: false, revision: 1 }]);
  assert.equal(stale.signal.aborted, true);
  assert.match(app.host.textContent, /Cloud tasks are temporarily unavailable/);
  assert.match(row(), /Paused.*Failed/);
  assert.doesNotMatch(row(), /Jan 2, 2040/);
  await app.env.act(async () => { stale.resolve({ enabled: true, tasks: [initial] }); await tick(); });
  assert.match(row(), /Paused.*Failed/);

  await app.chooseTaskAction("Resume");
  assert.deepEqual(writes, [{ enabled: false, revision: 1 }, { enabled: true, revision: 2 }]);
  assert.match(row(), /Jan 4, 2040.*Failed/, "the receipt's next run wins over the preview");
  assert.match(app.host.textContent, /Cloud tasks are temporarily unavailable/);
  assert.equal(app.host.querySelector("textarea"), draft);
  assert.equal(draft.value, "Keep this result draft");
  assert.deepEqual(navigations, []);

  readMode = "recovered";
  persisted = { ...persisted, latest_state: "completed" };
  await app.click("Retry");
  assert.doesNotMatch(app.host.textContent, /Cloud tasks are temporarily unavailable/);
  assert.match(row(), /Jan 4, 2040.*Completed/);
});

test("resuming a past cloud schedule requires a future trigger and preserves the selected result", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const futureStart = "2040-01-02T09:00";
  const futureRun = "2040-01-02T09:00:00Z";
  let task = {
    id:"cloud-task",name:"Daily report",enabled:false,new_conversation:false,admitted:0,revision:4,next_at:null,
    rule:{frequency:"once",start:"2020-01-01T09:00",time_zone:"UTC"},
    run:{model:"fixture",content:"Keep the existing instructions"},
  };
  const original = {id:"original",run_id:"old-run",conversation_id:"result",state:"completed",trigger_at:"2019-01-01T09:00:00Z"};
  const writes = [], previews = [];
  let previewOffline = true;
  const schedules = {
    list:async()=>({enabled:true,tasks:[task]}), runs:async()=>({runs:[original]}),
    preview:async(rule,admitted)=>{
      previews.push({rule,admitted});
      if (previewOffline) throw new Error("temporary connection failure");
      return {next_at:rule.start===futureStart ? futureRun : null};
    },
    save:async(input,enabled,_request,existing)=>{
      writes.push({input,enabled,revision:existing.revision});
      task={...task,...input,enabled,revision:task.revision+1,next_at:enabled ? futureRun : null};
      return task;
    },
  };
  let route;
  function Harness() {
    const [current,onNavigate]=app.env.React.useState({page:"tasks",id:task.id,run:original.id});
    route=current;
    return app.env.React.createElement(SidebarProvider,null,app.env.React.createElement(CloudScheduleWorkspace,{
      owner:42,locale:"en-US",route,onNavigate,onBack(){},schedules,environments:[],models:[],
      currentModel:{name:"Fixture",model:"fixture",keyId:0},
      renderConversation:()=>app.env.React.createElement("textarea",{defaultValue:"Unsent result draft"}),
    }));
  }
  await app.render(app.env.React.createElement(Harness));
  const originalDraft=app.host.querySelector("textarea");
  assert.ok(originalDraft);
  await app.chooseTaskAction("Resume");
  assert.match(app.host.textContent,/Couldn't check the next run for “Daily report”/);
  assert.deepEqual(writes,[]);
  previewOffline=false;
  await app.chooseTaskAction("Resume");
  const editor=document.querySelector('[role="dialog"]');
  const save=editor.querySelector('button[type="submit"]');
  assert.match(editor.textContent,/Edit schedule to resume.*task stays paused/);
  assert.equal(save.textContent,"Save and resume");
  assert.equal(save.disabled,true);
  await app.env.waitFor(()=>editor.textContent.includes("No future run"),"original date has no future run");
  assert.deepEqual(writes,[]);
  assert.equal(save.disabled,true);
  const time=editor.querySelector('input[type="datetime-local"]');
  await app.env.act(async()=>{
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(time,futureStart);
    time.dispatchEvent(new window.Event("input",{bubbles:true}));
  });
  assert.equal(save.disabled,true);
  await app.env.waitFor(()=>!save.disabled,"new date can resume");
  await app.click("Save and resume");
  assert.equal(writes.length,1);
  assert.equal(writes[0].revision,4);
  assert.equal(writes[0].enabled,true);
  assert.equal(writes[0].input.rule.start,futureStart);
  assert.equal(writes[0].input.run.content,"Keep the existing instructions");
  assert.equal(route.run,original.id);
  assert.equal(app.host.querySelector("textarea"),originalDraft);
  assert.equal(originalDraft.value,"Unsent result draft");

  const previewCount=previews.length;
  await app.chooseTaskAction("Pause");
  assert.equal(previews.length,previewCount,"pause affects future triggers directly");
  assert.equal(task.enabled,false);
  await app.chooseTaskAction("Resume");
  assert.equal(previews.length,previewCount+1);
  assert.equal(task.enabled,true);
  assert.equal(route.run,original.id);
  assert.equal(app.host.querySelector("textarea"),originalDraft);
});

test("new task creation keeps a missing device selected and requires an explicit move to cloud", async (t) => {
  const app = await setup(t);
  const priorNodeFilter = Object.getOwnPropertyDescriptor(globalThis, "NodeFilter");
  Object.defineProperty(globalThis, "NodeFilter", { configurable: true, value: window.NodeFilter });
  t.after(() => {
    if (priorNodeFilter) Object.defineProperty(globalThis, "NodeFilter", priorNodeFilter);
    else delete globalThis.NodeFilter;
  });
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const environment = {
    runtime_kind: "device_agent", device_id: "review-device", name: "Review workstation",
    online: true, workspaces: [{ id: "workspace" }],
  };
  const prompt = "Compare the local review notes";
  const previews = [], saves = [], openedDevices = [];
  const changedZone = Intl.DateTimeFormat().resolvedOptions().timeZone === "America/New_York"
    ? "America/Los_Angeles" : "America/New_York";
  const changedNextAt = changedZone === "America/New_York" ? "2040-01-02T14:00:00Z" : "2040-01-02T17:00:00Z";
  let resolveChangedZone;
  const schedules = {
    list: async () => ({ enabled: true, tasks: [] }),
    deviceSummary: async () => ({ tasks: [] }),
    preview: async (rule) => {
      previews.push(rule);
      if (rule.time_zone === changedZone) {
        return new Promise((resolve) => { resolveChangedZone = resolve; });
      }
      return { next_at: "2040-01-02T09:00:00Z" };
    },
    save: async (input) => { saves.push(input); return { ...input, id: "cloud-plan" }; },
  };
  const render = (environments) => app.render(app.env.React.createElement(SidebarProvider, null,
    app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, locale: "en-US", route: { page: "tasks" }, onNavigate() {}, onBack() {},
      schedules, environments, onOpenDevice: (device) => openedDevices.push(device.device_id),
      models: [], currentModel: { name: "Fixture", model: "fixture", keyId: 0 },
    })));
  const dialog = () => document.querySelector('[role="dialog"]');
  const instructions = () => dialog().querySelector('[aria-label="Task instructions"], textarea');
  const location = () => {
    const label = [...dialog().querySelectorAll("label")].find((node) => node.textContent === "Runs on");
    return document.getElementById(label.htmlFor);
  };
  const action = (label) => [...dialog().querySelectorAll("button")].find((button) => button.textContent === label);
  async function chooseLocation(label) {
    await app.env.act(async () => { location().click(); await tick(); });
    const find = () => [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent === label);
    await app.env.waitFor(find, label);
    await app.env.act(async () => { find().click(); await tick(); });
  }
  await render([environment]);
  await app.click("New task");
  await app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(instructions(), prompt);
    instructions().dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await app.env.waitFor(() => action("Create") && !action("Create").disabled, "initial cloud preview");
  assert.equal(document.activeElement, instructions());
  assert.equal(location().closest("details").open, false);
  await app.env.act(async () => {
    location().closest("details").querySelector("summary").click();
    await tick();
  });
  await chooseLocation(environment.name);
  assert.equal(action("Continue to task editor").disabled, false);
  assert.equal(location().textContent, environment.name);
  assert.equal(previews.length, 1);

  await render([]);
  assert.equal(location().textContent, environment.name);
  assert.match(dialog().textContent, /Your draft is kept/);
  assert.equal(action("Continue to task editor").disabled, true);
  assert.equal(action("Create"), undefined);
  assert.equal(instructions().value, prompt);
  assert.equal(instructions().closest("[hidden]"), null);
  await app.env.act(async () => {
    dialog().querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 230));
  });
  assert.equal(previews.length, 1);
  assert.deepEqual(saves, []);
  assert.deepEqual(openedDevices, []);
  await render([environment]);
  assert.equal(action("Continue to task editor").disabled, false, "the original target becomes ready");
  await render([]);
  await chooseLocation("Cloud");
  assert.equal(instructions().closest("[hidden]"), null);
  assert.equal(instructions().value, prompt);
  await app.env.waitFor(() => !action("Create").disabled, "explicit cloud location gets a new preview");
  assert.equal(previews.length, 2);
  const time = dialog().querySelector('input[type="datetime-local"]');
  const wallTime = time.value;
  const timeZone = dialog().querySelector('button[aria-label="Time zone"]');
  assert.equal(timeZone.closest("details").open, true, "the time zone is in the open Advanced group");
  assert.equal(time.closest("details"), null);
  assert.match(document.getElementById(time.getAttribute("aria-describedby")).textContent, /schedule's time zone/);
  await app.env.act(async () => { timeZone.click(); await tick(); });
  const changedZoneOption = () => [...document.querySelectorAll('[role="option"]')]
    .find((option) => option.textContent.includes(changedZone));
  await app.env.waitFor(changedZoneOption, "different time zone");
  await app.env.act(async () => { changedZoneOption().click(); await tick(); });
  assert.equal(time.value, wallTime);
  assert.ok(document.getElementById(time.getAttribute("aria-describedby")).textContent.includes(changedZone));
  assert.equal(action("Create").disabled, true, "a preview for the old zone cannot authorize creation");
  await app.env.waitFor(() => resolveChangedZone, "preview request for the selected time zone");
  assert.equal(action("Create").disabled, true, "the in-flight preview cannot authorize creation");
  await app.env.act(async () => { resolveChangedZone({ next_at: changedNextAt }); await tick(); });
  await app.env.waitFor(() => !action("Create").disabled, "preview for the selected time zone");
  assert.equal(previews.length, 3);
  assert.equal(previews[2].time_zone, changedZone);
  assert.match(dialog().querySelector('[role="status"]').textContent, /9:00 AM/);
  assert.ok(dialog().querySelector('[role="status"]').textContent.includes(changedZone));
  await app.click("Create");
  assert.deepEqual(saves.map((input) => input.run.content), [prompt]);
  assert.equal(saves[0].rule.time_zone, changedZone);
  assert.equal(saves[0].rule.start, wallTime);
  assert.deepEqual(openedDevices, []);
});

test("new task creation uses the filtered location and never falls through to another host", async (t) => {
  const app = await setup(t);
  window.matchMedia = (query) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} });
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const local = {targetId:"local",label:"This computer",list:async()=>({tasks:[],next:{}})};
  const remote = {runtime_kind:"device_agent",device_id:"remote",name:"Research workstation",workspaces:[{id:"work",name:"Research"}]};
  const opened = [];
  let cloudEnabled = true;
  const schedules = {
    list: async () => ({enabled:cloudEnabled,tasks:[]}),
    deviceSummary: async () => ({tasks:[]}),
    preview: async () => assert.fail("An unavailable or device target cannot preview Cloud"),
    save: async () => assert.fail("Choosing or opening a target cannot save a task"),
  };
  const render = (scope, online) => app.render(app.env.React.createElement(SidebarProvider, null,
    app.env.React.createElement(CloudScheduleWorkspace, {
      key:scope,owner:42,locale:"en-US",route:{page:"tasks",scope},onNavigate(){},onBack(){},schedules,
      device:local,environments:[{...remote,online}],defaultCreationTarget:local.targetId,
      renderDeviceEditor:()=>app.env.React.createElement("div",{"data-inline-device-editor":""}),
      onOpenDevice:async environment=>opened.push(environment.device_id),models:[],currentModel:{name:"Fixture",model:"fixture",keyId:0},
    })));
  const dialog = () => document.querySelector('[role="dialog"][data-open]');
  const location = () => dialog().querySelector('button[id$="-target"]');
  const action = label => [...dialog().querySelectorAll("button")].find(button=>button.textContent===label);
  await render("remote", false);
  await app.click("New task");
  assert.equal(location().textContent,remote.name);
  assert.match(dialog().textContent,/This device is unavailable.*choose another location/);
  assert.equal(action("Continue to task editor").disabled,true);
  assert.equal(action("Create"),undefined);
  assert.deepEqual(opened,[]);
  await render("remote", true);
  assert.equal(location().textContent,remote.name);
  assert.equal(action("Continue to task editor").disabled,false);
  assert.deepEqual(opened,[]);
  await app.click("Continue to task editor");
  assert.deepEqual(opened,[remote.device_id]);

  cloudEnabled=false;
  await render("cloud", true);
  await app.click("New task");
  assert.equal(location().textContent,"Cloud unavailable");
  assert.equal(action("Create").disabled,true);
  assert.equal(app.host.querySelector("[data-inline-device-editor]"),null);
  await app.env.act(async () => { location().click(); await tick(); });
  const localOption = () => [...document.querySelectorAll('[role="option"]')].find(item=>item.textContent===local.label);
  await app.env.waitFor(localOption,"explicit local alternative");
  await app.env.act(async () => { localOption().click(); await tick(); });
  await app.click("Continue to task editor");
  assert.ok(app.host.querySelector("[data-inline-device-editor]"));
  assert.deepEqual(opened,[remote.device_id]);
});

test("editing a cloud task waits for its current preview and retries without losing the draft", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {
    id: "cloud-task", name: "Cloud task", enabled: false, new_conversation: false, admitted: 3,
    rule: { frequency: "daily", start: "2040-01-01T09:00", time_zone: "Asia/Hong_Kong" },
    run: { model: "fixture", content: "Scheduled prompt" },
  };
  const requests = [];
  const writes = [];
  const schedules = {
    list: async () => ({ enabled: true, tasks: [task] }),
    runs: async () => ({ runs: [] }),
    preview: (rule, admitted, signal) => new Promise((resolve, reject) => {
      requests.push({ rule, admitted, signal, resolve, reject });
    }),
    save: async (input) => { writes.push(input); return task; },
  };
  await app.render(app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
    owner: 42,
    locale: "en-US",
    route: { page: "tasks", id: task.id },
    onNavigate: () => {},
    onBack: () => {},
    schedules,
    environments: [],
    models: [],
    currentModel: { name: "Fixture", model: "fixture", keyId: 0 },
  })));
  await app.click("Edit task");
  const dialog = document.querySelector('[role="dialog"]');
  assert.equal(dialog.querySelector("input[aria-label=Name]").value, task.name);
  const start = dialog.querySelector('input[type="datetime-local"]');
  const save = dialog.querySelector('button[type="submit"]');
  const nextRun = () => dialog.querySelector('[role="status"]')?.textContent ?? "";
  const waitForRequest = (count) => app.env.act(async () => {
    const deadline = Date.now() + 2_000;
    while (requests.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(requests.length, count);
  });
  const changeStart = (value) => app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(start, value);
    start.dispatchEvent(new window.Event("input", { bubbles: true }));
  });

  assert.equal(save.disabled, true);
  assert.match(nextRun(), /Calculating/);
  await waitForRequest(1);
  await app.env.act(async () => { requests[0].resolve({ next_at: "2040-01-01T01:00:00Z" }); });
  assert.equal(save.disabled, false);
  assert.match(nextRun(), /9:00 AM.*Asia\/Hong_Kong/);

  await changeStart("2040-01-02T10:00");
  assert.equal(save.disabled, true);
  await waitForRequest(2);
  await changeStart("2040-01-03T11:00");
  assert.equal(requests[1].signal.aborted, true);
  await app.env.act(async () => {
    requests[1].resolve({ next_at: "2040-01-02T02:00:00Z" });
    dialog.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(save.disabled, true);
  assert.match(nextRun(), /Calculating/);
  assert.deepEqual(writes, []);

  await waitForRequest(3);
  await app.env.act(async () => { requests[2].reject(new Error("Network request failed")); });
  assert.match(dialog.querySelector('[role="alert"]').textContent, /Unable to preview.*Your draft is still here/);
  await app.click("Retry preview");
  assert.equal(start.value, "2040-01-03T11:00");
  assert.equal(save.disabled, true);
  await waitForRequest(4);
  assert.equal(requests[3].admitted, 3);
  assert.equal(requests[3].rule.start, start.value);
  await app.env.act(async () => { requests[3].resolve({ next_at: null }); });
  assert.match(nextRun(), /No future run/);
  assert.equal(save.disabled, false, "existing tasks without a future run can still be edited");
  await app.click("Save");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].rule.start, "2040-01-03T11:00");
});

test("a new cloud task opens from the save receipt even while its list refresh fails", async (t) => {
  const app = await setup(t);
  window.matchMedia = (query) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} });
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const writes = [];
  let reads = 0;
  let failRefresh, confirmed, route;
  const schedules = {
    list: async () => {
      if (++reads === 1) return {enabled:true,tasks:[]};
      if (reads === 2) return new Promise((_, reject) => { failRefresh = reject; });
      return {enabled:true,tasks:[confirmed]};
    },
    runs: async () => ({runs:[]}),
    preview: async () => ({next_at:"2040-01-02T01:00:00Z"}),
    save: async (input, enabled) => {
      writes.push(input);
      confirmed = {...input,id:"saved-task",name:"Confirmed task title",enabled,revision:1,admitted:0,next_at:"2040-01-04T01:00:00Z",rule:{...input.rule,time_zone:"Asia/Hong_Kong"}};
      return confirmed;
    },
    run: async () => assert.fail("Creating and checking the plan must not run it"),
  };
  function Harness() {
    const [current,onNavigate] = app.env.React.useState({page:"tasks"});
    route=current;
    return app.env.React.createElement(SidebarProvider,null,app.env.React.createElement(CloudScheduleWorkspace,{
      owner:42,locale:"en-US",route,onNavigate,onBack(){},schedules,environments:[],models:[],
      currentModel:{name:"Fixture",model:"fixture",keyId:0},
    }));
  }
  await app.render(app.env.React.createElement(Harness));
  await app.click("New task");
  const dialog = () => document.querySelector('[role="dialog"][data-open]');
  const instructions = dialog().querySelector("textarea");
  await app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set.call(instructions,"Draft name and instructions");
    instructions.dispatchEvent(new window.Event("input",{bubbles:true}));
  });
  await app.env.waitFor(() => dialog().querySelector('button[type="submit"]:enabled'), "valid next run preview");
  await app.click("Create");
  assert.equal(dialog(),null);
  assert.equal(route.id,"saved-task");
  assert.equal(route.run,undefined);
  const heading=() => app.host.querySelector("h2");
  assert.equal(heading().textContent,"Confirmed task title");
  assert.equal(document.activeElement,heading());
  assert.match(app.host.textContent,/Next run.*Jan 4, 2040.*9:00 AM/);
  assert.doesNotMatch(app.host.textContent,/Task unavailable/);
  assert.equal([...app.host.querySelectorAll("button")].find(button=>button.textContent==="Run now").disabled,true);
  await app.env.waitFor(() => Boolean(failRefresh), "refresh task list after the write");
  await app.env.act(async () => { failRefresh(new Error("temporarily unavailable")); await tick(); });
  assert.equal(heading().textContent,"Confirmed task title");
  assert.match(app.host.textContent,/Cloud tasks are temporarily unavailable/);
  assert.equal([...app.host.querySelectorAll("button")].find(button=>button.textContent==="Edit task").disabled,false);
  await app.click("Retry loading tasks");
  assert.doesNotMatch(app.host.textContent,/Cloud tasks are temporarily unavailable/);
  assert.equal(route.id,"saved-task");
  assert.equal(writes.length,1);
});

test("the task editor keeps a changed draft and its preview until discard is confirmed", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  let reads = 0;
  const schedules = {
    list: async () => ({enabled:true,tasks:[]}),
    preview: async () => { reads++; return {next_at:"2040-01-02T09:00:00Z"}; },
    save: async () => assert.fail("Dismissing a draft must not save"),
  };
  await app.render(app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
    owner:42,locale:"en-US",route:{page:"tasks"},onNavigate(){},onBack(){},schedules,
    environments:[],models:[],currentModel:{name:"Fixture",model:"fixture",keyId:0},
  })));
  const editor = () => document.querySelector('[role="dialog"][data-open]');
  const confirmation = () => document.querySelector('[role="alertdialog"][data-open]');
  const input = () => editor().querySelector("textarea");
  const updateInstructions = value => app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(input(), value);
    input().dispatchEvent(new window.Event("input", {bubbles:true}));
  });
  await app.click("New task");
  const draft = input();
  await updateInstructions("Unsent task instructions");
  await app.env.waitFor(() => editor().querySelector('button[type="submit"]:enabled'), "preview the unsaved task");
  const preview = editor().querySelector('[role="status"]').textContent;
  await app.click("Cancel");
  assert.match(confirmation().textContent,/Discard task changes/);
  assert.equal(input(),draft);
  await app.click("Keep editing");
  assert.equal(confirmation(),null);
  assert.equal(input(),draft);
  assert.equal(input().value,"Unsent task instructions");
  assert.equal(editor().querySelector('[role="status"]').textContent,preview);
  assert.equal(reads,1);

  await updateInstructions("");
  await app.click("Cancel");
  assert.equal(confirmation(),null);
  assert.equal(editor(),null);

  await app.click("New task");
  await updateInstructions("Will discard this task");
  await app.env.act(async () => { editor().querySelector('button[aria-label="Close"]').click(); await tick(); });
  assert.match(confirmation().textContent,/Discard task changes/);
  await app.click("Discard changes");
  assert.equal(confirmation(),null);
  assert.equal(editor(),null);
});

test("a hung cloud task preview times out without clearing the new task draft", async (t) => {
  const app = await setup(t);
  const setTimeout = window.setTimeout.bind(window);
  let deadlines = 0;
  t.mock.method(window, "setTimeout", (handler, delay, ...args) =>
    setTimeout(handler, delay === 8_000 && ++deadlines === 1 ? 30 : delay, ...args));
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const requests = [], writes = [];
  const schedules = {
    list: async () => ({ enabled: true, tasks: [] }),
    preview: (rule, admitted, signal) => new Promise((resolve) => requests.push({ rule, admitted, signal, resolve })),
    save: async (input) => { writes.push(input); return { ...input, id: "cloud-plan" }; },
  };
  await app.render(app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
    owner: 42, locale: "en-US", route: { page: "tasks" }, onNavigate() {}, onBack() {},
    schedules, environments: [], models: [], currentModel: { name: "Fixture", model: "fixture", keyId: 0 },
  })));
  await app.click("New task");
  const dialog = document.querySelector('[role="dialog"]');
  const instructions = dialog.querySelector("textarea");
  const create = dialog.querySelector('button[type="submit"]');
  const start = dialog.querySelector('input[type="datetime-local"]').value;
  await app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(instructions, "Keep the scheduling draft");
    instructions.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await app.env.waitFor(() => dialog.textContent.includes("Unable to preview the next run"), "bounded preview failure");
  assert.equal(deadlines, 1);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(create.disabled, true);
  await app.env.act(async () => {
    requests[0].resolve({ next_at: "2040-01-02T09:00:00Z" });
    dialog.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await tick();
  });
  assert.equal(create.disabled, true, "a late result from the timed-out request cannot enable creation");
  assert.deepEqual(writes, []);
  await app.click("Retry preview");
  await app.env.waitFor(() => requests.length === 2, "retry the same rule");
  assert.deepEqual(requests[1].rule, requests[0].rule);
  assert.equal(requests[1].signal.aborted, false);
  assert.equal(instructions.value, "Keep the scheduling draft");
  await app.env.act(async () => { requests[1].resolve({ next_at: "2040-01-02T09:00:00Z" }); });
  assert.equal(create.disabled, false);
  await app.click("Create");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].rule.start, start);
  assert.equal(writes[0].run.content, instructions.value);
});

test("editing a cloud task repairs an unavailable source without changing its pinned version", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { CloudChatFileError } = app.env.loadModule("src/lib/cloudChatFiles.ts");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {
    id: "cloud-task", name: "Resource briefing", enabled: true, new_conversation: false, admitted: 0,
    rule: { frequency: "daily", start: "2040-01-01T09:00", time_zone: "UTC" },
    run: { model: "fixture", content: [
      {type:"text",text:"Keep these instructions"},
      {type:"file_reference",file_id:"deleted-file"},
      {type:"artifact_reference",version_id:"old-version"},
    ] },
  };
  const writes = [], reads = [], libraryRequests = [];
  const schedules = {
    list: async () => ({ enabled: true, tasks: [task] }),
    runs: async () => ({ runs: [] }),
    preview: async () => ({ next_at: "2040-01-02T09:00:00Z" }),
    save: async (input) => { writes.push(input); return task; },
  };
  const sourceMetadata = {
    files: { get: async (id) => {
      reads.push(id);
      if (id === "deleted-file") throw new CloudChatFileError("gone", 404);
      return { name: "Replacement brief.pdf" };
    } },
    artifacts: { get: async (id) => {
      reads.push(id);
      return { name: "Pinned draft.md", number: 2 };
    } },
  };
  const space = { list: (location, query, _sort, cursor, signal) => new Promise((resolve, reject) => {
    assert.equal(location.category, "recent");
    libraryRequests.push({ query, cursor, signal, resolve, reject });
  }) };
  await app.render(app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
    owner: 42, locale: "en-US", route: { page: "tasks", id: task.id }, onNavigate() {}, onBack() {},
    schedules, environments: [], models: [], currentModel: { name: "Fixture", model: "fixture", keyId: 0 },
    space, sourceMetadata,
  })));
  await app.click("Edit task");
  assert.deepEqual(reads, []);
  const dialog = document.querySelector('[role="dialog"]');
  const selected = () => dialog.querySelector('[aria-label="Selected sources"]');
  const results = () => dialog.querySelector('[aria-label="Library results"]');
  const advanced = [...dialog.querySelectorAll("summary")].find((item) => item.textContent === "Advanced");
  await app.env.act(async () => { advanced.parentElement.open = true; advanced.parentElement.dispatchEvent(new window.Event("toggle")); await tick(); });
  assert.deepEqual(reads, ["deleted-file", "old-version"]);
  assert.match(selected().textContent, /File source 1Source unavailable.*Pinned draft.mdVersion 2/);
  const remove = selected().querySelector('[aria-label="Remove File source 1"]');
  await app.env.act(async () => { remove.focus(); remove.click(); });
  assert.equal(document.activeElement.getAttribute("aria-label"), "Remove Pinned draft.md");
  assert.doesNotMatch(selected().textContent, /Source unavailable/);
  assert.deepEqual(writes, []);

  async function waitForRequest(index) {
    const deadline = Date.now() + 2_000;
    while (!libraryRequests[index] && Date.now() < deadline)
      await app.env.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(libraryRequests[index]);
    return libraryRequests[index];
  }
  await app.click("Choose from library");
  assert.match(dialog.textContent, /Loading library/);
  const first = await waitForRequest(0);
  await app.env.act(async () => first.reject(new Error("offline")));
  assert.match(dialog.textContent, /Couldn't load the library/);
  assert.match(selected().textContent, /Pinned draft.mdVersion 2/);
  await app.click("Retry library");
  const retry = await waitForRequest(1);
  await app.env.act(async () => retry.resolve({
    items: [{ id:"new", kind:"artifact", target_id:"new-version", name:"Latest draft.md", state:"ready" }], next_cursor:"more",
  }));
  assert.equal(results().querySelector('[role="checkbox"]').getAttribute("aria-checked"), "false");
  await app.click("Show more sources");
  const more = await waitForRequest(2);
  assert.equal(more.cursor, "more");
  await app.env.act(async () => more.resolve({
    items: [{ id:"replacement", kind:"file", target_id:"new-file", name:"Replacement brief.pdf", state:"ready" }], next_cursor:"",
  }));
  assert.match(results().textContent, /Latest draft.md.*Replacement brief.pdf/);
  await app.env.act(async () => results().querySelectorAll('[role="checkbox"]')[1].click());
  assert.match(selected().textContent, /Pinned draft.mdVersion 2.*Replacement brief.pdf/);

  const search = dialog.querySelector('[aria-label="Search files"]');
  await app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(search, "no-match");
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(results(), null);
  const filtered = await waitForRequest(3);
  assert.equal(filtered.query, "no-match");
  await app.env.act(async () => filtered.resolve({ items:[], next_cursor:"" }));
  assert.match(dialog.textContent, /No matching sources/);
  assert.match(selected().textContent, /Pinned draft.mdVersion 2.*Replacement brief.pdf/);
  await app.click("Save");
  assert.deepEqual(writes.map((write) => write.run.content), [[
    { type:"text", text:"Keep these instructions" },
    { type:"artifact_reference", version_id:"old-version" },
    { type:"file_reference", file_id:"new-file" },
  ]]);
});

for (const imageOnly of [false, true]) test(
  imageOnly
    ? "a legacy image-only cloud task saves intact and cannot save after its last image is removed"
    : "editing legacy image sources removes one occurrence and preserves ordered content",
  async (t) => {
    const app = await setup(t);
    const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
    const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
    const url = "data:image/png;base64,iVBORw0KGgo=";
    const first = { type: "image_url", image_url: { url, detail: "low" } };
    const second = { type: "image_url", image_url: { url, detail: "high" } };
    const before = { type: "text", text: "Compare these sources" };
    const after = { type: "text", text: "Summarize differences" };
    const artifact = { type: "artifact_reference", version_id: "pinned-version" };
    const content = imageOnly ? [first] : [before, first, artifact, second, after];
    const task = {
      id: "image-task", name: "Image briefing", enabled: true, new_conversation: false, admitted: 0,
      rule: { frequency: "daily", start: "2040-01-01T09:00", time_zone: "UTC" },
      run: { model: "fixture", content },
    };
    const writes = [], metadataReads = [];
    const schedules = {
      list: async () => ({ enabled: true, tasks: [task] }),
      runs: async () => ({ runs: [] }),
      preview: async () => ({ next_at: "2040-01-02T09:00:00Z" }),
      save: async (input) => { writes.push(input.run.content); return task; },
    };
    await app.render(app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, locale: "en-US", route: { page: "tasks", id: task.id }, onNavigate() {}, onBack() {},
      schedules, environments: [], models: [], currentModel: { name: "Fixture", model: "fixture", keyId: 0 },
      sourceMetadata: { artifacts: { get: async (id) => {
        metadataReads.push(id);
        return { name: "Pinned draft.md", number: 2 };
      } } },
    })));
    await app.click("Edit task");
    if (imageOnly) {
      assert.match(document.querySelector('[role="dialog"]').textContent, /uses saved sources/);
      await app.env.waitFor(() => document.querySelector('[role="dialog"] button[type="submit"]:enabled'), "image-only task can save");
      await app.click("Save");
      assert.deepEqual(writes, [[first]]);
      await app.click("Edit task");
    }
    const dialog = document.querySelector('[role="dialog"]');
    const selected = () => dialog.querySelector('[aria-label="Selected sources"]');
    const advanced = [...dialog.querySelectorAll("summary")].find((item) => item.textContent === "Advanced");
    await app.env.act(async () => {
      advanced.parentElement.open = true;
      advanced.parentElement.dispatchEvent(new window.Event("toggle"));
      await tick();
    });
    assert.match(selected().textContent, /Embedded image 1PNG/);
    assert.equal(selected().querySelector("img"), null);
    assert.doesNotMatch(selected().innerHTML, /data:image/);
    assert.deepEqual(metadataReads, imageOnly ? [] : [artifact.version_id]);
    if (!imageOnly) assert.match(selected().textContent, /Pinned draft.mdVersion 2.*Embedded image 2PNG/);
    const remove = selected().querySelector('[aria-label="Remove Embedded image 1"]');
    await app.env.act(async () => { remove.focus(); remove.click(); });
    assert.deepEqual(writes, imageOnly ? [[first]] : []);
    if (imageOnly) {
      assert.equal(selected(), null);
      assert.equal(document.activeElement.textContent.trim(), "Sources · 0");
      assert.equal(dialog.querySelector('button[type="submit"]').disabled, true);
      await app.env.act(async () => dialog.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
      assert.deepEqual(writes, [[first]]);
    } else {
      assert.equal(selected().querySelectorAll("li").length, 2);
      assert.equal(document.activeElement.getAttribute("aria-label"), "Remove Pinned draft.md");
      await app.env.waitFor(() => !dialog.querySelector('button[type="submit"]').disabled, "mixed-source task can save");
      await app.click("Save");
      assert.deepEqual(writes, [[before, artifact, second, after]]);
    }
  },
);

test("task list and selected run history report localized failures in their own areas", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { ScheduleRequestError } = app.env.loadModule("src/lib/cloudSchedules.ts");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {
    id: "task", name: "Cloud report", enabled: false, new_conversation: false,
    rule: { frequency: "daily", start: "2040-01-01T09:00", time_zone: "UTC" },
    run: { model: "fixture", content: "Keep this task visible" },
  };
  let listAvailable = false;
  let historyAvailable = false;
  const schedules = {
    list: async () => {
      if (!listAvailable) throw new ScheduleRequestError("cloud schedule storage unavailable", 503);
      return { enabled: true, tasks: [task] };
    },
    runs: async () => {
      if (!historyAvailable) throw new ScheduleRequestError("raw run storage error", 503);
      return { runs: [{ id: "run", trigger_at: "2040-01-01T09:00:00Z", state: "completed" }] };
    },
  };
  await app.render(app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
    owner: 42,
    locale: "zh-CN",
    route: { page: "tasks", id: task.id },
    onNavigate: () => {},
    onBack: () => {},
    schedules,
    environments: [],
    models: [],
    currentModel: { name: "Fixture", model: "fixture", keyId: 0 },
  })));
  const sidebar = app.host.querySelector('[aria-label="定时任务导航"]');
  assert.match(sidebar.textContent, /暂时无法读取云端任务/);
  assert.doesNotMatch(app.host.textContent, /cloud schedule storage unavailable/);

  listAvailable = true;
  await app.click("重试");
  assert.match(sidebar.textContent, /Cloud report/);
  assert.doesNotMatch(sidebar.textContent, /暂时无法读取/);
  assert.match(app.host.textContent, /暂时无法读取运行记录/);
  assert.match(app.host.textContent, /Keep this task visible/);
  assert.doesNotMatch(app.host.textContent, /raw run storage error/);

  historyAvailable = true;
  await app.click("重试");
  assert.doesNotMatch(app.host.textContent, /暂时无法读取运行记录/);
  assert.match(app.host.querySelector('[aria-label="运行结果"]').textContent, /已完成/);
});

test("a device history failure preserves the selected result and draft while the task remains readable", async (t) => {
  const app = await setup(t);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  let task = { id: "task", name: "Device report", type: "prompt", cron: "0 0 9 * * *", enabled: true };
  const run = { id: "original", state: "done", sessionId: "result", startedAt: 1000 };
  let historyAvailable = true;
  const device = {
    targetId: "local", label: "This computer",
    list: async () => ({ tasks: [task], next: {} }),
    runs: async () => {
      if (!historyAvailable) throw new Error("raw device fixture history error");
      return [run];
    },
    toggle: async () => {
      task = { ...task, enabled: !task.enabled };
    },
  };
  const render = (owner) => app.render(app.env.React.createElement(SidebarProvider, null,
    app.env.React.createElement(CloudScheduleWorkspace, {
      owner, route: { page: "tasks", target: "local", id: task.id, run: run.id }, locale: "en-US",
      device, onNavigate: () => {}, onBack: () => {}, schedules: null, includeCloud: false,
      environments: [], models: [], currentModel: { name: "", model: "", keyId: 0 },
      renderDeviceConversation: (session, result) => app.env.React.createElement("div", null,
        app.env.React.createElement("output", null, `${session}:${result.id}`),
        app.env.React.createElement("input", { "aria-label": "Task reply draft" })),
    })));
  const draft = () => app.host.querySelector('[aria-label="Task reply draft"]');
  await render(42);
  const originalDraft = draft();
  const header = app.host.querySelector('button[aria-label="Task details"]').closest("header");
  assert.equal(header.querySelector("h2").textContent, task.name);
  assert.match(header.querySelector("p").textContent, /This computer.*Active/);
  originalDraft.value = "Unsent follow-up";
  historyAvailable = false;
  await app.chooseTaskAction("Pause");
  assert.match(app.host.textContent, /Device run history is temporarily unavailable/);
  assert.doesNotMatch(app.host.textContent, /Device tasks are unavailable|raw device fixture history error/);
  assert.match(app.host.textContent, /result:original/);
  assert.equal(draft(), originalDraft);
  assert.equal(draft().value, "Unsent follow-up");
  await app.chooseTaskAction("Resume");
  assert.equal(task.enabled, true, "device task controls are still available");
  historyAvailable = true;
  await app.click("Retry");
  assert.doesNotMatch(app.host.textContent, /Device run history is temporarily unavailable/);
  assert.equal(draft(), originalDraft);

  historyAvailable = false;
  await render(43);
  assert.equal(draft(), null, "another account cannot see cached history");
  assert.match(app.host.textContent, /Device run history is temporarily unavailable/);
});

test("a device run link distinguishes reading, failure and a missing record without falling back", async (t) => {
  const app = await setup(t, true);
  const { CloudScheduleWorkspace } = app.env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = app.env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const task = {
    id: "task", name: "Device report", type: "prompt", prompt: "Use the current plan", cron: "0 0 9 * * *", enabled: true,
  };
  const latest = { id: "latest", state: "done", startedAt: 2000, sessionId: "new-result" };
  const older = { id: "old-execution", runId: "canonical-old", state: "done", startedAt: 1000, sessionId: "old-result" };
  const writes = [], navigations = [];
  let readState = "pending";
  let failFirstRead;
  let setRun;
  const device = {
    targetId: "device", label: "Connected computer",
    list: async () => ({ tasks: [task], next: {} }),
    runs: async () => {
      if (readState === "pending") return new Promise((_resolve, reject) => { failFirstRead = reject; });
      return readState === "missing" ? [latest] : [latest, older];
    },
    runNowOnce: async (...args) => { writes.push(args); },
  };
  function Harness() {
    const [route, setRoute] = app.env.React.useState({ page: "tasks", target: "device", id: task.id, run: older.runId });
    setRun = (run) => setRoute((current) => ({ ...current, run }));
    return app.env.React.createElement(SidebarProvider, null, app.env.React.createElement(CloudScheduleWorkspace, {
      owner: 42, route, locale: "en-US", device, schedules: null, includeCloud: false,
      onNavigate: (next) => { navigations.push(next); setRoute(next); }, onBack() {},
      environments: [], models: [], currentModel: { name: "", model: "", keyId: 0 },
      renderDeviceConversation: (id) => app.env.React.createElement("output", { "data-result": id }, id),
    }));
  }
  const selected = () => app.host.querySelector("output")?.dataset.result;
  const retry = () => [...app.host.querySelectorAll("button")].find((button) => button.textContent === "Retry selected run");
  await app.render(app.env.React.createElement(Harness));
  assert.match(app.host.textContent, /Reading the selected run/);
  assert.doesNotMatch(app.host.textContent, /Use the current plan|Run now/);
  await app.env.act(async () => { failFirstRead(new Error("raw transport message")); await tick(); });
  assert.match(app.host.textContent, /Device run history is temporarily unavailable/);
  assert.doesNotMatch(app.host.textContent, /raw transport message/);
  assert.equal(selected(), undefined);
  readState = "missing";
  await app.click("Retry selected run");
  assert.match(app.host.textContent, /The selected run is unavailable in this device's history/);
  assert.equal(selected(), undefined, "the recent result must not replace the requested run");
  assert.deepEqual(navigations, []);

  await app.click("Back to task");
  assert.deepEqual(navigations, [{ page: "tasks", target: "device", id: task.id, run: undefined }]);
  assert.equal(selected(), latest.sessionId);
  assert.equal(document.activeElement.textContent, task.name);
  await app.env.act(async () => { setRun(older.runId); await tick(); });
  readState = "recovered";
  await app.env.act(async () => { retry().focus(); retry().click(); await tick(); });
  assert.equal(selected(), older.sessionId);
  assert.equal(document.activeElement.textContent, task.name);
  assert.equal(navigations.length, 1, "reading the requested run keeps its address");
  assert.deepEqual(writes, [], "retry and returning never submit a run");
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

test("device task editor previews the draft on the selected device and rejects stale results", async (t) => {
  const app = await setup(t);
  const { CronTaskModal } = app.env.loadModule("../../agent-ui/src/pages/settings/CronTaskModal.tsx");
  const { LocaleContext, t: translate } = app.env.loadModule("../../agent-ui/src/i18n/index.ts");
  const { createDeviceScheduleHost } = app.env.loadModule("src/lib/deviceScheduleHost.ts");
  const requests = [];
  const device = createDeviceScheduleHost({
    backend: {
      previewCronDraft: (input, signal) => new Promise((resolve, reject) => requests.push({ input, signal, resolve, reject })),
      canCancelRun: () => false,
    },
    targetId: "remote-1",
    label: "Hong Kong workstation",
    locale: "en-US",
    requireCurrent: () => {},
  });
  await app.render(app.env.React.createElement(LocaleContext.Provider, {
    value: { locale: "en-US", t: (key) => translate(key, "en-US") },
  }, app.env.React.createElement(CronTaskModal, {
    mode: "edit",
    initialData: { name: "Refresh reports", type: "bash", script: "echo done", cron: "* * * * * *", enabled: true, remainingExecutions: 2 },
    workbench: { target: device.label, preview: device.preview },
    modelOptions: [],
    providers: [],
    workspaceOptions: [],
    executionMode: "agent",
    onSave: () => assert.fail("The fixture should not write tasks"),
    onClose: () => {},
  })));
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.querySelector("details").textContent, /Runs onHong Kong workstation/);
  const save = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Save");
  const cron = dialog.querySelector('input[aria-label="Cron Expression"]');
  const changeRule = (value) => app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(cron, value);
    cron.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(save.disabled, true);
  await app.env.waitFor(() => requests.length === 1, "initial device preview");
  assert.deepEqual(requests[0].input, { expression: "* * * * * *", remainingExecutions: 2 });
  await changeRule("* * * * * 1-5");
  assert.equal(requests[0].signal.aborted, true);
  await app.env.act(async () => {
    requests[0].resolve({ status: "valid", nextAt: Date.UTC(2040, 0, 1, 1), utcOffsetSeconds: 28_800, timeZone: "Local" });
  });
  assert.equal(save.disabled, true, "a response for the previous rule cannot allow a write");
  await app.env.waitFor(() => requests.length === 2, "updated device preview");
  await app.env.act(async () => { requests[1].reject(new Error("device timeout")); });
  assert.match(dialog.textContent, /Your draft is still here/);
  await app.click("Retry preview");
  assert.equal(cron.value, "* * * * * 1-5");
  await app.env.waitFor(() => requests.length === 3, "retried device preview");
  await app.env.act(async () => {
    requests[2].resolve({ status: "valid", nextAt: Date.UTC(2040, 0, 1, 1), utcOffsetSeconds: 28_800, timeZone: "Local" });
  });
  assert.match(dialog.querySelector('[role="status"]').textContent, /9:00 AM.*UTC\+08:00/);
  assert.equal(save.disabled, false);

  await changeRule("* * * * * 0,6");
  await app.env.waitFor(() => requests.length === 4, "legacy device response");
  await app.env.act(async () => { requests[3].reject(new Error('kbrain cron request: {"error":"E:unknown_request"}')); });
  assert.match(dialog.textContent, /Update ZeroAgent on this device/);
  assert.equal(cron.value, "* * * * * 0,6");
  assert.equal(save.disabled, true);
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

test("an unrelated render cannot overwrite a browser traversal before popstate", async (t) => {
  const app = await setup(t);
  const { useCloudChatHistory } = app.env.loadModule("src/lib/useCloudChatHistory.ts");
  const { readCloudChatRoute } = app.env.loadModule("src/lib/cloudChatRoute.ts");
  const id = "11111111-1111-4111-8111-111111111111";
  const library = readCloudChatRoute(new URL("/space", window.location.href));
  function Workbench({ renderNumber }) {
    const [route, setRoute] = app.env.React.useState(library);
    useCloudChatHistory({
      owner: 42,
      active: true,
      route,
      conversation: "",
      apply: (location) => setRoute(location.route),
      isDirty: () => false,
      confirm: (navigate) => navigate(),
    });
    return app.env.React.createElement("button", {
      onClick: () => setRoute({ ...library, reader: { kind: "artifact", id } }),
      "data-reader": route.reader?.id ?? "",
      "data-render": renderNumber,
    }, "Open artifact");
  }
  window.history.replaceState({}, "", "/space");
  await app.render(app.env.React.createElement(Workbench, { renderNumber: 0 }));
  const libraryEntry = window.history.state;
  await app.click("Open artifact");
  assert.equal(window.location.pathname, `/space/artifacts/${id}`);

  // Chromium may commit the new address before delivering the traversal event.
  window.history.replaceState(libraryEntry, "", "/space");
  await app.render(app.env.React.createElement(Workbench, { renderNumber: 1 }));
  assert.equal(window.location.pathname, "/space");
  assert.equal(app.host.querySelector("button").dataset.reader, id);
  await app.env.act(async () => {
    window.dispatchEvent(new window.PopStateEvent("popstate", { state: libraryEntry }));
    await tick();
  });
  assert.equal(app.host.querySelector("button").dataset.reader, "");
  assert.equal(window.location.pathname, "/space");
});

test("desktop account navigation remembers each browsing destination without reopening its reader or borrowing another profile", async (t) => {
  const app = await setup(t);
  const { useCloudChatHistory } = app.env.loadModule("src/lib/useCloudChatHistory.ts");
  const { installDesktopCloudHost } = app.env.loadModule("src/lib/desktopRemoteHost.ts");
  const { cloudChatRouteHref, readCloudChatRoute } = app.env.loadModule("src/lib/cloudChatRoute.ts");
  const { readCloudExtensionReturnHref } = app.env.loadModule("src/lib/cloudExtensionBrowseState.ts");
  const { readCloudSpaceReturnLocation } = app.env.loadModule("src/lib/cloudSpaceBrowseState.ts");
  const { createWorkbenchAccountNavigation } = app.env.loadModule("../../agent-ui/src/application/workbenchAccountSurface.ts");
  const base = new URL("https://gateway.example.test/");
  const owner = 42;
  const scope = "https://account.example.test|user:42";
  const library = "/space/folders/qa-folder?scope=starred&type=document";
  const reader = "/space/files/qa-file?scope=starred&type=document&folder=qa-folder";
  let href = reader;
  let isCurrent = true;
  const close = installDesktopCloudHost({
    kind: "cloud", accountScope: scope, accountUser: { id: owner }, gatewayOrigin: base.href,
    isCurrent: () => isCurrent, readLocation: () => href, readConversation: () => "",
    saveLocation: (location) => { href = location; }, subscribeLocation: () => () => {},
  });
  t.after(close);
  function EmbeddedAccount({ active, route }) {
    useCloudChatHistory({
      owner, active, route, conversation: "",
      apply() {}, isDirty: () => false, confirm: (navigate) => navigate(),
    });
    return null;
  }
  const render = (active, location) => app.render(app.env.React.createElement(EmbeddedAccount, {
    active, route: typeof location === "string" ? readCloudChatRoute(new URL(location, base)) : location,
  }));
  const opened = [];
  const navigationFor = (profile) => createWorkbenchAccountNavigation(
    (location) => {
      opened.push(location);
      return readCloudChatRoute(new URL(location, base)).page === "extensions" ? "customize" : "library";
    },
    (destination) => destination === "customize" ? readCloudExtensionReturnHref(profile)
      : cloudChatRouteHref({ page: "library", location: readCloudSpaceReturnLocation(profile) }, base),
  );

  await render(true, reader);
  const navigation = navigationFor(scope);
  navigation.openDestination("library");
  assert.equal(opened.at(-1), library);
  navigation.openDestination("library", "/space");
  assert.equal(opened.at(-1), "/space", "an explicit All files link takes precedence");
  navigation.open(reader);
  assert.equal(opened.at(-1), reader, "an explicit reader link is preserved");

  await render(false, "/space?category=sites");
  await render(false, "/tasks");
  navigation.openDestination("library");
  assert.equal(opened.at(-1), library, "hidden account views cannot replace the last list");
  navigationFor("https://other.example.test|user:42").openDestination("library");
  assert.equal(opened.at(-1), "/space");
  navigationFor(owner).openDestination("library");
  assert.equal(opened.at(-1), "/space", "a browser account does not reuse a Native profile route");

  const plugin = "/plugins/product-design";
  const skill = `${plugin}/skills/design-qa?skill_revision=2`;
  await render(true, plugin);
  await render(true, skill);
  await render(true, {
    page: "extensions", location: { route: { page: "skills" }, reader: {
      id: "product-design", skillName: "design-qa", revision: 2, returnToChat: true,
    } },
  });
  await render(true, `${plugin}/manage`);
  await render(true, "/customize/drafts/previous-draft");
  navigation.close();
  await render(false, "/skills");
  await render(false, "/tasks");
  navigation.openDestination("customize");
  assert.equal(opened.at(-1), plugin, "transient views and inactive mounts leave the last plugin in place");
  assert.equal(navigation.getDestination(), "customize");
  navigation.openDestination("customize", skill);
  assert.equal(opened.at(-1), skill, "the skill deep link takes precedence");
  await render(true, "/skills");
  navigation.close();
  navigation.openDestination("customize");
  assert.equal(opened.at(-1), "/skills");
  navigationFor("https://other.example.test|user:42").openDestination("customize");
  assert.equal(opened.at(-1), "/plugins");
  navigationFor(owner).openDestination("customize");
  assert.equal(opened.at(-1), "/plugins");

  isCurrent = false;
  await render(true, "/space?category=sites");
  navigation.openDestination("library");
  assert.equal(opened.at(-1), library, "a retired Native session cannot update the last list");
  await render(true, plugin);
  navigation.openDestination("customize");
  assert.equal(opened.at(-1), "/skills", "a retired Native session cannot update Customize");
});

test("deep links retain library filters and skill identity and ignore obsolete preview links", async t => {
  const app = await setup(t);
  const { readCloudChatRoute, cloudChatRouteHref } = app.env.loadModule("src/lib/cloudChatRoute.ts");
  const normalize = path => {
    const url = new URL(path,"http://localhost");
    return cloudChatRouteHref(readCloudChatRoute(url),url);
  };
  assert.equal(normalize("/?conversation=chat-123&oauth=success"),"/");
  assert.equal(normalize("/c/chat-123?message=message-4&file=file-1"),
    "/c/chat-123?message=message-4&file=file-1");
  assert.equal(normalize("/c/chat-123?message=message-4&message=message-5"), "/c/chat-123");
  assert.equal(normalize("/c/chat-123?message=%2fnot-an-id"), "/c/chat-123");
  assert.equal(normalize("/?message=message-4"), "/");
  assert.equal(normalize("/c/chat-123?device=dev-1&message=message-4"), "/c/chat-123?device=dev-1");
  assert.equal(normalize("/?conversation=chat-123&settings=system"),"/");
  assert.equal(normalize("/settings/connections?oauth=success"),"/settings");
  assert.equal(normalize("/space/sites/version-1?folder=folder-1&scope=starred"),
    "/space/sites/version-1?folder=folder-1&scope=starred");
  assert.equal(normalize("/skills?skill_id=skill-creator"),"/skills?skill_id=skill-creator");
  assert.equal(normalize("/plugins/product-design/manage?skill_id=design-qa"),
    "/plugins/product-design/manage?skill_id=design-qa");
  assert.equal(normalize("/c/%2fprivate"),"/");
  assert.equal(normalize("/c/device-chat?device=dev-1&selection_lease=private&agent_id=dev-1"),
    "/c/device-chat?device=dev-1");
  assert.equal(normalize("/?device=dev-1"), "/?device=dev-1");
  assert.equal(readCloudChatRoute(new URL("https://zeroagent.example/c/bad%2fid?device=dev-1")).deviceId, "");
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
  assert.equal(normalize("/tasks/job-1?task_device=1"), "/tasks/job-1?task_device=1");
  const invalidDeviceTask = readCloudChatRoute(
    new URL("/tasks/job-1?task_target=dev-1&task_target=dev-2&task_device=1", deviceURL),
  );
  assert.equal(invalidDeviceTask.deviceView, true);
  assert.equal(invalidDeviceTask.target, "");
  const taskFile = "/tasks/job-1?task_run=run-1&file=report-1";
  assert.equal(normalize(taskFile), taskFile);
  const taskSource = "/tasks/job-1?task_run=run-1&task_source=source-1";
  assert.equal(normalize(taskSource), taskSource);
  assert.equal(normalize(`${taskSource}&task_from=5&task_to=17`), taskSource);
  assert.deepEqual(readCloudChatRoute(new URL(taskSource, deviceURL)).reader,
    { kind: "source", id: "source-1" });
  assert.equal(normalize(`${taskFile}&task_from=8&task_to=400`), `${taskFile}&task_from=8`);
  assert.equal(normalize(`${taskFile}&task_to=3`), taskFile);
  assert.equal(normalize("/tasks/job-1?file=report-1"), "/tasks/job-1");
  assert.equal(normalize(`${deviceHref}&artifact=version-1`), deviceHref);
  assert.equal(cloudChatRouteHref({ page: "chat", id: "" }, deviceURL), "/");
  const { readCloudChatLocation } = app.env.loadModule("src/lib/useCloudChatHistory.ts");
  window.history.replaceState({ zeroagentCloudRoute: { owner: 1, index: 1, conversation: "private" } }, "", "/c/private?message=private-message");
  assert.deepEqual(readCloudChatLocation(2), { route: { page: "chat", id: "" }, conversation: "" });
  window.history.replaceState({}, "", "/c/device-private?device=dev-1");
  assert.equal(readCloudChatLocation(1).conversation, "");
});

test("a skill reader refresh keeps the originating chat only for its exact same-account history entry", async (t) => {
  const app = await setup(t);
  const { useCloudChatHistory, readCloudChatLocation } = app.env.loadModule("src/lib/useCloudChatHistory.ts");
  const owner = 42;
  const conversation = "original-chat";
  window.history.replaceState({}, "", `/c/${conversation}`);
  function Workbench({ route }) {
    useCloudChatHistory({ owner, active: true, route, conversation, apply() {}, isDirty: () => false, confirm: (navigate) => navigate() });
    return null;
  }
  const render = (route) => app.render(app.env.React.createElement(Workbench, { route }));
  await render({ page: "chat", id: conversation });
  const reader = { id: "product-design", skillName: "audit", revision: 5, returnToChat: true };
  await render({ page: "extensions", location: { route: { page: "skills" }, reader } });
  const href = window.location.pathname + window.location.search;
  assert.equal(href, "/skills?skill_id=product-design&skill_name=audit&skill_revision=5");
  assert.equal(readCloudChatLocation(owner).conversation, conversation);
  assert.deepEqual(readCloudChatLocation(owner).route.location.reader, reader);
  assert.equal(readCloudChatLocation(owner + 1).route.page, "chat");
  window.history.replaceState(window.history.state, "", href.replace("revision=5", "revision=6"));
  assert.equal(readCloudChatLocation(owner).route.location.reader.returnToChat, undefined);
  window.history.replaceState({}, "", href);
  assert.equal(readCloudChatLocation(owner).route.location.reader.returnToChat, undefined);
});

test("the desktop host restores only its own persisted skill reader and originating conversation", async (t) => {
  const app = await setup(t);
  const { useCloudChatHistory } = app.env.loadModule("src/lib/useCloudChatHistory.ts");
  const owner = 42;
  const original = { href: "/c/host-original", conversation: "host-original", readerReturn: undefined };
  const other = { href: "/skills?skill_id=demo&skill_name=review&skill_revision=2", conversation: "other-profile", readerReturn: undefined };
  const open = (loadModule, scope, state) => loadModule("src/lib/desktopRemoteHost.ts").installDesktopCloudHost({
    kind: "cloud", accountScope: scope, accountUser: { id: owner }, gatewayOrigin: "https://gateway.example.test/",
    isCurrent: () => true, readLocation: () => state.href, readConversation: () => state.conversation,
    readSkillReaderReturn: () => state.readerReturn,
    saveLocation: (href, conversation, readerReturn) => Object.assign(state, { href, conversation, readerReturn }),
    subscribeLocation: () => () => {},
  });
  t.after(open(app.env.loadModule, "native-one", original));
  const reopen = (scope, state) => {
    const { loadModule } = createWebModuleLoader();
    t.after(open(loadModule, scope, state));
    return loadModule("src/lib/useCloudChatHistory.ts").readCloudChatLocation(owner);
  };
  function Desktop({ route, conversation }) {
    useCloudChatHistory({ owner, active: true, route, conversation, apply() {}, isDirty: () => false, confirm: (navigate) => navigate() });
    return null;
  }
  const reader = { id: "demo", skillName: "review", revision: 2, returnToChat: true };
  const readerRoute = { page: "extensions", location: { route: { page: "skills" }, reader } };
  await app.render(app.env.React.createElement(Desktop, { route: readerRoute, conversation: original.conversation }));
  assert.equal(original.readerReturn, JSON.stringify(["demo", "review", 2]));
  const second = reopen("native-two", other);
  assert.equal(second.conversation, "other-profile");
  assert.equal(second.route.location.reader.returnToChat, undefined);
  const restored = reopen("native-one", original);
  assert.equal(restored.conversation, "host-original");
  assert.deepEqual(restored.route.location.reader, reader);
});

for (const [kind, href] of [
  ["conversation", "/c/on-device?device=second"],
  ["task", "/tasks/on-device?task_run=one&task_target=second&task_device=1"],
]) test(`a device ${kind} history entry honors unsaved Cloud changes and stays out of Cloud`, async (t) => {
  const app = await setup(t);
  const { useCloudChatHistory } = app.env.loadModule("src/lib/useCloudChatHistory.ts");
  const { DEVICE_CONVERSATION_POP_EVENT, deviceWorkbenchRouteTarget, readCloudChatRoute } = app.env.loadModule("src/lib/cloudChatRoute.ts");
  let proceed;
  let admitted = 0;
  function Harness() {
    useCloudChatHistory({
      owner: 1, active: true, route: { page: "projects", id: "unsaved" }, conversation: "",
      apply: () => assert.fail(`Cloud accepted a device ${kind}`),
      isDirty: () => true,
      confirm: (navigate) => { proceed = navigate; },
    });
    return null;
  }
  await app.render(app.env.React.createElement(Harness));
  const selectDevice = () => {
    const route = readCloudChatRoute(new URL(window.location.href));
    if (deviceWorkbenchRouteTarget(route) && window.dispatchEvent(new Event(DEVICE_CONVERSATION_POP_EVENT, { cancelable: true })))
      admitted++;
  };
  const browserWindow = window;
  browserWindow.addEventListener("popstate", selectDevice);
  t.after(() => browserWindow.removeEventListener("popstate", selectDevice));
  const deviceState = { zeroagentExecutionSelection: { selection_lease: "not-in-the-url" } };
  window.history.pushState(deviceState, "", href);
  await app.env.act(async () => window.dispatchEvent(new window.PopStateEvent("popstate", { state: deviceState })));
  assert.equal(admitted, 0);
  assert.equal(window.location.pathname, "/projects/unsaved");
  assert.equal(window.history.state.zeroagentExecutionSelection, undefined);
  await app.env.act(async () => proceed());
  assert.equal(admitted, 1);
  assert.equal(window.location.pathname + window.location.search, href);
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

test("desktop workbench holds the account route and local destination until project edits are discarded", async (t) => {
  const app = await setup(t);
  const { useCloudChatHistory } = app.env.loadModule("src/lib/useCloudChatHistory.ts");
  const { installDesktopCloudHost } = app.env.loadModule("src/lib/desktopRemoteHost.ts");
  const { useUnsavedChangesPrompt } = app.env.loadModule("../../agent-ui/src/application/useUnsavedChangesPrompt.tsx");
  const { createWorkbenchAccountNavigation } = app.env.loadModule("../../agent-ui/src/application/workbenchAccountSurface.ts");
  const { useWorkbenchAccountDestination } = app.env.loadModule("../../agent-ui/src/application/useWorkbenchAccountSurface.ts");
  const writes = [];
  const project = { page: "projects", id: "design" };
  let href = "/projects/design";
  let current = true;
  let notifyLocation;
  let guard;
  const navigation = createWorkbenchAccountNavigation((location) => {
    href = location;
    writes.push(location);
    notifyLocation?.();
    return location === "/space" ? "library" : "chat";
  }, () => "/space");
  navigation.open(href);
  writes.length = 0;
  const detach = installDesktopCloudHost({
    kind: "cloud", accountScope: "desktop:1", accountUser: { id: 1 }, gatewayOrigin: "https://gateway.example.test/",
    readLocation: () => href, readConversation: () => "cloud-chat", isCurrent: () => current,
    saveLocation: (location) => { href = location; },
    subscribeLocation: (listener) => { notifyLocation = listener; return () => { notifyLocation = undefined; }; },
    registerNavigationGuard: navigation.registerNavigationGuard,
  });
  t.after(detach);
  const { createElement: h, useState } = app.env.React;
  function Harness() {
    const [route, setRoute] = useState(project);
    const [localPage, setLocalPage] = useState("Device chat");
    const destination = useWorkbenchAccountDestination(navigation);
    guard = useUnsavedChangesPrompt(1, "en-US");
    useCloudChatHistory({
      owner: 1, active: !!destination, route, conversation: "cloud-chat",
      apply: (location) => setRoute(location.route), isDirty: guard.isDirty, confirm: guard.request,
    });
    return h("div", { "data-destination": destination ?? "device", "data-route": route.page },
      h("button", { onClick: () => navigation.openDestination("library") }, "Library"),
      h("button", { onClick: () => navigation.close(() => setLocalPage("Device tasks")) }, "Scheduled tasks"),
      h("output", null, localPage),
      destination === "chat" && h("textarea", { defaultValue: "Unfinished project brief" }),
      guard.dialog,
    );
  }
  await app.render(h(Harness));
  const editor = app.host.querySelector("textarea");
  guard.setDirty(true);
  await app.click("Library");
  assert.equal(href, "/projects/design");
  assert.equal(navigation.getDestination(), "chat");
  assert.deepEqual(writes, []);
  assert.equal(document.querySelector('[role="alertdialog"] [data-slot="alert-dialog-title"]').textContent, "Leave without saving?");
  await app.click("Keep editing");
  assert.equal(app.host.querySelector("textarea"), editor);
  assert.equal(editor.value, "Unfinished project brief");

  await app.click("Scheduled tasks");
  assert.equal(app.host.querySelector("output").textContent, "Device chat");
  await app.click("Keep editing");
  assert.equal(navigation.getDestination(), "chat");
  await app.click("Library");
  await app.click("Discard and leave");
  assert.equal(href, "/space");
  assert.equal(navigation.getDestination(), "library");
  assert.equal(app.host.firstElementChild.dataset.route, "library");
  assert.deepEqual(writes, ["/space"]);

  await app.env.act(async () => navigation.open("/projects/design"));
  guard.setDirty(true);
  await app.click("Scheduled tasks");
  await app.click("Discard and leave");
  assert.equal(navigation.getDestination(), null);
  assert.equal(app.host.querySelector("output").textContent, "Device tasks");
  assert.equal(href, "/projects/design", "leaving for a device does not overwrite account history");

  await app.env.act(async () => navigation.open("/projects/design"));
  guard.setDirty(true);
  await app.click("Library");
  current = false;
  await app.click("Discard and leave");
  assert.equal(navigation.getDestination(), "chat");
  assert.equal(href, "/projects/design", "a retired account cannot apply a pending destination");
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

test("project navigation localizes controls and untitled conversations without reloading authored names", async (t) => {
  const app = await setup(t);
  const { CloudChatProjectNavigation } = app.env.loadModule("src/components/cloudchat/CloudChatProjectNavigation.tsx");
  const { LocaleContext, t: translate } = app.env.loadModule("../../agent-ui/src/i18n/index.ts");
  const project = { id: "p", name: "研发工作" };
  let projects = [];
  let projectReads = 0;
  let conversationReads = 0;
  const props = {
    client: {
      listProjects: async () => { projectReads++; return { items: projects }; },
      listConversations: async () => {
        conversationReads++;
        return { items: [
          { conversation_id: "untitled", created_at: "2026-11-01" },
          { conversation_id: "named", created_at: "2026-11-02", conversation: { title: "测试会话" } },
        ], next_before_id: "" };
      },
    },
    captureGuard: () => () => {},
    onOpen() {}, onCreate() {}, onNewConversation() {},
    renderConversation: app.renderConversation,
  };
  const render = (locale, revision) => app.render(app.env.React.createElement(LocaleContext.Provider, {
    value: { locale, t: (key) => translate(key, locale) },
  }, app.env.React.createElement(CloudChatProjectNavigation, { ...props, revision })));

  await render("en-US", 0);
  assert.ok(app.host.querySelector('section[aria-label="Cloud projects"] button[aria-label="New project"]'));
  assert.match(app.host.textContent, /Projects.*Create your first project/);

  projects = [project];
  await render("en-US", 1);
  await app.click(project.name);
  assert.ok(app.host.querySelector('button[aria-label="Project settings for 研发工作"]'));
  assert.ok(app.host.querySelector('button[aria-label="New conversation in 研发工作"]'));
  assert.equal(app.host.querySelector('[data-conversation="untitled"]').textContent, "Untitled conversation");
  assert.equal(app.host.querySelector('[data-conversation="named"]').textContent, "测试会话");

  await render("zh-CN", 1);
  assert.ok(app.host.querySelector('button[aria-label="项目设置：研发工作"]'));
  assert.equal(app.host.querySelector('[data-conversation="untitled"]').textContent, "未命名对话");
  assert.equal(app.host.querySelector('[data-conversation="named"]').textContent, "测试会话");
  assert.equal(projectReads, 2);
  assert.equal(conversationReads, 1);
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

test("an unavailable current project does not block the sidebar directory or refetch its page", async (t) => {
  const app = await setup(t);
  const { CloudChatProjectNavigation } = app.env.loadModule("src/components/cloudchat/CloudChatProjectNavigation.tsx");
  const { CloudWorkError } = app.env.loadModule("src/lib/cloudChatProjects.ts");
  const directory = [{ id: "other", name: "另一个可用项目" }];
  const reads = [];
  const actions = [];
  let rejectActive;
  let finishRetired;
  const client = {
    listProjects: async () => { reads.push(["list"]); return { items: directory }; },
    listConversations: async () => ({ items: [], next_before_id: "" }),
    getProject: async (id) => {
      reads.push(["project", id]);
      if (id === "missing") throw new CloudWorkError("missing", 404);
      if (id === "retired") return new Promise((resolve) => { finishRetired = resolve; });
      if (reads.filter((read) => read[1] === id).length === 1)
        return new Promise((_, reject) => { rejectActive = reject; });
      return { id, name: "恢复的当前项目" };
    },
  };
  const captureGuard = () => () => {};
  const render = (activeProjectId) => app.render(app.env.React.createElement(CloudChatProjectNavigation, {
    client, captureGuard, activeProjectId, revision: 0,
    onOpen: (id) => actions.push(["open", id]), onCreate() {},
    onNewConversation: (project) => actions.push(["new", project.id]),
    renderConversation: app.renderConversation,
  }));
  const act = (callback) => app.env.act(async () => { callback(); await tick(); });
  await render("current");
  await app.env.waitFor(() => rejectActive, "the current project read is pending");
  const alternative = app.host.querySelector('[aria-label="在另一个可用项目中新建对话"]');
  assert.ok(alternative, "show the independently loaded directory while the current project is pending");
  await act(() => alternative.click());
  assert.deepEqual(actions, [["new", "other"]]);
  await act(() => rejectActive(new Error("temporary outage")));
  assert.match(app.host.textContent, /另一个可用项目.*当前项目加载失败，重试/);
  const retry = [...app.host.querySelectorAll("button")].find((button) => button.textContent === "当前项目加载失败，重试");
  await act(() => { retry.focus(); retry.click(); });
  assert.equal(app.host.querySelector('[aria-label="在另一个可用项目中新建对话"]'), alternative);
  assert.equal(document.activeElement.textContent, "恢复的当前项目");
  assert.deepEqual(reads, [["list"], ["project", "current"], ["project", "current"]]);

  await render("retired");
  await app.env.waitFor(() => finishRetired, "the previous selection read is pending");
  await render("missing");
  assert.match(app.host.textContent, /另一个可用项目.*当前项目已不可用/);
  await act(() => finishRetired({ id: "retired", name: "过时的项目响应" }));
  assert.doesNotMatch(app.host.textContent, /过时的项目响应|恢复的当前项目/);
  assert.equal(reads.filter(([operation]) => operation === "list").length, 1);
});

test("a project conversation page retries its original cursor, keeps prior rows and transfers focus after the last page", async (t) => {
  const app = await setup(t);
  const { CloudChatProjectNavigation } = app.env.loadModule("src/components/cloudchat/CloudChatProjectNavigation.tsx");
  const project = { id: "p", name: "编辑项目" };
  const reads = [];
  const item = (id, title, day) => ({ conversation_id: id, created_at: day, conversation: { title, updated_at: day } });
  let failThird;
  const client = {
    async listProjects() { return { items: [project] }; },
    async listConversations(id, cursor) {
      reads.push([id, cursor]);
      if (!cursor) return { items: [item("first", "第一条会话", "2026-11-03")], next_before_id: "page-two" };
      if (cursor === "page-two") return { items: [item("second", "选中的会话", "2026-11-02")], next_before_id: "page-three" };
      if (reads.length === 3) return new Promise((_, reject) => { failThird = reject; });
      return { items: [item("third", "最后一条会话", "2026-11-01")], next_before_id: "" };
    },
  };
  await app.render(app.env.React.createElement(CloudChatProjectNavigation, {
    client, captureGuard: () => () => {}, revision: 0, activeProjectId: "p", currentConversationId: "second",
    onOpen() {}, onCreate() {},
    renderConversation: (entry) => app.env.React.createElement("button", {
      "data-conversation": entry.id, "aria-current": entry.id === "second" ? "page" : undefined,
    }, entry.title),
  }));
  const action = () => app.host.querySelector(".cloud-project-conversations button.cloud-project-list-note");
  const row = (id) => app.host.querySelector(`[data-conversation="${id}"]`);
  await app.click("加载更多会话");
  const first = row("first"), second = row("second");
  const paging = action();
  assert.ok(paging);
  await app.env.act(async () => { paging.focus(); paging.click(); paging.click(); await tick(); });
  assert.equal(paging.getAttribute("aria-busy"), "true");
  assert.equal(document.activeElement, paging);
  assert.equal(reads.length, 3);

  await app.env.act(async () => { failThird(Error("Temporary failure")); await tick(); });
  assert.equal(action(), paging);
  assert.equal(document.activeElement, paging);
  assert.equal(paging.textContent, "会话加载失败，重试");
  assert.equal(row("first"), first);
  assert.equal(row("second"), second);
  assert.equal(second.getAttribute("aria-current"), "page");

  await app.click("会话加载失败，重试");
  assert.deepEqual(reads, [["p", ""], ["p", "page-two"], ["p", "page-three"], ["p", "page-three"]]);
  assert.equal(row("first"), first);
  assert.equal(row("second"), second);
  assert.equal(action(), null);
  assert.equal(document.activeElement, row("third"));
});
