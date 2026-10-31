import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as pptx from "../../crates/agent-ui/node_modules/@office-kit/pptx/dist/index.js";

const requireUI = createRequire(new URL("../../crates/agent-ui/package.json", import.meta.url));
const { zipSync, strToU8 } = requireUI("fflate");
const xlsx = requireUI("xlsx");
const directory = fileURLToPath(new URL("../../.codex-artifacts/space-seaweedfs-20261030/preview-fixtures/", import.meta.url));
await mkdir(directory, { recursive: true });
const manifest = { format: "zeroagent-preview-fixtures-v1", files: [] };
async function save(name, bytes) {
  await writeFile(`${directory}/${name}`, bytes);
  manifest.files.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
}
const xml = (value) => strToU8(value);
await save("季度方案.docx", zipSync({
  "[Content_Types].xml": xml('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  "_rels/.rels": xml('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  "word/document.xml": xml('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr><w:t>ZeroAgent 季度工作方案</w:t></w:r></w:p><w:p><w:r><w:t>这是浏览器直接排版的 Word 原件。中英文混排：CloudChat personal space.</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>阶段</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>验收内容</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>第一阶段</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>原件、预览与引用一致</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:br w:type="page"/><w:t>第二页：版本与账户隔离</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr></w:body></w:document>'),
}));
const presentation = pptx.createPresentation();
for (const [index, title] of ["资料空间 · 工作成果", "私人预览与明确分享"].entries()) {
  const slide = pptx.addBlankSlide(presentation);
  pptx.setSlideBackground(slide, index ? "F0F4FF" : "FFFFFF");
  const shape = pptx.addSlideTextBox(slide, { x: pptx.inches(.7), y: pptx.inches(.8), w: pptx.inches(8), h: pptx.inches(1.3), text: title });
  pptx.setShapeTextFormat(shape, { fontSizePt: 32, bold: true, color: "172033" });
  pptx.addSlideTextBox(slide, { x: pptx.inches(.7), y: pptx.inches(2.3), w: pptx.inches(8), h: pptx.inches(1.6), text: "ZeroAgent CloudChat\n原件保留 · 浏览器逐页预览 · 账户隔离" });
}
await save("工作成果.pptx", await pptx.savePresentation(presentation));
const book = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([["项目", "完成数", "目标"], ["文档", 12, 20], ["演示文稿", 8, 10]]), "工作概览");
xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([["验证", "状态"], ["账户隔离", "通过"]]), "验收");
await save("资料统计.xlsx", xlsx.write(book, { type: "buffer", bookType: "xlsx" }));
await save("资料目录.zip", zipSync({ "项目/说明.txt": xml("ZeroAgent synthetic archive\n"), "项目/产出/": new Uint8Array() }));
await save("网页预览.html", xml('<!doctype html><h1>ZeroAgent 私人网页预览</h1><p>此预览不会运行脚本。</p><script>document.body.dataset.untrustedScriptExecuted="yes"</script>'));
await save("阅读指南.md", xml('# ZeroAgent 资料空间\n\n**原件与产出统一保存。**\n\n- 上传文件\n- 引用到工作\n\n| 类型 | 阅读方式 |\n| --- | --- |\n| Word | 浏览器排版 |\n| PPT | 逐页预览 |\n\n![外链图像](http://127.0.0.1:9/must-not-fetch.png)\n\n<script>document.body.dataset.untrustedScriptExecuted="yes"</script>'));
await save("矢量图.svg",xml('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="600" height="320" rx="28" fill="#f1f5fb"/><text x="48" y="180" fill="#172033" font-family="sans-serif" font-size="42">ZeroAgent</text><script>document.body.dataset.untrustedScriptExecuted="yes"</script></svg>'));
const unicodeHex = (value) => Buffer.from(value,"utf16le").swap16().toString("hex");
const streams = [
  `BT /F1 24 Tf 50 760 Td (ZeroAgent CloudChat) Tj /F2 18 Tf 0 -44 Td <${unicodeHex("资料空间在线预览")} > Tj ET`,
  `BT /F1 24 Tf 50 760 Td (Page 2 - Source preserved) Tj /F2 18 Tf 0 -44 Td <${unicodeHex("原件和版本保持一致")} > Tj ET`,
];
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  ...[8,9].map((content)=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents ${content} 0 R >>`),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] >>',
  '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
  ...streams.map((stream)=>`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
];
let pdf = '%PDF-1.7\n';
const offsets=[0];
for (const [index,object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`; }
const xref=Buffer.byteLength(pdf);
pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,"0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size ${objects.length+1} >>\nstartxref\n${xref}\n%%EOF\n`;
await save("阅读样本.pdf",Buffer.from(pdf));
const audio=Buffer.alloc(44+16000);
audio.write("RIFF",0);audio.writeUInt32LE(audio.length-8,4);audio.write("WAVEfmt ",8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(8000,24);audio.writeUInt32LE(16000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write("data",36);audio.writeUInt32LE(16000,40);
for(let sample=0;sample<8000;sample++) audio.writeInt16LE(Math.round(Math.sin(sample*440*2*Math.PI/8000)*4000),44+sample*2);
await save("音频样本.wav",audio);
function ffmpeg(args) { execFileSync(process.platform==="win32"?"ffmpeg.exe":"ffmpeg",["-nostdin","-v","error","-y",...args],{windowsHide:true,stdio:"pipe",timeout:30_000}); }
for (const [name,codec] of [["图像样本.png","png"],["动图样本.gif","gif"],["图像样本.webp","libwebp"],["位图样本.bmp","bmp"],["图像样本.avif","libaom-av1"]]) {
  const filename=`${directory}/${name}`;
  ffmpeg(["-f","lavfi","-i","testsrc=size=240x160:rate=1","-frames:v","1","-c:v",codec,filename]);
  await save(name,await readFile(filename));
}
const videoPath=`${directory}/视频样本.mp4`;
ffmpeg(["-f","lavfi","-i","testsrc=size=480x270:rate=10","-t","1","-c:v","libx264","-pix_fmt","yuv420p","-movflags","+faststart",videoPath]);
await save("视频样本.mp4",await readFile(videoPath));
await save("损坏文档.docx",new Uint8Array([80,75,3,4,0,0,0,0]));
await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ directory, files: manifest.files }, null, 2));
