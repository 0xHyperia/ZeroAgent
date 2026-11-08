import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../../agent-gateway/test/helpers/dom-test-env.mjs";

const source = (path) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

test("desktop task source metadata uses the original account bridge and exact file or version", async (t) => {
  const session = { user: { id: 42 }, sessionHandle: "native-account-42", accountScope: "fixture|user:42" };
  const fileId = "11111111-1111-4111-8111-111111111111";
  const versionId = "22222222-2222-4222-8222-222222222222";
  const familyId = "33333333-3333-4333-8333-333333333333";
  const filePath = `/api/web-chat/files/${fileId}`;
  const versionPath = `/api/web-chat/artifacts/versions/${versionId}`;
  const common = { mime: "text/plain", size: 5, sha256: "a".repeat(64), state: "ready", version: 1, created_at: "fixture", updated_at: "fixture" };
  const data = new Map([
    [filePath, { file: { ...common, id: fileId, name: "Sources.txt", conversation_id: "", text_bytes: 5 } }],
    [versionPath, { version: { ...common, id: versionId, name: "Pinned brief.txt", family_id: familyId, conversation_id: fileId, source_run_id: familyId, number: 2, download_url: `${versionPath}/download` } }],
  ]);
  const open = [], requests = [], closed = [], observed = [];
  const chunks = new Map();
  let nativeSessionHandle = session.sessionHandle;
  let holdFetch = false, releaseFetch;
  const env = await createWebDomTestEnv({ mocks: {
    "@/components/cloudchat/CloudScheduleWorkspace": {
      CloudScheduleWorkspace(props) { observed.push(props); return null; },
    },
    "@/components/cloudchat/DeviceScheduleEditor": { DeviceScheduleEditor: () => null },
    "@/lib/relay/providers": { relayProviderKeyId: () => 0 },
    [source("lib/relay/desktopDeviceSchedules.ts")]: { desktopDeviceSchedules: () => ({ targetId: "local" }) },
    [source("lib/relay/nativeSession.ts")]: {
      requireNativeSession: async () => session,
      nativeSessionHandle: () => nativeSessionHandle,
    },
    [source("lib/relay/desktopRemoteHost.ts")]: { desktopAccountRequest: () => assert.fail("Metadata must use the Gateway bridge") },
    [source("shims/tauriOpener.ts")]: {},
    "@tauri-apps/api/core": {
      async invoke(command, args) {
        switch (command) {
          case "account_cloud_open":
            assert.equal(args.sessionHandle, session.sessionHandle);
            open.push(args.sessionHandle);
            return { bridgeId: `bridge-${open.length}`, origin: "https://fixture.gateway.invalid" };
          case "account_cloud_fetch": {
            const request = args.request;
            requests.push(request);
            assert.equal(request.method, "GET");
            assert.equal(request.sessionHandle, session.sessionHandle);
            assert.equal(request.bridgeId, "bridge-1");
            assert.ok(data.has(request.path), `Unexpected metadata path ${request.path}`);
            assert.equal(request.headers.accept, "application/json");
            assert.equal(request.bodyBase64, undefined);
            if (holdFetch) await new Promise((resolve) => { releaseFetch = resolve; });
            chunks.set(request.streamId, Buffer.from(JSON.stringify(data.get(request.path))).toString("base64"));
            return { status: 200, headers: { "content-type": "application/json" } };
          }
          case "account_cloud_read": {
            const chunk = chunks.get(args.streamId);
            chunks.delete(args.streamId);
            return chunk ?? null;
          }
          case "account_cloud_close":
            if (!args.streamId) closed.push(args.bridgeId);
            return undefined;
          default:
            assert.fail(`Unexpected native call ${command}`);
        }
      },
    },
  } });
  const storedSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage });
  const { DesktopScheduledTasks } = env.loadModule(source("pages/DesktopScheduledTasks.tsx"));
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  t.after(async () => {
    await env.act(async () => root.unmount());
    if (storedSession) Object.defineProperty(globalThis, "sessionStorage", storedSession);
    else delete globalThis.sessionStorage;
    container.remove();
    env.cleanup();
  });
  const settings = { locale: "en-US", customProviders: [], customSettings: { fontScale: { sidebar: 1 } } };
  const render = (owner) => env.act(async () => root.render(env.React.createElement(DesktopScheduledTasks, { owner, settings, environments: [] })));
  await render(42);
  const metadata = observed.at(-1).sourceMetadata;
  assert.ok(metadata);
  const [file, version] = await Promise.all([metadata.files.get(fileId), metadata.artifacts.get(versionId)]);
  assert.equal(file.name, "Sources.txt");
  assert.deepEqual([version.id, version.name, version.number], [versionId, "Pinned brief.txt", 2]);
  assert.deepEqual(requests.map(({ path }) => path), [filePath, versionPath]);
  assert.deepEqual(open, [session.sessionHandle]);

  holdFetch = true;
  const late = assert.rejects(metadata.files.get(fileId), /Account changed/i);
  await env.waitFor(() => releaseFetch, "metadata request reached the native bridge");
  nativeSessionHandle = "native-account-43";
  releaseFetch();
  await late;
  nativeSessionHandle = session.sessionHandle;

  await render(43);
  assert.ok(observed.filter(({ owner }) => owner === 43).every(({ sourceMetadata }) => !sourceMetadata));
  assert.deepEqual(closed, ["bridge-1", "bridge-2"]);
  await assert.rejects(metadata.artifacts.get(versionId), /Account changed/i);
  assert.equal(requests.length, 3);
});
