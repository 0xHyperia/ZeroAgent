import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

const streamdown = await import(new URL("../../../agent-ui/node_modules/streamdown/dist/index.js", import.meta.url));
const translate = key => key;
async function flush() { for (let i=0;i<6;i++) await new Promise(resolve=>setImmediate(resolve)); }
const request = (id, path) => ({ id, projectPathKey: "device-a:project", workdir: "D:/synthetic-project", path });
const response = (path, mimeType, text) => ({ path, mimeType, data: Buffer.from(text).toString("base64"), sizeBytes: Buffer.byteLength(text), mtimeMs: 123, contentHash: "native-fingerprint" });

async function mount(t, initial, read, save = async()=>{}) {
  const reads=[], saves=[];
  const env = await createWebDomTestEnv({ resolveDynamicImports: true, mocks: {
    streamdown,
    "@liveagent/ui/components/IconSet": new Proxy({}, {get:()=>()=>null}),
    "@liveagent/ui/components/chat/fileTypeIcons": {getFileTypeIcon:()=>()=>null},
    "@liveagent/adapters/workspacePreview": { supportsExternalWorkspaceOpen: false, WorkspaceOverlayTitleBar:()=>null, workspaceOverlayStackClassName:"", saveWorkspacePreviewImage: async value=>{saves.push(value);await save(value);}, copyWorkspacePreviewImage:async()=>{} },
    "@liveagent/ui/components/workspace-editor/WorkspaceMarkdownPreview": { WorkspaceMarkdownPreview:()=>null },
    "@liveagent/ui/i18n/index": { useLocale:()=>({ t:translate }) },
    "@liveagent/ui/lib/tools/fsBackend": { invokeFs: async (command,args)=>{ assert.equal(command,"fs_read_workspace_image"); reads.push(args); return read(args); } },
  }});
  const { WorkspaceFilePreviewOverlay } = env.loadModule("@liveagent/ui/components/workspace-editor/WorkspaceFilePreviewOverlay.tsx");
  const host=document.body.appendChild(document.createElement("div")), root=env.createRoot(host);
  const render=async(openRequest=initial,isOpen=true)=>{
    await env.act(async()=>{root.render(env.React.createElement(WorkspaceFilePreviewOverlay,{openRequest,isOpen,onOpenEditor(){},onRequestClose(){},onClose(){}}));await flush();});
    await env.act(flush);
  };
  await render();
  t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
  return {env,host,render,reads,saves,async waitFor(message){
    const deadline=Date.now()+2000;
    while(!message.test(host.textContent)&&Date.now()<deadline)
      await env.act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
    assert.match(host.textContent,message);
  }};
}

test("authorized workspace bytes use the shared PDF failure UI and keep the original native save payload",async t=>{
  const sample=response("文件.pdf","application/pdf","broken PDF");
  const app=await mount(t,request(1,sample.path),async()=>sample);
  await app.waitFor(/PDF 文件头无效/);
  assert.match(app.host.textContent,/PDF 文件头无效/); assert.equal(app.host.querySelector("iframe"),null);
  assert.deepEqual(app.reads,[{workdir:"D:/synthetic-project",path:"文件.pdf"}]);
  const save=[...app.host.querySelectorAll("button")].find(button=>button.textContent==="下载原件");
  assert.ok(save);await app.env.act(async()=>{save.click();await flush();});
  assert.deepEqual(app.saves,[{data:sample.data,fileName:"文件.pdf",mimeType:"application/pdf"}]);
});

test("late workspace reads cannot replace a newer PPTX preview or paint after closing",async t=>{
  let finishOld, finishClosed;
  const old=request(1,"旧文档.docx"), next=request(2,"新幻灯片.pptx"), closed=request(3,"关闭的.pdf");
  const app=await mount(t,old,async args=>{
    if(args.path===old.path){await new Promise(resolve=>{finishOld=resolve;});return response(old.path,"application/vnd.openxmlformats-officedocument.wordprocessingml.document","old bytes");}
    if(args.path===closed.path){await new Promise(resolve=>{finishClosed=resolve;});return response(closed.path,"application/pdf","closed bytes");}
    return response(next.path,"application/vnd.openxmlformats-officedocument.presentationml.presentation","bad pptx");
  });
  await app.render(next);await app.waitFor(/格式不匹配/);
  await app.env.act(async()=>{finishOld();await flush();});
  assert.match(app.host.querySelector(".za-resource-preview").getAttribute("aria-label"),/新幻灯片/);
  assert.equal(app.host.querySelector("iframe"),null);
  await app.render(closed);await app.render(closed,false);
  await app.env.act(async()=>{finishClosed();await flush();});
  assert.equal(app.host.querySelector(".za-resource-preview"),null);assert.equal(app.saves.length,0);
});

test("workspace routing includes PPTX and ZIP while retaining existing editable formats",async t=>{
  const env=await createWebDomTestEnv();t.after(()=>env.cleanup());
  const api=env.loadModule("@liveagent/ui/components/workspace-editor/workspaceImagePreview.ts");
  assert.equal(api.getWorkspacePreviewKind("project/slides.PPTX"),"presentation");
  assert.equal(api.getWorkspacePreviewKind("project/output.zip"),"archive");
  for(const path of ["page.html","readme.md","table.csv","data.tsv","notes.txt"])assert.equal(api.isWorkspaceEditablePreviewPath(path),true);
  assert.equal(api.getWorkspacePreviewKind("legacy.doc"),"document");
  assert.equal(api.isWorkspaceEditablePreviewPath("slides.pptx"),false);
});

test("a delayed native save failure cannot overwrite a newer file's preview state",async t=>{
  let rejectSave;
  const app=await mount(t,request(1,"旧文件.pdf"),async args=>response(args.path,"application/pdf","bad PDF"),()=>new Promise((_,reject)=>{rejectSave=reject;}));
  await app.waitFor(/PDF 文件头无效/);
  const save=[...app.host.querySelectorAll("button")].find(button=>button.textContent==="下载原件");
  await app.env.act(async()=>{save.click();await flush();});
  assert.equal(app.saves.length,1);
  await app.render(request(2,"新文件.pdf"));await app.waitFor(/PDF 文件头无效/);
  await app.env.act(async()=>{rejectSave(new Error("retired-native-save-failed"));await flush();});
  assert.doesNotMatch(app.host.textContent,/retired-native-save-failed/);
  assert.match(app.host.querySelector(".za-resource-preview").getAttribute("aria-label"),/新文件/);
});
