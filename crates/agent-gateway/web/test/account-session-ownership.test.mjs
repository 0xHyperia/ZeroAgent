import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return {promise,resolve}; }
const cloud = (owner) => [{runtime_kind:"web_chat",name:owner,online:true,workspaces:[{id:`cloud-${owner}`,name:owner}]}];

async function mountSession(t, {initialUser=Promise.resolve({id:1}), environments=async()=>cloud("b"), selection=async()=>null, logout=async()=>{}, href="/", historyState={}, validateSelection=async()=>true}={}) {
  const tokens=[];
  const env=await createWebDomTestEnv({mocks:{
    "@/lib/relay/client":{getRelayCurrentUser:()=>initialUser,loginRelay:async()=>({user:{id:2}}),loginRelay2FA:async()=>({user:{id:2}}),registerRelay:async()=>({user:{id:2}}),logoutRelay:logout},
    "@/lib/executionTargets":{canReuseDeviceSelection:()=>false,encodeSelectionCredential:(value)=>`lease:${value.device_id}`,getExecutionEnvironments:environments,mergeExecutionPresence:(items)=>items,publishExecutionPresence:()=>{},selectExecutionTarget:selection,validateExecutionSelection:validateSelection},
    "@/lib/gatewaySocket":{GATEWAY_SELECTION_INVALID_EVENT:"selection-invalid",resetGatewayWebSocketClient:()=>{}},
    "@/lib/storage":{setEphemeralCredential:(value)=>tokens.push(value)},
  }});
  const {useGatewaySession}=env.loadModule("src/app/hooks/useGatewaySession.ts");
  window.history.replaceState(historyState, "", href);
  let current;
  function Probe(){ current=useGatewaySession(null); return null; }
  const host=document.body.appendChild(document.createElement("div"));const root=env.createRoot(host);
  t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
  await env.act(async()=>root.render(env.React.createElement(Probe)));
  return {env,tokens,get current(){return current;}};
}

test("a previous account's delayed environment response cannot replace a new login",async(t)=>{
  const old=deferred();let requests=0;
  const app=await mountSession(t,{environments:()=>++requests===1?old.promise:Promise.resolve(cloud("b"))});
  assert.equal(app.current.accountUser.id,1);
  await app.env.act(async()=>app.current.clearSession());
  await app.env.act(async()=>assert.equal(await app.current.login("b@example.test","fixture"),"authenticated"));
  await app.env.act(async()=>{old.resolve(cloud("a"));await old.promise;});
  assert.equal(app.current.accountUser.id,2);
  assert.equal(app.current.environments[0].name,"b");
  assert.equal(app.current.selection.workspace_id,"cloud-b");
});

test("a delayed bootstrap identity cannot replace the user authenticated after it",async(t)=>{
  const old=deferred();const app=await mountSession(t,{initialUser:old.promise});
  await app.env.act(async()=>{await app.current.login("b@example.test","fixture");});
  await app.env.act(async()=>{old.resolve({id:1});await old.promise;});
  assert.equal(app.current.accountUser.id,2);
  assert.equal(app.current.authInitializing,false);
});

test("a device selection completed after logout cannot activate the old lease",async(t)=>{
  const old=deferred();const app=await mountSession(t,{selection:()=>old.promise});
  const pending=app.current.switchExecutionTarget({device_id:"a",runtime_kind:"device_agent"},{id:"a-workspace"}).catch((error)=>error);
  await app.env.act(async()=>app.current.clearSession());
  await app.env.act(async()=>{await app.current.login("b@example.test","fixture");});
  let result;
  await app.env.act(async()=>{old.resolve({runtime_kind:"device_agent",device_id:"a",selection_lease:"a-secret-lease"});result=await pending;});
  assert.match(result.message,/已变更/);
  assert.equal(app.current.accountUser.id,2);
  assert.equal(app.current.selection.runtime_kind,"web_chat");
  assert.ok(app.tokens.every((value)=>!value.includes("lease:a")));
  assert.equal(window.history.state.zeroagentExecutionSelection,undefined);
});

test("a workspace preflight gates the device handoff and the draft intent is consumed once", async (t) => {
  const app = await mountSession(t, { selection: async () => ({
    runtime_kind: "device_agent", device_id: "a", workspace_id: "", scope: "device", selection_lease: "lease-a",
  }) });
  const environment = { device_id: "a", runtime_kind: "device_agent" };
  const workspace = { id: "second", name: "Second", path: "D:/workspace/second" };
  await app.env.act(async () => {
    await assert.rejects(app.current.switchExecutionTarget(environment, workspace, {
      prepareDeviceDraft: async () => { throw new Error("project missing"); },
    }), /project missing/);
  });
  assert.equal(app.current.selection.runtime_kind, "web_chat");
  assert.ok(!app.tokens.includes("lease:a"));
  assert.equal(window.history.state?.zeroagentExecutionSelection, undefined);
  await app.env.act(async () => {
    await app.current.switchExecutionTarget(environment, workspace, {
      prepareDeviceDraft: async (target) => {
        assert.equal(target.scope, "device");
        assert.equal(target.workspace_id, "");
        return { id: workspace.id, path: workspace.path };
      },
    });
  });
  const draft = { id: "second", path: "D:/workspace/second" };
  assert.deepEqual(app.current.selection.device_draft_workspace, draft);
  assert.deepEqual(window.history.state.zeroagentDeviceDraftIntent, {
    accountId: 1, deviceId: "a", workspace: draft,
  });
  assert.equal(window.history.state.zeroagentExecutionSelection.device_draft_workspace, undefined);
  await app.env.act(async () => app.current.finishDeviceDraft("other-lease"));
  assert.deepEqual(app.current.selection.device_draft_workspace, draft);
  await app.env.act(async () => app.current.finishDeviceDraft("lease-a"));
  assert.equal(app.current.selection.device_draft_workspace, undefined);
  assert.equal(window.history.state.zeroagentDeviceDraftIntent, undefined);
  assert.equal(app.current.token, "lease:a");
});

test("returning from a pending device workspace restores Cloud without a network request", async (t) => {
  let selections = 0;
  const app = await mountSession(t, { selection: async () => {
    selections++;
    return { runtime_kind: "device_agent", device_id: "a", scope: "device", selection_lease: "lease-a" };
  } });
  const workspace = { id: "target", path: "D:/target" };
  await app.env.act(async () => {
    await app.current.switchExecutionTarget({ runtime_kind: "device_agent", device_id: "a" }, workspace, {
      prepareDeviceDraft: async () => workspace,
    });
  });
  await app.env.act(async () => app.current.returnToCloudDraft("old-lease"));
  assert.equal(app.current.selection.runtime_kind, "device_agent");
  await app.env.act(async () => app.current.returnToCloudDraft("lease-a"));
  assert.equal(app.current.selection.runtime_kind, "web_chat");
  assert.equal(app.current.selection.workspace_id, "cloud-b");
  assert.equal(app.current.token, "");
  assert.equal(window.history.state.zeroagentExecutionSelection, undefined);
  assert.equal(selections, 1);
  await app.env.act(async () => {
    const visited = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    window.history.back();
    await visited;
  });
  assert.equal(window.location.search, "?device=a");
  assert.equal(window.history.state.zeroagentDeviceDraftIntent, undefined, "cancelling clears the original entry");
});

const device = (id, online = true) => ({
  runtime_kind: "device_agent", device_id: id, agent_id: id, name: id, online, workspaces: [],
});
const lease = (id) => ({
  runtime_kind: "device_agent", device_id: id, agent_id: id, selection_lease: `selection-${id}`,
  workspace_id: "", scope: "device",
});

test("top-level switching keeps the old conversation and binds the URL to the new environment", async (t) => {
  const [cloudTarget] = cloud("account");
  const first = device("first");
  const second = device("second");
  const app = await mountSession(t, {
    href: "/c/cloud-conversation",
    environments: async () => [cloudTarget, first, second],
    selection: async (target) => target.device_id
      ? lease(target.device_id)
      : { runtime_kind: "web_chat", workspace_id: "cloud-account" },
  });
  const switchTo = (target) => app.env.act(async () =>
    app.current.switchExecutionTarget(target, { id: "", name: "" }),
  );
  await switchTo(first);
  assert.equal(window.location.pathname, "/");
  assert.equal(window.location.search, "?device=first");
  assert.equal(window.history.state.zeroagentDeviceDraftIntent, undefined);
  await switchTo(second);
  assert.equal(window.location.search, "?device=second");
  assert.equal(app.current.selection.device_id, "second");
  await switchTo(cloudTarget);
  assert.equal(window.location.search, "");
  assert.equal(app.current.selection.runtime_kind, "web_chat");
  assert.equal(window.history.state.zeroagentExecutionSelection, undefined);
});

test("retrying a disconnected handoff opens the original device workspace with a fresh lease", async (t) => {
  let online = true;
  let directoryDown = false;
  let selections = 0;
  const workspace = { id: "second-project", path: "D:/work/second" };
  const app = await mountSession(t, {
    environments: async () => {
      if (directoryDown) throw new Error("Device directory unavailable");
      return [...cloud("a"), device("second", online)];
    },
    selection: async (target) => ({ ...lease(target.device_id), selection_lease: `lease-${++selections}` }),
  });
  await app.env.act(async () => {
    await app.current.switchExecutionTarget(device("second"), workspace, {
      prepareDeviceDraft: async () => workspace,
    });
  });
  online = false;
  directoryDown = true;
  await app.env.act(async () => window.dispatchEvent(new Event("selection-invalid")));
  await app.env.act(async () => app.current.retryDeviceConversationRoute());
  assert.equal(app.current.deviceRouteStatus, "unavailable");
  directoryDown = false;
  await app.env.act(async () => app.current.retryDeviceConversationRoute());
  assert.equal(app.current.deviceRouteStatus, "unavailable");
  assert.equal(app.current.token, "");
  assert.equal(window.location.search, "?device=second");

  online = true;
  await app.env.act(async () => app.current.retryDeviceConversationRoute());
  assert.equal(app.current.deviceRouteStatus, null);
  assert.equal(app.current.selection.selection_lease, "lease-2");
  assert.deepEqual(app.current.selection.device_draft_workspace, workspace);
  await app.env.act(async () => app.current.finishDeviceDraft("lease-2"));
  assert.equal(app.current.selection.device_draft_workspace, undefined);
  assert.equal(window.history.state.zeroagentDeviceDraftIntent, undefined);
});

test("an expired handoff is recovered only for the original account and new-device route", async (t) => {
  const workspace = { id: "project", path: "D:/work/project" };
  const historyState = (accountId, deviceId) => ({
    zeroagentExecutionSelection: { ...lease(deviceId), expires_at: "2000-01-01T00:00:00Z" },
    zeroagentDeviceDraftIntent: { accountId, deviceId, workspace },
  });
  const app = await mountSession(t, {
    href: "/?device=second",
    historyState: historyState(1, "second"),
    environments: async () => [...cloud("a"), device("second")],
    selection: async (target) => lease(target.device_id),
    validateSelection: async () => assert.fail("expired leases must not be reused"),
  });
  assert.deepEqual(app.current.selection.device_draft_workspace, workspace);

  async function visit(href, state) {
    await app.env.act(async () => {
      window.history.replaceState(state, "", href);
      window.dispatchEvent(new window.PopStateEvent("popstate", { state }));
    });
  }
  for (const [href, state] of [
    ["/?device=second", historyState(2, "second")],
    ["/?device=second", historyState(1, "different")],
    ["/c/saved?device=second", historyState(1, "second")],
    ["/tasks/task?task_target=second&task_device=1", historyState(1, "second")],
  ]) {
    await visit(href, state);
    assert.equal(app.current.selection.device_id, "second");
    assert.equal(app.current.selection.device_draft_workspace, undefined, href);
    assert.equal(window.history.state.zeroagentDeviceDraftIntent, undefined);
  }
  await visit("/?device=second", historyState(1, "second"));
  assert.deepEqual(app.current.selection.device_draft_workspace, workspace);
});

test("a cold device conversation opens its authorized target before a different stored lease", async (t) => {
  const selected = [];
  const app = await mountSession(t, {
    href: "/c/existing?device=second",
    historyState: { zeroagentExecutionSelection: lease("first") },
    environments: async () => [...cloud("a"), device("first"), device("second")],
    selection: async (target) => { selected.push(target.device_id); return lease(target.device_id); },
    validateSelection: async () => assert.fail("validated a different stored device"),
  });
  assert.deepEqual(selected, ["second"]);
  assert.equal(app.current.selection.device_id, "second");
  assert.equal(app.current.deviceRouteStatus, null);
  assert.equal(window.location.pathname + window.location.search, "/c/existing?device=second");
});

test("an offline device route preserves its URL, can retry, and follows Back and Forward", async (t) => {
  let online = false;
  const requested = [];
  const app = await mountSession(t, {
    href: "/c/existing?device=second",
    environments: async () => [...cloud("a"), device("first"), device("second", online)],
    selection: async (target) => { requested.push(target.device_id); return lease(target.device_id); },
  });
  assert.equal(app.current.deviceRouteStatus, "unavailable");
  assert.equal(app.current.selection, null);
  assert.deepEqual(requested, []);
  assert.equal(window.location.pathname + window.location.search, "/c/existing?device=second");
  online = true;
  await app.env.act(async () => app.current.retryDeviceConversationRoute());
  assert.equal(app.current.selection.device_id, "second");
  assert.deepEqual(requested, ["second"]);
  async function visit(href, state = {}) {
    await app.env.act(async () => {
      window.history.replaceState(state, "", href);
      window.dispatchEvent(new window.PopStateEvent("popstate", { state }));
    });
  }
  await visit("/c/cloud-original");
  assert.equal(app.current.selection.runtime_kind, "web_chat");
  assert.equal(app.current.token, "");
  await visit("/c/existing?device=second", { zeroagentExecutionSelection: lease("second") });
  assert.equal(app.current.selection.device_id, "second");
  assert.deepEqual(requested, ["second"]);
});

test("a device task link restores the exact target, task, run, and filters through Back and Forward", async (t) => {
  const taskHref = "/tasks/job-a?task_status=paused&task_run=run-a&task_target=second&task_device=1";
  let online = false;
  const selected = [];
  const validated = [];
  const app = await mountSession(t, {
    href: taskHref,
    historyState: { zeroagentExecutionSelection: lease("first") },
    environments: async () => [...cloud("a"), device("first"), device("second", online)],
    selection: async (target, workspace) => {
      selected.push([target.device_id, workspace.id]);
      return lease(target.device_id);
    },
    validateSelection: async (value) => { validated.push(value.device_id); return true; },
  });
  const href = () => window.location.pathname + window.location.search;
  assert.equal(app.current.deviceRouteStatus, "unavailable");
  assert.equal(app.current.selection, null);
  assert.equal(href(), taskHref);
  assert.deepEqual(selected, []);

  online = true;
  await app.env.act(async () => app.current.retryDeviceConversationRoute());
  assert.equal(app.current.deviceRouteStatus, null);
  assert.equal(app.current.selection.device_id, "second");
  assert.equal(href(), taskHref);
  assert.deepEqual(selected, [["second", ""]]);
  assert.deepEqual(validated, []);

  const taskHistory = {
    zeroagentExecutionSelection: { ...lease("second"), device_draft_workspace: { id: "stale-draft" } },
  };
  async function traverse(direction) {
    await app.env.act(async () => {
      const visited = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
      window.history[direction]();
      await visited;
    });
  }
  window.history.replaceState(taskHistory, "", taskHref);
  await app.env.act(async () => app.current.returnToCloudConversation({ page: "tasks", id: "cloud-job", status: "paused" }));
  assert.equal(app.current.selection.runtime_kind, "web_chat");
  assert.equal(app.current.token, "");
  await traverse("back");
  assert.equal(app.current.selection.device_id, "second");
  assert.equal(app.current.selection.device_draft_workspace, undefined);
  assert.equal(app.current.deviceRouteStatus, null);
  assert.equal(href(), taskHref);
  assert.deepEqual(selected, [["second", ""]]);
  assert.deepEqual(validated, ["second"]);
  await traverse("forward");
  assert.equal(app.current.selection.runtime_kind, "web_chat");
  assert.equal(href(), "/tasks/cloud-job?task_status=paused");
});

test("a device task traversal waits for the Cloud draft guard", async (t) => {
  let attempts = 0;
  const app = await mountSession(t, {
    environments: async () => [...cloud("a"), device("second")],
    selection: async (target) => { attempts++; return lease(target.device_id); },
  });
  const guard = (event) => event.preventDefault();
  window.addEventListener("zeroagent:device-conversation-pop", guard, { once: true });
  await app.env.act(async () => {
    window.history.replaceState({}, "", "/tasks/job-a?task_target=second&task_device=1");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  assert.equal(app.current.selection.runtime_kind, "web_chat");
  assert.equal(attempts, 0);
});

test("an unavailable directory or malformed explicit target never loads a Cloud conversation", async (t) => {
  let directoryDown = true;
  const app = await mountSession(t, {
    href: "/c/existing?device=second",
    environments: async () => {
      if (directoryDown) throw new Error("directory offline");
      return [...cloud("a"), device("second"), device("first")];
    },
    selection: async () => assert.fail("malformed target selected a device"),
  });
  assert.equal(app.current.accountUser.id, 1);
  assert.equal(app.current.deviceRouteStatus, "unavailable");
  directoryDown = false;
  await app.env.act(async () => {
    window.history.replaceState({}, "", "/c/existing?device=second&device=first");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  assert.equal(app.current.deviceRouteStatus, "invalid-link");
  assert.equal(app.current.selection, null);
  await app.env.act(async () => app.current.returnToCloudConversation());
  assert.equal(window.location.pathname + window.location.search, "/");
  assert.equal(app.current.selection.runtime_kind, "web_chat");
});

test("ambiguous device task links cannot open an account task or another device", async (t) => {
  const invalidLinks = [
    "/tasks/shared-id?task_device=1",
    "/tasks/shared-id?task_target=first&task_target=second&task_device=1",
    "/tasks/shared-id?task_target=first&task_device=0&task_device=1",
    "/tasks/shared-id?task_target=first&task_device=1&task_run=old&task_run=latest",
    "/tasks/shared-id/extra?task_target=first&task_device=1",
  ];
  const requests = [];
  const app = await mountSession(t, {
    href: invalidLinks[0],
    environments: async () => [...cloud("a"), device("first"), device("second")],
    selection: async (target) => { requests.push(target.device_id); return lease(target.device_id); },
  });
  function assertInvalid(href) {
    assert.equal(app.current.deviceRouteStatus, "invalid-link", href);
    assert.equal(app.current.selection, null, href);
    assert.equal(app.current.token, "", href);
    assert.equal(window.location.pathname + window.location.search, href);
    assert.deepEqual(requests, []);
  }
  assertInvalid(invalidLinks[0]);
  for (const href of invalidLinks.slice(1)) {
    await app.env.act(async () => {
      window.history.replaceState({}, "", href);
      window.dispatchEvent(new window.PopStateEvent("popstate"));
    });
    assertInvalid(href);
  }
  await app.env.act(async () => app.current.returnToCloudConversation({ page: "tasks" }));
  assert.equal(window.location.pathname + window.location.search, "/tasks");
  assert.equal(app.current.selection.runtime_kind, "web_chat");
});

test("navigating Back to Cloud retires a pending device route before it can publish its lease", async (t) => {
  const pending = deferred();
  const app = await mountSession(t, {
    environments: async () => [...cloud("a"), device("second")],
    selection: () => pending.promise,
  });
  await app.env.act(async () => {
    window.history.replaceState({}, "", "/c/on-device?device=second");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  assert.equal(app.current.deviceRouteStatus, "loading");
  await app.env.act(async () => {
    window.history.replaceState({}, "", "/c/cloud-original");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  await app.env.act(async () => { pending.resolve(lease("second")); await pending.promise; });
  assert.equal(app.current.deviceRouteStatus, null);
  assert.equal(app.current.selection.runtime_kind, "web_chat");
  assert.equal(app.current.token, "");
  assert.ok(app.tokens.every((token) => token !== "lease:second"));
  assert.equal(window.location.pathname, "/c/cloud-original");
});

test("an expired tab clears locally without logging out the browser's current account", async (t) => {
  let logouts = 0;
  const app = await mountSession(t, {logout:async()=>{logouts++;}});
  // The transport test covers the server cookie; here the hook must still clear every lease.
  await app.env.act(async () => app.current.clearSession(false));
  assert.equal(app.current.accountUser, null);
  assert.equal(app.current.selection, null);
  assert.equal(app.current.token, "");
  assert.equal(logouts, 0);
  await app.env.act(async () => app.current.login("b@example.test", "fixture"));
  await app.env.act(async () => app.current.clearSession());
  assert.equal(logouts, 1, "explicit logout still revokes its own session");
});
