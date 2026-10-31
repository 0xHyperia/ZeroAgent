import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const policy = loader.loadModule("@liveagent/ui/components/resource-preview/previewPolicy.ts");
const { inspectPreviewArchive } = loader.loadModule("@liveagent/ui/components/resource-preview/previewArchive.ts");
const { previewImageDimensions } = loader.loadModule("@liveagent/ui/components/resource-preview/previewImageDimensions.ts");
const { zipSync, strToU8 } = createRequire(new URL("../../../agent-ui/package.json", import.meta.url))("fflate");

test("browser preview supports modern Office without claiming old binary Office support", () => {
  assert.equal(policy.resourcePreviewKind({ name: "原件.docx", mime: "application/octet-stream" }), "docx");
  assert.equal(policy.resourcePreviewKind({ name: "成果.PPTX", mime: "application/octet-stream" }), "pptx");
  assert.equal(policy.resourcePreviewKind({ name: "老原件.doc", mime: "application/msword" }), "unsupported");
  assert.equal(policy.resourcePreviewKind({ name: "老幻灯片.ppt", mime: "application/vnd.ms-powerpoint" }), "unsupported");
  assert.throws(() => policy.checkPreviewSignature("docx", strToU8("not Office")), /格式不匹配/);
  assert.throws(() => policy.checkPreviewSignature("pdf", strToU8("<script>")), /文件头无效/);
});

test("preview text cannot turn binary or oversized contents into a DOM string", () => {
  assert.equal(policy.resourceText(strToU8("ZeroAgent 中文")), "ZeroAgent 中文");
  assert.throws(() => policy.resourceText(new Uint8Array([0xff, 0xff])));
  assert.throws(() => policy.resourceText(strToU8("binary\0payload")), /二进制|UTF-8/);
  assert.throws(() => policy.resourceText(new Uint8Array(policy.RESOURCE_TEXT_MAX_BYTES + 1)), /较大/);
  const document = policy.isolatedPreviewDocument("<h1>Uploaded content</h1>");
  assert.match(document, /script-src 'none'/);
  assert.match(document, /connect-src 'none'/);
  assert.match(document, /base-uri 'none'/);
});

test("ZIP directory preview checks actual contents, directory names and completion", () => {
  const archive = zipSync({ "项目/原件.txt": strToU8("真实内容"), "项目/成果/": new Uint8Array() });
  assert.deepEqual(inspectPreviewArchive(archive), [
    { name: "项目/原件.txt", size: 12, directory: false },
    { name: "项目/成果/", size: 0, directory: true },
  ]);
  assert.throws(() => inspectPreviewArchive(archive.subarray(0, archive.length - 1)), /目录/);
  assert.throws(() => inspectPreviewArchive(zipSync({ "../escape.txt": strToU8("no") })), /路径/);
  assert.throws(() => inspectPreviewArchive(zipSync({ "a\\escape.txt": strToU8("no") })), /路径/);
  assert.throws(() => inspectPreviewArchive(new Uint8Array()), /目录/);
});

test("ZIP preview rejects encryption and dishonest expansion sizes before Office rendering", () => {
  const archive = zipSync({ "payload.txt": new Uint8Array(1024 * 1024).fill(65) });
  const central = Buffer.from(archive).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0);
  const dishonest = archive.slice();
  new DataView(dishonest.buffer).setUint32(central + 24, 1, true);
  assert.throws(() => inspectPreviewArchive(dishonest), /实际大小/);
  const encrypted = archive.slice();
  new DataView(encrypted.buffer).setUint16(central + 8, 1, true);
  assert.throws(() => inspectPreviewArchive(encrypted), /加密/);
});

test("raster previews reject oversized logical canvases before browser decoding", () => {
  const gif=Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b","hex");
  assert.deepEqual(previewImageDimensions(gif,"image/gif"),{width:1,height:1});
  const huge=gif.slice();huge.writeUInt16LE(65535,6);
  assert.throws(()=>previewImageDimensions(huge,"image/gif"),/尺寸/);
  assert.throws(()=>previewImageDimensions(gif,"image/webp"),/格式/);
  const box=(type,payload)=>{const bytes=Buffer.alloc(8+payload.length);bytes.writeUInt32BE(bytes.length,0);bytes.write(type,4);Buffer.from(payload).copy(bytes,8);return bytes;};
  const dimensions=Buffer.alloc(12);dimensions.writeUInt32BE(320,4);dimensions.writeUInt32BE(200,8);
  const avif=Buffer.concat([box("ftyp",Buffer.from("avif0000")),box("meta",Buffer.concat([Buffer.alloc(4),box("iprp",box("ipco",box("ispe",dimensions)))]))]);
  assert.deepEqual(previewImageDimensions(avif,"image/avif"),{width:320,height:200});
  assert.throws(()=>previewImageDimensions(avif.subarray(0,avif.length-4),"image/avif"),/格式/);
});
