import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("device cron reads do not raise or clear a calendar time zone notice", async () => {
  const settings = { preference: "Asia/Shanghai", timeZone: "Asia/Shanghai", revision: 1 };
  let cronZone = "Local";
  let calendarZone = settings.timeZone;
  const loader = createTsModuleLoader({ mocks: {
    "@liveagent/app/shims/tauriCore": { invoke: async () => {} },
    "../host": { isTauriHost: () => true },
    "../kbrain/mapping": { kBrainStorageScope: () => "timezone-notice-cron" },
    "../kbrain/transport": { fetchKBrain: async (_path, init) => {
      const { action } = JSON.parse(init.body);
      const result = action === "cron.occurrences"
        ? { timeZone: cronZone, occurrences: [] }
        : action === "query" ? { timeZone: calendarZone } : settings;
      return Response.json(result);
    } },
  } });
  const { requestPlanning } = loader.loadModule("src/lib/planning/kbrain.ts");
  const { getTimeZoneNotice } = loader.loadModule("src/lib/planning/timeZoneNotice.ts");
  const notice = () => getTimeZoneNotice("timezone-notice-cron");

  await requestPlanning("timezone.get");
  for (let read = 0; read < 2; read++) {
    assert.equal((await requestPlanning("cron.occurrences")).timeZone, "Local");
    assert.equal(notice(), null);
  }
  calendarZone = "Custom/Unknown";
  await requestPlanning("query");
  const warning = notice();
  assert.equal(warning.kind, "unsupported");
  assert.equal(warning.effective, calendarZone);
  await requestPlanning("cron.occurrences");
  assert.equal(notice(), warning);
  cronZone = "Asia/Shanghai";
  await requestPlanning("cron.occurrences");
  assert.equal(notice(), warning);
  await requestPlanning("timezone.get");
  assert.equal(notice(), null);
});

test("time zone notice is passive, scoped, dismissible, deduplicated and cleared after recovery", () => {
  const storage = new Map();
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
  try {
    const api = createTsModuleLoader().loadModule("src/lib/planning/timeZoneNotice.ts");
    assert.equal(api.getTimeZoneNotice("a"), null);
    api.reportTimeZoneFailure("a", new Error("offline"));
    assert.equal(api.getTimeZoneNotice("a"), null);
    api.reportTimeZoneFailure("a", new Error("E:timezone_invalid"));
    assert.equal(api.getTimeZoneNotice("a").kind, "invalid");
    assert.equal(api.getTimeZoneNotice("b"), null);
    const first = api.getTimeZoneNotice("a");
    api.reportTimeZoneFailure("a", "E:timezone_invalid");
    assert.equal(api.getTimeZoneNotice("a"), first);
    api.dismissTimeZoneNotice("a");
    api.reportTimeZoneFailure("a", "E:timezone_invalid");
    assert.equal(api.getTimeZoneNotice("a"), null);
    const reloaded = createTsModuleLoader().loadModule("src/lib/planning/timeZoneNotice.ts");
    reloaded.reportTimeZoneFailure("a", "E:timezone_invalid");
    assert.equal(reloaded.getTimeZoneNotice("a"), null);
    api.observeTimeZoneResponse("a", "query", {timeZone:"Asia/Shanghai"});
    api.reportTimeZoneFailure("a", "E:timezone_invalid");
    assert.equal(api.getTimeZoneNotice("a").kind, "invalid");
    api.observeTimeZoneResponse("a", "timezone.get", {preference:"America/New_York",timeZone:"America/New_York",systemTimeZone:"Asia/Shanghai"});
    assert.equal(api.getTimeZoneNotice("a"), null, "intentional custom zone is valid");
    api.observeTimeZoneResponse("a", "timezone.get", {preference:"US/Eastern",timeZone:"America/New_York"});
    assert.equal(api.getTimeZoneNotice("a"), null, "IANA aliases are equivalent");
    api.observeTimeZoneResponse("a", "timezone.get", {preference:"Asia/Tokyo",timeZone:"Asia/Shanghai"});
    assert.equal(api.getTimeZoneNotice("a").kind, "mismatch");
    api.observeTimeZoneResponse("a", "query", {timeZone:"Asia/Shanghai"});
    assert.equal(api.getTimeZoneNotice("a").kind, "mismatch", "unrelated query must not clear preference mismatch");
    api.observeTimeZoneResponse("a", "timezone", {preference:"Asia/Tokyo",timeZone:"Asia/Tokyo"});
    assert.equal(api.getTimeZoneNotice("a"), null);
    api.observeTimeZoneResponse("a", "query", {timeZone:"Custom/Unknown"});
    assert.equal(api.getTimeZoneNotice("a").kind, "unsupported");
  } finally { globalThis.sessionStorage = previous; }
});

test("following the system, a device zone change since startup asks for a restart", () => {
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = undefined;
  try {
    const api = createTsModuleLoader().loadModule("src/lib/planning/timeZoneNotice.ts");
    const auto = { preference: "", timeZone: "Asia/Shanghai", systemTimeZone: "Asia/Shanghai" };
    api.observeTimeZoneResponse("d", "timezone.get", auto, "Asia/Shanghai");
    assert.equal(api.getTimeZoneNotice("d"), null);
    // Aliases and zones on the same clock all year are not a change.
    api.observeTimeZoneResponse("d", "timezone.get", auto, "Asia/Chongqing");
    assert.equal(api.getTimeZoneNotice("d"), null);
    api.observeTimeZoneResponse("d", "timezone.get", auto, "Europe/Paris");
    assert.deepEqual(JSON.parse(JSON.stringify(api.getTimeZoneNotice("d"))), {
      kind: "device", effective: "Asia/Shanghai", device: "Europe/Paris",
    });
    api.observeTimeZoneResponse("d", "query", { timeZone: "Asia/Shanghai" });
    assert.equal(api.getTimeZoneNotice("d").kind, "device", "unrelated queries keep it");
    // A custom zone is intentional: never flagged against the device.
    api.observeTimeZoneResponse("d", "timezone", { preference: "Asia/Tokyo", timeZone: "Asia/Tokyo" }, "Europe/Paris");
    assert.equal(api.getTimeZoneNotice("d"), null);
  } finally { globalThis.sessionStorage = previous; }
});
