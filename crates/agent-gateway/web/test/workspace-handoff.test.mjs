import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("an unconfirmed handoff is recovered after reopening and a rejected target is not pending", async (t) => {
  const env = await createWebDomTestEnv();
  const { React, act, createRoot } = env;
  const { WorkspaceHandoffDialog } = env.loadModule("src/components/cloudchat/WorkspaceHandoffDialog.tsx");
  const { WorkspaceHandoffRejected } = env.loadModule("src/lib/workspaceHandoff.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  });
  const source = { kind: "file", target_id: "file-1", name: "Report.pdf" };
  const target = {
    runtime_kind: "device_agent",
    device_id: "device-1",
    name: "Device One",
    online: true,
    workspaces: [{ id: "first", name: "First project", path: "/workspace/first" }, { id: "second", name: "Second project", path: "/workspace/second" }],
  };
  const calls = [];
  let reject = true;
  let missing = true;
  let canReadOriginal = true;
  let loseNextCopy = false;
  let reads = 0;
  const send = async (request) => {
    calls.push(request);
    if (reject) throw new WorkspaceHandoffRejected("authorization");
    if (loseNextCopy && !request.checkOnly) {
      loseNextCopy = false;
      throw new Error("simulated lost receipt");
    }
    if (request.checkOnly && missing) return null;
    return `ZA-${request.operationId}/ZA-Report.pdf`;
  };
  const render = (open, targets = [target]) => act(async () => root.render(open ? React.createElement(WorkspaceHandoffDialog, {
    owner: 23, source, targets,
    read: async () => {
      reads++;
      if (!canReadOriginal) throw new Error("source is unavailable");
      return { blob: new Blob(["sample bytes"]), filename: source.name };
    },
    send, onClose: () => undefined,
  }) : null));
  const button = (label) => [...document.querySelectorAll('button')].find((element) => label.test(element.textContent));
  async function select(triggerLabel, optionLabel) {
    const trigger = [...document.querySelectorAll('[role="combobox"]')]
      .find((element) => triggerLabel.test(element.getAttribute("aria-label")));
    assert.ok(trigger, `Missing ${triggerLabel} select`);
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((element) => element.textContent.startsWith(optionLabel));
    assert.ok(option, `Missing ${optionLabel} option`);
    await act(async () => option.click());
  }
  async function chooseSecond() {
    await select(/设备|^Device$/, "Device One");
    await select(/工作区|^Workspace$/, "Second project");
  }
  await render(true);
  assert.equal(button(/确认复制|Confirm copy/).disabled, true);
  await chooseSecond();
  const [deviceControl, workspaceControl] = document.querySelectorAll('[role="combobox"]');
  await render(true, []);
  assert.equal(deviceControl.textContent, "Device One");
  assert.equal(workspaceControl.textContent, "Second project");
  assert.ok(button(/确认复制|Confirm copy/).disabled);
  assert.match(document.querySelector('[role="status"]').textContent, /所选设备暂不可用|The selected device is unavailable/);
  await render(true, [{ ...target, workspaces: [] }]);
  assert.equal(workspaceControl.textContent, "Second project");
  assert.ok(workspaceControl.disabled, "there are no workspaces to choose from");
  assert.ok(button(/确认复制|Confirm copy/).disabled);
  assert.match(document.querySelector('[role="status"]').textContent, /工作区暂不可用|The workspace on the selected device is unavailable/);
  await render(true, [{ ...target, workspaces: [target.workspaces[0]] }]);
  assert.equal(workspaceControl.textContent, "Second project");
  assert.ok(!workspaceControl.disabled, "another workspace can be chosen explicitly");
  assert.ok(button(/确认复制|Confirm copy/).disabled, "the other workspace is not selected implicitly");
  await render(true);
  assert.equal(button(/确认复制|Confirm copy/).disabled, false);
  assert.equal(calls.length, 0, "directory changes never trigger a copy");
  await act(async () => button(/确认复制|Confirm copy/).click());
  assert.equal(calls[0].workspaceId, "second");
  assert.ok(document.querySelector('[role="alert"]'));
  assert.ok(button(/确认复制|Confirm copy/));
  assert.equal(window.sessionStorage.length, 0);

  reject = false;
  loseNextCopy = true;
  await act(async () => button(/确认复制|Confirm copy/).click());
  assert.ok(button(/核对传输|Check transfer/));
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(window.sessionStorage.length, 1);
  await render(false);
  await render(true, [{ ...target, online: false }]);
  assert.ok(button(/核对传输|Check transfer/).disabled);
  const [restoredDevice, restoredProject] = document.querySelectorAll('[role="combobox"]');
  assert.equal(restoredDevice.textContent, "Device One");
  assert.equal(restoredProject.textContent, "Second project");
  assert.match(document.querySelector('[role="dialog"]').textContent, /原目标暂不可用|The original destination is unavailable/);
  assert.equal(calls.length, 2, "reopening an unconfirmed handoff never queries or copies");
  await render(true, []);
  assert.equal(restoredDevice.textContent, "Device One");
  assert.equal(restoredProject.textContent, "Second project");
  assert.ok(button(/核对传输|Check transfer/).disabled);
  await render(true, [{ ...target, workspaces: [target.workspaces[0]] }]);
  assert.ok(button(/核对传输|Check transfer/).disabled, "an absent original workspace is not substituted");
  await render(true);
  assert.equal(button(/核对传输|Check transfer/).disabled, false);
  canReadOriginal = false;
  await act(async () => button(/核对传输|Check transfer/).click());
  assert.equal(calls[2].workspaceId, "second");
  assert.equal(calls[2].operationId, calls[1].operationId);
  assert.notEqual(calls[2].operationId, calls[0].operationId);
  assert.equal(calls[2].checkOnly, true);
  assert.equal(calls[2].blob, undefined);
  assert.equal(reads, 2);
  assert.ok(button(/重试复制|Retry copy/));
  assert.equal(window.sessionStorage.length, 1);
  missing = false;
  await act(async () => button(/核对传输|Check transfer/).click());
  assert.equal(calls[3].operationId, calls[1].operationId);
  assert.equal(calls[3].checkOnly, true);
  assert.equal(reads, 2);
  assert.equal(window.sessionStorage.length, 0);
  await render(true, []);
  assert.match(document.querySelector('[role="status"]').textContent, /Device One · Second project/);
  assert.match(document.querySelector('[role="status"]').textContent, /ZA-Report\.pdf/);

  await render(false);
  await render(true);
  await chooseSecond();
  canReadOriginal = true;
  missing = true;
  loseNextCopy = true;
  await act(async () => button(/确认复制|Confirm copy/).click());
  const firstCopy = calls.at(-1);
  await act(async () => button(/核对传输|Check transfer/).click());
  assert.equal(calls.at(-1).checkOnly, true);
  await act(async () => button(/重试复制|Retry copy/).click());
  assert.equal(calls.at(-1).operationId, firstCopy.operationId);
  assert.equal(calls.at(-1).checkOnly, undefined);
  assert.ok(calls.at(-1).blob);
  assert.equal(reads, 4);
  assert.equal(window.sessionStorage.length, 0);
});

test("handoff recovery lists separate pending destinations and keeps account and source versions isolated", async (t) => {
  const env = await createWebDomTestEnv();
  const { React, act, createRoot } = env;
  const { WorkspaceHandoffDialog } = env.loadModule("src/components/cloudchat/WorkspaceHandoffDialog.tsx");
  const { savePendingWorkspaceHandoff } = env.loadModule("src/lib/workspaceHandoff.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); env.cleanup(); });
  const source = { kind: "artifact", target_id: "fixed-version", name: "Brief.md", artifactNumber: 2 };
  const prefix = "zeroagent.handoff:23:artifact:fixed-version:";
  const firstOperation = "11111111-1111-4111-8111-111111111111";
  const exactOperation = "22222222-2222-4222-8222-222222222222";
  window.sessionStorage.setItem(`${prefix}old:project`, firstOperation);
  savePendingWorkspaceHandoff(prefix, { operationId: firstOperation, deviceId: "first", workspaceId: "project", deviceName: "First device", workspaceName: "First project", workspacePath: "/workspace/first" });
  savePendingWorkspaceHandoff(prefix, { operationId: exactOperation, deviceId: "device-2", workspaceId: "workspace:exact", deviceName: "Saved device", workspaceName: "Saved project", workspacePath: "/workspace/exact" });
  const foreign = { operationId: exactOperation, deviceId: "foreign", workspaceId: "private", deviceName: "Other account", workspaceName: "Other version", workspacePath: "/workspace/foreign" };
  savePendingWorkspaceHandoff("zeroagent.handoff:99:artifact:fixed-version:", foreign);
  savePendingWorkspaceHandoff("zeroagent.handoff:23:artifact:other-version:", foreign);
  const targets = [
    { runtime_kind:"device_agent", device_id:"first", name:"First device", online:true, workspaces:[{id:"project",name:"First project",path:"/workspace/first"}] },
    { runtime_kind:"device_agent", device_id:"device-2", name:"Renamed device", online:true, workspaces:[{id:"workspace:exact",name:"Renamed project",path:"/workspace/exact"}] },
  ];
  const writes = [];
  await act(async () => root.render(React.createElement(WorkspaceHandoffDialog, {
    owner:23, source, targets,
    read: async () => assert.fail("receipt recovery must not fetch the original"),
    send: async (request) => { writes.push(request); return request.operationId === firstOperation ? null : `ZA-${request.operationId}/ZA-Brief.md`; },
    onClose() {},
  })));
  const dialog = document.querySelector('[role="dialog"]');
  const button = (label) => [...dialog.querySelectorAll('button')].find((element) => label.test(element.textContent));
  assert.ok(button(/确认复制|Confirm copy/).disabled, "several pending transfers require choosing the exact destination");
  assert.doesNotMatch(dialog.textContent, /Other account|Other version/);
  assert.deepEqual(writes, []);
  await act(async () => { button(/First device · First project/).click(); });
  assert.ok(button(/核对传输|Check transfer/));
  await act(async () => { button(/核对传输|Check transfer/).click(); });
  assert.ok(button(/重试复制|Retry copy/));
  await act(async () => { button(/Saved device · Saved project/).click(); });
  await act(async () => { button(/核对传输|Check transfer/).click(); });
  assert.deepEqual(writes.map(({operationId,deviceId,workspaceId,checkOnly,blob})=>({operationId,deviceId,workspaceId,checkOnly,blob})), [
    { operationId:firstOperation, deviceId:"first", workspaceId:"project", checkOnly:true, blob:undefined },
    { operationId:exactOperation, deviceId:"device-2", workspaceId:"workspace:exact", checkOnly:true, blob:undefined },
  ]);
  assert.match(dialog.textContent, /Saved device · Saved project/);
  assert.equal(window.sessionStorage.getItem(`${prefix}old:project`), firstOperation);
  assert.equal(window.sessionStorage.length, 4);
});

test("same-name workspaces show their paths and a remapped directory needs an explicit choice", async (t) => {
  const env = await createWebDomTestEnv();
  const { React, act, createRoot } = env;
  const { WorkspaceHandoffDialog } = env.loadModule("src/components/cloudchat/WorkspaceHandoffDialog.tsx");
  const { WorkspaceHandoffRejected } = env.loadModule("src/lib/workspaceHandoff.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); env.cleanup(); });
  const source = { kind: "file", target_id: "exact-target", name: "Report.pdf" };
  const west = "D:/work/west/Design";
  const east = "D:/work/east/Design";
  const moved = "D:/work/very-long-unbroken-new-location/Design";
  const devicePath = "D:/work/current-location/Design";
  const targets = (path) => [{
    runtime_kind: "device_agent", device_id: "design-device", name: "Design workstation", online: true,
    workspaces: [{ id: "west", name: "Design", path: west }, { id: "east", name: "Design", path }],
  }, {
    runtime_kind: "device_agent", device_id: "legacy-device", name: "Legacy workstation", online: true,
    workspaces: [{ id: "pathless", name: "Legacy", path: "   " }],
  }];
  const requests = [];
  let staleRemote = true;
  const send = async (request) => {
    requests.push(request);
    if (staleRemote) throw new WorkspaceHandoffRejected("target-changed");
    if (!request.checkOnly) throw new Error("reply lost");
    return "ZA-fixture/ZA-Report.pdf";
  };
  let resolveRead;
  const render = (path, open = true) => act(async () => root.render(open ? React.createElement(WorkspaceHandoffDialog, {
    owner: 1, source, targets: targets(path), send, onClose() {},
    read: () => new Promise((resolve) => { resolveRead = resolve; }),
  }) : null));
  const button = (label) => [...document.querySelectorAll("button")].find((element) => label.test(element.textContent));
  const openPicker = async (index) => {
    const trigger = document.querySelectorAll('[role="combobox"]')[index];
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    return [...document.querySelectorAll('[role="option"]')];
  };
  const selectPath = async (path) => {
    const options = await openPicker(1);
    assert.ok(options.some((option) => option.textContent.includes(west)));
    const exact = options.find((option) => option.textContent.includes(path));
    assert.ok(exact, `workspace option identifies ${path}`);
    await act(async () => exact.click());
    const control = document.querySelectorAll('[role="combobox"]')[1];
    assert.equal(document.getElementById(control.getAttribute("aria-describedby"))?.textContent, path);
  };
  const finishRead = () => act(async () => resolveRead({ blob: new Blob(["source"]), filename: source.name }));

  await render(east);
  const [device, legacyDevice] = await openPicker(0);
  assert.equal(legacyDevice.getAttribute("aria-disabled"), "true");
  assert.match(legacyDevice.textContent, /未公布目录路径|Directory paths unavailable/);
  await act(async () => device.click());
  await selectPath(east);
  await render(undefined);
  assert.ok(button(/确认复制|Confirm copy/).disabled);
  assert.match(document.querySelector('[role="dialog"]').textContent, /尚未公布所选目录|hasn't published the selected directory path/);
  assert.doesNotMatch(document.querySelector('[role="dialog"]').textContent, /目录路径已变化|directory path changed/);
  const selectedWorkspace = document.querySelectorAll('[role="combobox"]')[1];
  assert.equal(document.getElementById(selectedWorkspace.getAttribute("aria-describedby"))?.textContent, east);
  assert.equal(requests.length, 0);
  await render(east);
  assert.equal(button(/确认复制|Confirm copy/).disabled, false);
  await act(async () => button(/确认复制|Confirm copy/).click());
  await render(moved);
  await finishRead();
  assert.equal(requests.length, 0, "a moved destination cannot receive a prepared source");
  assert.ok(button(/确认复制|Confirm copy/).disabled);
  assert.match(document.querySelector('[role="dialog"]').textContent, /目录路径已变化|directory path changed/);

  await selectPath(moved);
  await act(async () => button(/确认复制|Confirm copy/).click());
  await finishRead();
  assert.equal(requests[0].workspaceId, "east");
  assert.equal(requests[0].workspacePath, moved);
  assert.equal(window.sessionStorage.length, 0, "a definitive remote refusal is not an unknown copy");
  assert.ok(button(/确认复制|Confirm copy/).disabled, "the stale published row cannot be sent again");
  assert.match(document.querySelector('[role="alert"]').textContent, /列表更新后|once the list updates/);
  await render(devicePath);
  await selectPath(devicePath);
  staleRemote = false;
  await act(async () => button(/确认复制|Confirm copy/).click());
  await finishRead();
  assert.equal(requests[1].workspacePath, devicePath);
  await render(devicePath, false);
  await render(undefined);
  assert.ok(button(/核对传输|Check transfer/).disabled);
  assert.match(document.querySelector('[role="dialog"]').textContent, /暂未公布原目录|hasn't published the original directory path/);
  assert.equal(window.sessionStorage.length, 1, "missing path publication does not discard the original operation");
  assert.equal(requests.length, 2);
  await render(east);
  assert.ok(button(/核对传输|Check transfer/).disabled, "reopening does not move a pending receipt to a new path");
  assert.equal(requests.length, 2);
  await render(devicePath);
  await act(async () => button(/核对传输|Check transfer/).click());
  assert.equal(requests[2].operationId, requests[1].operationId);
  assert.equal(requests[2].workspacePath, devicePath);
  assert.equal(requests[2].checkOnly, true);
});

test("the workspace transport checks a receipt without submitting a name or request body", async () => {
  const { sendWorkspaceHandoff } = createTsModuleLoader({
    rootDir: fileURLToPath(new URL("..", import.meta.url)),
  }).loadModule("src/lib/workspaceHandoff.ts");
  const selection = {
    selection_lease: "workspace-lease", runtime_kind: "device_agent", device_id: "device-1",
    workspace_id: "workspace-2", scope: "workspace",
  };
  const request = {
    deviceId: selection.device_id, workspaceId: selection.workspace_id,
    workspacePath: "D:/工程/确认的工作区",
    operationId: "11111111-1111-4111-8111-111111111111", checkOnly: true,
    signal: new AbortController().signal,
  };
  let calls = 0;
  const notFound = await sendWorkspaceHandoff(request, selection, async (path, init) => {
    calls++;
    const url = new URL(path, "https://fixture.local");
    assert.equal(url.pathname, "/api/files/confirmed-handoff");
    assert.ok(!path.includes("workspace_path"), "the confirmed directory is not written into the URL");
    assert.equal(Buffer.from(init.headers["X-ZeroAgent-Workspace-Path"], "base64url").toString("utf8"), request.workspacePath);
    assert.equal(url.searchParams.get("operation_id"), request.operationId);
    assert.equal(url.searchParams.has("name"), false);
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    return Response.json({ status: "not_found" });
  });
  assert.equal(notFound, null);
  await assert.rejects(sendWorkspaceHandoff({ ...request, workspaceId: "other" }, selection, () => {
    calls++;
  }), /target/);
  assert.equal(calls, 1);
  await assert.rejects(sendWorkspaceHandoff(request, selection, () => Response.json({}, { status: 412 })), /target-changed/);
  for (const [status, reason] of [[404, /gateway-upgrade/], [426, /device-upgrade/]]) {
    await assert.rejects(sendWorkspaceHandoff(request, selection, () => Response.json({}, { status })), reason);
  }
});
