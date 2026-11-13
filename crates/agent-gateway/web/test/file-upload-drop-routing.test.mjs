import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const {
  FILE_UPLOAD_CONVERSATION_ATTRIBUTE,
  FILE_UPLOAD_DROP_ZONE_SELECTOR,
  resolveFileUploadConversationId,
  resolveFileUploadDropZone,
} = loader.loadModule("src/app/hooks/fileUploadDropRouting.ts");

function targetInside(zone) {
  return {
    closest(selector) {
      assert.equal(selector, FILE_UPLOAD_DROP_ZONE_SELECTOR);
      return zone;
    },
  };
}

test("file upload routing resolves the landing Pane conversation", () => {
  const zone = {
    getAttribute(attribute) {
      assert.equal(attribute, FILE_UPLOAD_CONVERSATION_ATTRIBUTE);
      return "  background-conversation  ";
    },
  };
  const target = targetInside(zone);

  assert.equal(resolveFileUploadDropZone(target), zone);
  assert.equal(resolveFileUploadConversationId(target), "background-conversation");
});

test("file upload routing does not invent ownership outside a marked composer", () => {
  assert.equal(resolveFileUploadConversationId(targetInside(null)), null);
  assert.equal(resolveFileUploadConversationId({}), null);
  assert.equal(
    resolveFileUploadConversationId(
      targetInside({
        getAttribute() {
          return "   ";
        },
      }),
    ),
    null,
  );
});

test("paste and drop freeze the landing target before asynchronous file reads", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/app/hooks/usePendingUploads.ts", import.meta.url)),
    "utf8",
  );

  assert.match(
    source,
    /const uploadTarget = resolveEventUploadTarget\(event\.target\);[\s\S]*?readClipboardFiles\(\)[\s\S]*?handleImportReadableFiles\(files, uploadTarget\)/,
  );
  assert.match(
    source,
    /const uploadTarget = resolveEventUploadTarget\(event\.target\);[\s\S]*?snapshotDroppedEntries\(event\.dataTransfer\)[\s\S]*?handleImportReadableFiles\(payload\.files, uploadTarget\)/,
  );
  assert.match(source, /handleImportReadableFiles\(files, uploadTarget\)/);
});

test("a switched device's late upload cannot attach files, report an error, or clear the new upload", async (t) => {
  const imports = [];
  const notifications = [];
  const env = await createWebDomTestEnv({
    mocks: {
      "@/lib/uploadReadableFiles": {
        importReadableFiles(token, agentId, workdir, files, signal) {
          return new Promise((resolve, reject) => {
            imports.push({ token, agentId, workdir, files, signal, resolve, reject });
          });
        },
      },
    },
  });
  const { usePendingUploads } = env.loadModule("src/app/hooks/usePendingUploads.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  let current;
  function Probe({ device }) {
    current = usePendingUploads({
      token: `lease-${device}`,
      workspaceOwner: device,
      resolveAgentID: async () => device,
      settingsSyncReady: true,
      locale: "en-US",
      activeView: "chat",
      executionMode: "tools",
      conversationId: `${device}-conversation`,
      displayedConversationWorkdirRef: { current: `D:/${device}` },
      composerRef: { current: null },
      addNotify: (tone, message) => notifications.push({ tone, message }),
      workdirForConversation: () => `D:/${device}`,
    });
    return null;
  }
  t.after(async () => {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  });
  const render = (device) => env.act(async () => root.render(env.React.createElement(Probe, { device })));
  await render("old-device");
  let oldUpload;
  await env.act(async () => {
    oldUpload = current.handleImportReadableFiles([new File(["old"], "old.txt")]);
  });
  assert.equal(imports[0].agentId, "old-device");
  assert.equal(current.isUploadingFiles, true);

  await render("new-device");
  assert.equal(imports[0].signal.aborted, true);
  assert.equal(current.isUploadingFiles, false);
  let newUpload;
  await env.act(async () => {
    newUpload = current.handleImportReadableFiles([new File(["new"], "new.txt")]);
  });
  assert.equal(imports[1].agentId, "new-device");
  await env.act(async () => {
    imports[0].reject(new Error("late upload error"));
    await oldUpload;
  });
  assert.equal(current.isUploadingFiles, true);
  assert.deepEqual(notifications, []);

  const file = { relativePath: "uploads/new.txt", fileName: "new.txt", kind: "text", sizeBytes: 3 };
  await env.act(async () => {
    imports[1].resolve({ files: [file], skipped: [] });
    await newUpload;
  });
  assert.equal(current.isUploadingFiles, false);
  assert.deepEqual(current.getPendingUploadsForConversation("old-device-conversation"), []);
  assert.deepEqual(current.pendingUploadedFiles, [file]);
});
