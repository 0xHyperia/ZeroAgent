import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { readPatchSet } from "./kbrain-patches.mjs";
import { buildSource } from "./build-kbrain-source.mjs";
import { prepare, readLock, resolveTarget, platformFor } from "./prepare-kbrain.mjs";
import { verifyPreparedBinaries } from "./verify-kbrain-packaging.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "zeroagent-patch-test-"));
  try {
    const lock = await readLock();
    const patch = Buffer.from("reviewed synthetic patch\n");
    const data = { schemaVersion: 1, repository: lock.repository, sourceRevision: lock.sourceRevision, protocol: lock.protocol,
      capabilities: ["zeroagent.mcp-credentials.v1"], patches: [{ file: "0001-test.patch", sha256: createHash("sha256").update(patch).digest("hex") }] };
    const file = join(root, "manifest.json");
    await writeFile(join(root, "0001-test.patch"), patch);
    await writeFile(file, JSON.stringify(data));
    await run({ root, lock, data, file });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("source patches require exact revision, safe local filenames and actual bytes", async () => {
  await fixture(async ({root, data, file}) => {
    assert.equal((await readPatchSet(file, await readLock())).receipt.capabilities[0], "zeroagent.mcp-credentials.v1");
    for (const change of [value => value.sourceRevision = "0".repeat(40), value => value.patches[0].file = "../escape.patch", value => value.patches[0].sha256 = "0".repeat(64)]) {
      const invalid = structuredClone(data); change(invalid); await writeFile(file, JSON.stringify(invalid));
      await assert.rejects(readPatchSet(file, await readLock()));
    }
    await writeFile(file, JSON.stringify(data));
    await writeFile(join(root, data.patches[0].file), "changed patch");
    await assert.rejects(readPatchSet(file, await readLock()), /SHA-256 mismatch/);
  });
});

test("patched build applies reviewed bytes after exact checkout and records distinct provenance", async () => {
  await fixture(async ({root, file, lock}) => {
    const calls = [];
    const record = await buildSource({ output: join(root, "artifacts"), sourceDir: root, patchManifest: file, run(command, args, options) {
      calls.push({command,args,options});
      if (command === "go") writeFileSync(args[args.indexOf("-o")+1], args.at(-1));
    } });
    assert.equal(calls.find(call=>call.command === "git" && call.args.includes("checkout")).args.at(-1), lock.sourceRevision);
    assert.deepEqual(calls.filter(call=>call.command === "git" && call.args.includes("apply")).map(call=>call.args.slice(2,4)), [["apply","--check"],["apply","--"]]);
    assert.equal(record.origin, "zeroagent-patched-source");
    assert.equal(record.zeroagentPatchSet.manifestSha256, (await readPatchSet(file, lock)).receipt.manifestSha256);
    assert.match(calls.find(call=>call.command === "go").args[calls.find(call=>call.command === "go").args.indexOf("-ldflags")+1], /\+zeroagent\.[a-f0-9]{12}/);
  });
});

test("patch mutation after verification cannot change the bytes applied to the detached source", async () => {
  await fixture(async ({root,file,data}) => {
    const original = await readFile(join(root,data.patches[0].file));
    let checked = 0;
    await buildSource({output:join(root,"snapshot-artifacts"),sourceDir:root,patchManifest:file,run(command,args){
      if(command === "git" && args.includes("checkout"))writeFileSync(join(root,data.patches[0].file),"changed after validation");
      if(command === "git" && args.includes("apply")){
        assert.deepEqual(readFileSync(args.at(-1)),original);
        checked++;
      }
      if(command === "go")writeFileSync(args[args.indexOf("-o")+1],args.at(-1));
    }});
    assert.equal(checked,2);
  });
});

test("preparation preserves patched provenance and rejects missing or forged proof", async () => {
  await fixture(async ({root,file,lock}) => {
    const artifact = join(root,"artifact");
    const record = await buildSource({ output: artifact, sourceDir: root, patchManifest: file, run(command,args) {
      if(command === "go")writeFileSync(args[args.indexOf("-o")+1],args.at(-1));
    } });
    const output = join(root,"prepared");
    const receipt = await prepare({artifactDir:artifact,output,patchManifest:file});
    assert.equal(receipt.origin,"zeroagent-patched-source");
    assert.deepEqual(JSON.parse(await readFile(`${receipt.binary}.json`)).zeroagentPatchSet,record.zeroagentPatchSet);
    await assert.rejects(prepare({artifactDir:artifact,output:join(root,"missing-proof")}),/explicit patch manifest/);
    const missing = structuredClone(record); delete missing.zeroagentPatchSet;
    await writeFile(join(artifact,"kbrain-artifact.json"),JSON.stringify(missing));
    await assert.rejects(prepare({artifactDir:artifact,output:join(root,"missing-claimed-proof")}),/explicit patch manifest/);
    await writeFile(join(artifact,"kbrain-artifact.json"),JSON.stringify(record));
    const released = await prepare({artifactDir:artifact,output:join(root,"release"),patchManifest:file,release:true});
    assert.equal(released.origin,"zeroagent-patched-source");
    assert.deepEqual(released.zeroagentPatchSet,record.zeroagentPatchSet);
    const previousCI = process.env.CI;
    try {
      process.env.CI = "true";
      const ci = await prepare({artifactDir:artifact,output:join(root,"ci"),patchManifest:file});
      assert.deepEqual(ci.sha256,released.sha256);
      await assert.rejects(prepare({output:join(root,"implicit"),patchManifest:file,release:true}),/explicit source-artifact directory/);
    } finally {
      if (previousCI === undefined) delete process.env.CI;
      else process.env.CI = previousCI;
    }
    record.zeroagentPatchSet.patches[0].sha256="0".repeat(64);
    await writeFile(join(artifact,"kbrain-artifact.json"),JSON.stringify(record));
    await assert.rejects(prepare({artifactDir:artifact,output:join(root,"forged"),patchManifest:file}),/provenance mismatch/);
    await assert.rejects(prepare({artifactDir:artifact,output:join(root,"forged-release"),patchManifest:file,release:true}),/provenance mismatch/);
    assert.ok(platformFor(lock,resolveTarget()).assets.backend);
  });
});

test("package verification requires reviewed patch bytes and rejects forged adapted provenance", async () => {
  await fixture(async ({root,file,data}) => {
    const target = "x86_64-pc-windows-msvc";
    const artifact = join(root,"package-artifact");
    await buildSource({target,output:artifact,sourceDir:root,patchManifest:file,run(command,args){
      if(command === "go")writeFileSync(args[args.indexOf("-o")+1],args.at(-1));
    }});
    const output = join(root,"package-prepared");
    const receipt = await prepare({target,artifactDir:artifact,output,patchManifest:file});
    const options = {binaryDir:output,target,patchManifest:file};
    const verified = await verifyPreparedBinaries(options);
    assert.equal(verified.origin,"zeroagent-patched-source");
    assert.deepEqual(verified.zeroagentPatchSet,receipt.zeroagentPatchSet);
    await assert.rejects(verifyPreparedBinaries({binaryDir:output,target}),/explicit patch manifest/);
    const receiptFile = `${receipt.binary}.json`;
    const saved = JSON.parse(await readFile(receiptFile,"utf8"));
    saved.zeroagentPatchSet.patches[0].sha256 = "0".repeat(64);
    await writeFile(receiptFile,JSON.stringify(saved));
    await assert.rejects(verifyPreparedBinaries(options),/provenance mismatch/);
    saved.zeroagentPatchSet = receipt.zeroagentPatchSet;
    saved.origin = "locked-download";
    await writeFile(receiptFile,JSON.stringify(saved));
    await assert.rejects(verifyPreparedBinaries(options),/adapted origin/);
    saved.origin = receipt.origin;
    await writeFile(receiptFile,JSON.stringify(saved));
    await writeFile(join(root,data.patches[0].file),"unreviewed replacement");
    await assert.rejects(verifyPreparedBinaries(options),/SHA-256 mismatch/);
  });
});

test("dependent patch series checks each patch against the previously applied tree", async () => {
  await fixture(async ({root,file,lock,data}) => {
    const repository=join(root,"source-fixture");
    await (await import("node:fs/promises")).mkdir(repository);
    const git=args=>execFileSync("git",["-C",repository,...args],{encoding:"utf8"});
    git(["init","--quiet"]);git(["config","core.autocrlf","false"]);
    await writeFile(join(repository,"state.txt"),"initial\n");git(["add","state.txt"]);
    git(["-c","user.name=Patch Fixture","-c","user.email=fixture@invalid","commit","--quiet","-m","source fixture"]);
    const revision=git(["rev-parse","HEAD"]).trim();
    const fixtureLock=join(root,"lock.json");await writeFile(fixtureLock,JSON.stringify({...lock,sourceRevision:revision}));
    const makePatch=(before,after)=>`diff --git a/state.txt b/state.txt\n--- a/state.txt\n+++ b/state.txt\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
    const first=Buffer.from(makePatch("initial","first")),second=Buffer.from(makePatch("first","second"));
    await writeFile(join(root,"0001-first.patch"),first);await writeFile(join(root,"0002-second.patch"),second);
    await writeFile(file,JSON.stringify({...data,sourceRevision:revision,patches:[{file:"0001-first.patch",sha256:createHash("sha256").update(first).digest("hex")},{file:"0002-second.patch",sha256:createHash("sha256").update(second).digest("hex")}] }));
    let builds=0;
    const record=await buildSource({lock:fixtureLock,sourceDir:repository,output:join(root,"dependent-artifact"),patchManifest:file,run(command,args,options){
      if(command==="git")return execFileSync(command,args,options);
      assert.equal(readFileSync(join(options.cwd,"state.txt"),"utf8").replaceAll("\r\n","\n"),"second\n");
      writeFileSync(args[args.indexOf("-o")+1],"fixture helper");builds++;
    }});
    assert.equal(builds,2);assert.equal(record.zeroagentPatchSet.patches.length,2);
  });
});
