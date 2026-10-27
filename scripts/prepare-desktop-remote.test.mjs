import assert from "node:assert/strict";
import test from "node:test";
import { wrapDesktopRemoteRuntime } from "./prepare-desktop-remote.mjs";

test("desktop WebUI factories isolate module state and can release disposed target closures", async () => {
  const wrapped = wrapDesktopRemoteRuntime(`let active = true; let target = '';
function attach(next) { target = next; return { read() { if (!active) throw Error('disposed'); return target; }, dispose() { active = false; } }; }
export { attach as mount };`);
  const module = await import(`data:text/javascript,${encodeURIComponent(wrapped)}`);
  const first = module.createDesktopRemoteRuntime().mount("device-a");
  const second = module.createDesktopRemoteRuntime().mount("device-b");
  assert.equal(first.read(), "device-a");
  assert.equal(second.read(), "device-b");
  first.dispose();
  assert.throws(() => first.read(), /disposed/);
  assert.equal(second.read(), "device-b");
});

test("factory preserves module-relative worker URLs and rejects unexpected public exports", () => {
  const source = "function mount(){ return new URL('./worker.js', import.meta.url); } export { mount };";
  assert.ok(wrapDesktopRemoteRuntime(source).includes("import.meta.url"));
  for (const unsupported of ["export default mount;", "export { mount, unsafe };", "export { open as unsafe };", "export { unsafe };"]) {
    assert.throws(() => wrapDesktopRemoteRuntime(unsupported), /exactly one mount/);
  }
});
