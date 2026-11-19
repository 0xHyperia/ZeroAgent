import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const { readCloudWorkspaceAvailability } = createWebModuleLoader().loadModule(
  "src/lib/cloudWorkspaceAvailability.ts",
);

test("the closed workspace shows public summaries without a Gateway catalog", async () => {
  const signal = new AbortController().signal;
  const unavailableResponses = [
    () => new Response(null, { status: 404 }),
    () => new Response("<html>"),
    () => Response.json({ cloud_workspace_available: false }),
    () => Response.json({ built_in_extensions: { version: 1, packages: [] } }),
    () => { throw new TypeError("Failed to fetch"); },
  ];
  for (const response of unavailableResponses) {
    const requests = [];
    const availability = await readCloudWorkspaceAvailability(async (path, init) => {
      requests.push({ path, ...init });
      return response();
    }, signal);
    assert.deepEqual(requests, [{ path: "/api/workbench/availability", cache: "no-store", signal }]);
    assert.equal(availability.available, false);
    const packages = availability.catalog.packages;
    assert.deepEqual(
      packages.filter((item) => item.kind === "plugin").map((item) => item.id),
      ["product-design", "plugin-creator"],
    );
    assert.deepEqual(
      packages.filter((item) => item.kind === "skill").map((item) => item.id),
      ["imagegen", "skill-creator", "documents", "pdf", "spreadsheet", "presentations"],
    );
    assert.ok(packages.every((item) => item.builtin && item.visibility === "public" && !item.enabled));
    assert.ok(packages.every((item) => item.skills.every((skill) => skill.entry === "")));
  }
});

test("the Gateway can publish current public summaries and explicitly open the workspace", async () => {
  const signal = new AbortController().signal;
  const bundled = await readCloudWorkspaceAvailability(
    async () => new Response(null, { status: 404 }),
    signal,
  );
  const publicPackage = { ...bundled.catalog.packages[0], overview: "Gateway overview" };
  const privatePackage = { ...publicPackage, id: "private", visibility: "personal", owned: true };
  const gatewayCatalog = { version: 7, packages: [publicPackage, privatePackage] };
  const request = (available) => async () =>
    Response.json({ cloud_workspace_available: available, built_in_extensions: gatewayCatalog });
  assert.deepEqual(await readCloudWorkspaceAvailability(request(false), signal), {
    available: false,
    catalog: { version: 7, packages: [publicPackage] },
  });
  assert.deepEqual(await readCloudWorkspaceAvailability(request(true), signal), {
    available: true,
    catalog: { version: 0, packages: [] },
  });
});
