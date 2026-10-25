import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { transpileTypeScriptModule } from "./typescript-source-tools.mjs";

function evaluate(code) {
  const module = { exports:{} };
  vm.runInNewContext(code, {module,exports:module.exports});
  return module.exports;
}

test("source changes at an existing path do not reuse stale compiler output", () => {
  const file = path.resolve("fixture.ts");
  assert.equal(evaluate(transpileTypeScriptModule("export const value: number = 1", file)).value, 1);
  assert.equal(evaluate(transpileTypeScriptModule("export const value: number = 2", file)).value, 2);
});

test("cached compiler output still evaluates with independent module state", () => {
  const source = "let count = 0; export const next = () => ++count;";
  const file = path.resolve("state.ts");
  const first = evaluate(transpileTypeScriptModule(source, file));
  assert.equal(first.next(), 1);
  assert.equal(first.next(), 2);
  const second = evaluate(transpileTypeScriptModule(source, file));
  assert.equal(second.next(), 1);
});

test("identical sources in different files retain their own import.meta URL", () => {
  const source = "export const location = import.meta.url;";
  for (const file of [path.resolve("first.ts"), path.resolve("second.ts")]) {
    assert.equal(evaluate(transpileTypeScriptModule(source, file)).location, pathToFileURL(file).href);
  }
});

test("CommonJS test metadata preserves literals, identity, URL and absent Vite fields", () => {
  const file=path.resolve("metadata.ts");
  const result=evaluate(transpileTypeScriptModule(`
    export const text = "literal import.meta.url and import.meta.env";
    export const location = import.meta["url"];
    export const same = import.meta === import.meta;
    export const env = import.meta.env?.VITE_KBRAIN_URL;
    export const hot = import.meta.hot;
  `,file));
  assert.equal(result.text,"literal import.meta.url and import.meta.env");
  assert.equal(result.location,pathToFileURL(file).href);
  assert.equal(result.same,true);
  assert.equal(result.env,undefined);
  assert.equal(result.hot,undefined);
});

test("TSX keeps automatic JSX and dependency imports in the isolated evaluator", () => {
  const code=transpileTypeScriptModule('import {label} from "fixture"; export const view = <span title={label}>Hello</span>;',path.resolve("view.tsx"));
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,require:(name)=>name==="fixture"?{label:"Native"}:{jsx:(type,props)=>({type,props})}});
  assert.equal(module.exports.view.type,"span");
  assert.equal(module.exports.view.props.title,"Native");
  assert.equal(module.exports.view.props.children,"Hello");
});

test("cyclic imports preserve hoisted functions and live re-exports",()=>{
  const sources={
    a:'import {b} from "b"; export function answer(){return b();} export {answer as forwarded};',
    b:'import {forwarded} from "a"; export {forwarded}; export function b(){return 42;}',
  };
  const modules=new Map();
  const load=(name)=>{
    if(modules.has(name))return modules.get(name).exports;
    const module={exports:{}}; modules.set(name,module);
    const code=transpileTypeScriptModule(sources[name],path.resolve(`${name}.ts`));
    vm.runInNewContext(code,{module,exports:module.exports,require:load});
    return module.exports;
  };
  assert.equal(load("a").answer(),42);
  assert.equal(load("b").forwarded(),42);
});

test("extracted TypeScript function bodies retain their return statement", () => {
  const code = transpileTypeScriptModule(
    "const selected: number = input + 1; return selected;",
    path.resolve("function-body.ts"),
  );
  assert.equal(new Function("input", code)(41), 42);
});
