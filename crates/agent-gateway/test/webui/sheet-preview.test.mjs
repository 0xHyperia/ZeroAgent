import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "../../../agent-ui/node_modules/exceljs/excel.js";
import { read, SSF } from "../../../agent-ui/node_modules/xlsx/xlsx.mjs";
import { zipSync, strToU8 } from "../../../agent-ui/node_modules/fflate/esm/browser.js";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

async function modules(t, mocks = {}) {
  const env = await createWebDomTestEnv({ resolveDynamicImports: true, mocks });
  t.after(() => env.cleanup());
  return { env, ...env.loadModule("@liveagent/ui/components/resource-preview/sheetModel.ts") };
}

test("saved sheet ranges use rendered cell edges and clip at frozen rows and columns", async (t) => {
  const { env } = await modules(t);
  const { measureSheetGrid, projectSheetRange, sheetRangeTopRight, spansSheetCells } = env.loadModule(
    "@liveagent/ui/components/resource-preview/sheetAnnotationGeometry.ts",
  );
  const viewport = document.createElement("div");
  viewport.innerHTML = `
    <table>
      <thead><tr><th></th><th data-xlsx-col-header="0"></th>
        <th data-xlsx-col-header="1"></th><th data-xlsx-col-header="3"></th></tr></thead>
      <tbody><tr data-xlsx-row="0"><td></td></tr>
        <tr data-xlsx-row="1"><td></td></tr><tr data-xlsx-row="2"><td></td></tr></tbody>
    </table>`;
  Object.defineProperties(viewport, {
    clientWidth: { value: 350 },
    clientHeight: { value: 230 },
  });
  function rect(element, left, top, right, bottom) {
    element.getBoundingClientRect = () => ({ left, top, right, bottom });
  }
  rect(viewport, 100, 50, 450, 280);
  const headers = viewport.querySelectorAll("th");
  rect(headers[0], 100, 50, 142, 70);
  rect(headers[1], 142, 50, 198, 70);
  rect(headers[2], 170, 50, 241, 70);
  rect(headers[3], 241, 50, 335, 70);
  const rowHeaders = viewport.querySelectorAll("tbody td");
  rect(rowHeaders[0], 100, 70, 142, 98);
  rect(rowHeaders[1], 100, 85, 142, 138);
  rect(rowHeaders[2], 100, 138, 142, 181);
  const grid = measureSheetGrid(viewport, { row: 1, col: 1 });
  const parts = projectSheetRange(grid, {
    start: { row: 0, col: 0 },
    end: { row: 2, col: 3 },
  });
  assert.deepEqual(parts, [
    { key: "true:true", left: 42, top: 20, width: 56, height: 28 },
    { key: "true:false", left: 98, top: 20, width: 137, height: 28 },
    { key: "false:true", left: 42, top: 48, width: 56, height: 83 },
    { key: "false:false", left: 98, top: 48, width: 137, height: 83 },
  ]);
  assert.equal(sheetRangeTopRight(parts), parts[1], "the pin stays above the frozen-row seam");
  const scrolled = projectSheetRange(grid, {
    start: { row: 0, col: 0 },
    end: { row: 2, col: 3 },
  }, { x: 12, y: 11 });
  assert.deepEqual(scrolled, [
    parts[0],
    { ...parts[1], width: 125 },
    { ...parts[2], height: 72 },
    { ...parts[3], width: 125, height: 72 },
  ]);
  assert.deepEqual(projectSheetRange(grid, {
    start: { row: 1, col: 1 },
    end: { row: 2, col: 3 },
  }, { x: 0, y: 250 }), [], "cached ranges do not follow unrelated virtual rows");
  assert.deepEqual(projectSheetRange(grid, {
    start: { row: 30, col: 0 },
    end: { row: 32, col: 1 },
  }), []);
  const merged = { start: { row: 0, col: 0 }, end: { row: 0, col: 2 } };
  assert.equal(spansSheetCells(merged, [merged]), false);
  assert.equal(spansSheetCells({ start: merged.start, end: merged.start }, [merged]), false);
  assert.equal(spansSheetCells({ start: merged.start, end: { row: 1, col: 0 } }, [merged]), true);
});

test("styled workbook preflight bounds huge merge expansion and sparse row allocations", async t => {
  const {env} = await modules(t);
  const {canReadStyledWorkbook} = env.loadModule("@liveagent/ui/components/resource-preview/sheetArchive.ts");
  const archive = xml => zipSync({"xl/worksheets/sheet1.xml":strToU8(xml)});
  assert.equal(canReadStyledWorkbook(archive('<worksheet><row r="1"><c r="A1"/></row><mergeCell ref="A1:C3"/></worksheet>')),true);
  assert.equal(canReadStyledWorkbook(archive('<worksheet><mergeCell ref="A1:XFD1048576"/></worksheet>')),false);
  assert.equal(canReadStyledWorkbook(archive('<worksheet><row r="1048576"><c r="A1048576"/></row></worksheet>')),false);
  assert.equal(canReadStyledWorkbook(archive("<worksheet><mergeCell ref='A999999999:B999999999'/></worksheet>")),false);
  assert.equal(canReadStyledWorkbook(archive('<worksheet><mergeCell ref="A&#49;:XFD1048576"/></worksheet>')),false);
  assert.equal(canReadStyledWorkbook(archive('<worksheet><mergeCell ref="A1:A40000"/><mergeCell ref="B1:B40000"/><mergeCell ref="C1:C40000"/></worksheet>')),false);
});

test("real XLSX bytes retain widths, heights, merged and hidden cells, fills, borders and saved formula values", async t => {
  const { excelSheetModel, sheetCellAt } = await modules(t);
  const original = new ExcelJS.Workbook();
  const source = original.addWorksheet("计划");
  source.getColumn(1).width = 10.625; source.getColumn(2).width = 43.75;
  source.getRow(1).height = 22.5; source.getRow(2).height = 45;
  source.getCell("A1").value = "题型（必填）";
  source.getCell("A1").font = { name:"宋体", size:9, bold:true, color:{argb:"FF123456"} };
  source.getCell("A1").alignment = { horizontal:"center", vertical:"middle", wrapText:true };
  source.getCell("A1").border = { bottom:{style:"thin",color:{argb:"FF000000"}} };
  source.getCell("B2").value = {formula:"1+2",result:3}; source.getCell("B2").numFmt = "0.00";
  source.getCell("B2").fill = {type:"pattern",pattern:"solid",fgColor:{argb:"FF92D050"}};
  source.getCell("A3").fill = {type:"pattern",pattern:"solid",fgColor:{argb:"FFCCCCCC"}};
  source.mergeCells("A4:B4"); source.getCell("A4").value = "合并标题";
  source.getRow(5).hidden = true; source.getColumn(3).hidden = true;
  source.getCell("C5").value = "隐藏";
  const bytes = new Uint8Array(await original.xlsx.writeBuffer());
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(bytes);
  const text = read(bytes,{type:"array",cellFormula:false,cellHTML:false}).Sheets["计划"];
  const model = excelSheetModel(loaded, loaded.worksheets[0], SSF.format, address => text[address]?.w);
  assert.deepEqual(model.widths.slice(0,3),[85,350,0]); assert.deepEqual(model.heights.slice(0,2),[30,60]); assert.equal(model.heights[4],0);
  const a1 = model.cells.find(c=>c.row===0&&c.column===0), b2=model.cells.find(c=>c.row===1&&c.column===1);
  assert.equal(model.styles[a1.style].font,"宋体"); assert.equal(model.styles[a1.style].size,12); assert.equal(model.styles[a1.style].color,"#123456");
  assert.equal(model.styles[a1.style].align,"center"); assert.equal(model.styles[a1.style].vertical,"middle"); assert.equal(model.styles[a1.style].borders.bottom.width,1);
  assert.equal(b2.formula,"=1+2"); assert.equal(b2.text,"3.00"); assert.equal(model.styles[b2.style].fill,"#92d050");
  assert.equal(model.styles[model.cells.find(c=>c.row===2&&c.column===0).style].fill,"#cccccc","empty cells retain their formatting");
  assert.deepEqual(model.merges,[{r1:3,c1:0,r2:3,c2:1}]); assert.deepEqual(sheetCellAt(model,3,1),{row:3,column:0});
  assert.ok(!model.cells.some(c=>c.row===3&&c.column===1));
});

test("dates use saved number formats, formula results are never calculated, and preview output stays bounded", async t => {
  const { excelSheetModel, sheetColor } = await modules(t);
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("数据");
  sheet.getCell("A1").value=new Date("2022-01-01T00:00:00Z"); sheet.getCell("A1").numFmt="m/d/yy";
  sheet.getCell("B1").value={formula:'WEBSERVICE("https://invalid.test")'};
  sheet.getCell("CC501").value="范围之外";
  const model=excelSheetModel(workbook,sheet,SSF.format);
  assert.equal(model.cells.find(c=>c.column===0&&c.row===0).text,"1/1/22");
  assert.equal(model.cells.find(c=>c.column===1&&c.row===0).text,"");
  assert.equal(model.heights.length,500);assert.equal(model.widths.length,80);assert.equal(model.truncated,true);
  assert.ok(!model.cells.some(c=>c.text==="范围之外"));
  assert.equal(sheetColor({theme:4,tint:.5}),"#a7c0de");assert.equal(sheetColor({argb:"url(evil)"}),"#000000");
});

test("reader and headerless attachment cover paint the same formatted cells at different scales", async t=>{
  const { env, sheetOffsets }=await modules(t);
  const {paintSheet}=env.loadModule("@liveagent/ui/components/resource-preview/sheetCanvas.ts");
  const rows=[30,60],cols=[85,350],model={name:"表",widths:cols,heights:rows,merges:[],styles:[{font:"宋体",size:12,color:"#000000",fill:"#92d050",align:"left",vertical:"middle",wrap:true,indent:0}],cells:[{row:0,column:0,text:"真实表格",style:0}]};
  const geometry={x:sheetOffsets(cols),y:sheetOffsets(rows),cells:new Map(model.cells.map(c=>[`${c.row}:${c.column}`,c]))};
  const runs=[];const ctx=new Proxy({measureText:text=>({width:text.length*Number(ctx.font?.match(/([\d.]+)px/)?.[1]??12)*.5})},{get:(target,key)=>key in target?target[key]:(...args)=>runs.push([key,...args]),set:(target,key,value)=>{target[key]=value;runs.push([key,value]);return true;}});
  paintSheet(ctx,model,geometry,{width:500,height:300,left:0,top:0,zoom:1,headers:true});
  assert.ok(runs.some(r=>r[0]==="fillText"&&r[1]==="真实表格"));assert.ok(runs.some(r=>r[0]==="fillText"&&r[1]==="A"));assert.ok(runs.some(r=>r[0]==="fillStyle"&&r[1]==="#92d050"));
  runs.length=0;paintSheet(ctx,model,geometry,{width:160,height:100,left:0,top:0,zoom:160/360,headers:false});
  assert.ok(runs.some(r=>r[0]==="fillText"&&r[1]==="真实表格"));assert.ok(!runs.some(r=>r[0]==="fillText"&&r[1]==="A"));
  assert.ok(runs.some(r=>r[0]==="fillRect"&&r[1]===0&&r[2]===0&&r[3]===85*160/360));
});

test("wrapped rows grow to show their text while explicit tall rows and hidden rows stay intact", async t=>{
  const {env}=await modules(t);
  const {layoutSheetGeometry}=env.loadModule("@liveagent/ui/components/resource-preview/sheetCanvas.ts");
  const model={widths:[24],heights:[20,120,0],merges:[],styles:[{font:"Arial",size:10,wrap:true,indent:0}],cells:[{row:0,column:0,text:"一二三四五六",style:0},{row:1,column:0,text:"短",style:0},{row:2,column:0,text:"隐藏",style:0}]};
  const geometry=layoutSheetGeometry(model,{measureText:text=>({width:text.length*10})});
  assert.deepEqual(geometry.y,[0,36,156,156]);
  assert.deepEqual(model.heights,[20,120,0],"layout never changes the original workbook dimensions");
});

test("sheet range entry, keyboard expansion and copy stay inside a read-only grid; thumbnails have no controls", async t=>{
  const model={name:"表一",widths:[80,160,160],heights:[24,40,40],merges:[],styles:[{}],truncated:false,cells:[{row:0,column:0,text:"标题",style:0},{row:1,column:1,text:"120",formula:"=60*2",style:0},{row:1,column:2,text:"甲",style:0},{row:2,column:1,text:"300",style:0},{row:2,column:2,text:"乙",style:0}]};
  const env=await createWebDomTestEnv({resolveDynamicImports:true,mocks:{"./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},async request(){return {sheetNames:["表一"],sheet:model};}})}}});
  const Reader=env.loadModule("@liveagent/ui/components/resource-preview/ResourceSheetFallback.tsx").default;
  const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
  t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
  const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
  const render=async props=>env.act(async()=>{root.render(env.React.createElement(Reader,{bytes:new Uint8Array([1]),name:"计划.xlsx",assertCurrent(){},...props}));await flush();});
  await render();
  const coordinate=host.querySelector('[aria-label="定位单元格"]');assert.ok(coordinate);assert.equal(host.querySelector('[aria-label="公式栏"]').readOnly,true);
  await env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(coordinate,"B2:C3");coordinate.dispatchEvent(new Event("input",{bubbles:true}));});
  await env.act(async()=>{coordinate.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();});
  assert.equal(coordinate.value,"B2:C3");assert.equal(host.querySelector('[aria-label="公式栏"]').value,"=60*2");
  const grid=host.querySelector('[role="grid"]');assert.equal(grid.getAttribute('aria-readonly'),"true");
  let copied;const event=new Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{setData(type,value){copied={type,value};}}});grid.dispatchEvent(event);
  assert.deepEqual(copied,{type:"text/plain",value:"120\t甲\n300\t乙"});
  await env.act(async()=>{grid.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));grid.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',shiftKey:true,bubbles:true,cancelable:true}));await flush();});
  assert.equal(coordinate.value,"B2:B3");assert.equal(host.querySelector('[contenteditable]'),null);
  await render({thumbnail:true});assert.ok(host.querySelector('.za-sheet-cover canvas'));assert.equal(host.querySelector('input'),null);assert.equal(host.querySelector('button'),null);assert.equal(host.querySelector('[role="grid"]'),null);
});
