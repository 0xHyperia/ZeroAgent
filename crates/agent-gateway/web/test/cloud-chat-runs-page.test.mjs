import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const defaultConversation="a1000000-0000-4000-8000-000000000001";
const alternateConversation="a1000000-0000-4000-8000-000000000002";
const branchConversation=index=>`b1000000-0000-4000-8000-${String(index).padStart(12,"0")}`;
const fixtureUUID=index=>`c1000000-0000-4000-8000-${String(index).padStart(12,"0")}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = (overrides = {}) => ({
  id: "run-a", conversation_id: defaultConversation, client_request_id: "client-a", model: "test-model",
  state: "running", user_message_id: "user-a", assistant_message_id: "assistant-a",
  output: "", last_seq: "1", ...overrides,
});
const fileConversation="11111111-1111-4111-8111-111111111111";
const secondFileConversation="22222222-2222-4222-8222-222222222222";
const fileId="33333333-3333-4333-8333-333333333333";
const fixtureBodySHA=createHash("sha256").update("hello").digest("hex");
const fileRecord=(overrides={})=>({id:fileId,conversation_id:fileConversation,name:"notes.md",mime:"text/markdown",size:5,sha256:fixtureBodySHA,state:"ready",text_bytes:5,version:4,created_at:"2026-10-29T00:00:00Z",updated_at:"2026-10-29T00:00:00Z",uploaded_at:"2026-10-29T00:00:00Z",...overrides});
const artifactVersionID="44444444-4444-4444-8444-444444444444",olderArtifactID="55555555-5555-4555-8555-555555555555",artifactFamilyID="66666666-6666-4666-8666-666666666666",artifactRunID="77777777-7777-4777-8777-777777777777";
const artifactRecord=(overrides={})=>({id:artifactVersionID,family_id:artifactFamilyID,number:2,conversation_id:fileConversation,source_run_id:artifactRunID,name:"website.html",mime:"text/html",size:5,sha256:fixtureBodySHA,state:"ready",version:3,created_at:"2026-10-29T00:00:00Z",updated_at:"2026-10-29T00:00:00Z",download_url:`/api/web-chat/artifacts/versions/${artifactVersionID}/download`,...overrides});
const artifactSnapshot=record=>({type:"artifact_reference",version_id:record.id,name:record.name,mime:record.mime,size:record.size,family_id:record.family_id,number:record.number,sha256:record.sha256});

async function mount(t, { initialRun = null, uncertain = false, delayedCancel = false, initialProviderKeyId = 1, fileMode=false, initialFiles=[], delayedUpload=false, initialMessages=null, uncertainBranch=false,delayedBranch=false,initialArtifacts=[],delayedArtifact=false,modelSettings=[],initialReasoning="medium",queueFull=false,delayedQueueFull=false,fullMessages=[],delayedHistory=false,delayedMessage=false,messageStatus=200,streamLimit=false,realModelControls=false,conversationPages=null,delayedConversations=false,delayedRunHead=false,initialModelLimits=null,delayedModelLimits=false,unknownModelLimitSave=false,realTranscript=false,newDraft=false,mobileLayout=false,delayedSubmit=false,initialPending=[],initialSavedDrafts=[],initialDraftText="新的问题",searchResults=null,initialHistoryFailure=false,revisionHarness=false,readerHarness=false } = {}) {
  let env;
  let uuid = 0;
  let draft = initialDraftText;
  let structuredDraft=null,composerContextPicker;
  const projectRecords=new Map();
  const projectBindings=new Map();
  let delayProjectAssociation=false,finishProjectAssociation;
  let composer, modelPopoverChange, sidebar;
  let clearCount = 0;
  let online = !uncertain;
  let finishSubmit;
  let queueIsFull=queueFull,finishQueueFull;
  let failHistory=false,finishHistory,finishMessage;
  let failInitialHistory=initialHistoryFailure;
  let failConversationPage=false,finishConversations,finishRunHead;
  let finishModelLimits;
  let savedModelLimits=initialModelLimits;
  const completeMessages=new Map(fullMessages.map(message=>[message.id,message]));
  const firstConversation=fileMode?fileConversation:defaultConversation;
  const secondConversation=fileMode?secondFileConversation:alternateConversation;
  let accountRevision=0;
  let savedWebSettings={model:"test-model",reasoning_effort:initialReasoning,provider_key_id:initialProviderKeyId};
  const files=new Map(initialFiles.map((file)=>[file.id,file]));
  const artifacts=new Map(initialArtifacts.map((version)=>[version.id,version]));
  const fileBodies=new Map(initialFiles.map((file)=>[file.id,"hello"]));
  let finishUpload;
  let uploadOnline=true, fileListOnline=true;
  let transcript, floorNav;
  const editScrolls=[];
  let projectPanel,memoryPanel,finishBranch,finishArtifact,revisionPanel;
  let branchOnline=!uncertainBranch;
  const branches=new Map();
  const history = new Map([
    [firstConversation, initialMessages??[{ id: "user-a", role: "user", content: "原问题" }]],
    [secondConversation, [{ id: "user-b", role: "user", content: "另一个会话" }]],
  ]);
  const runs = new Map(initialRun ? [[initialRun.id, initialRun]] : []);
  const streams = [];
  const calls = [];
  const renamedTitles = new Map();
  const conversationManagement = new Map();
  const now="2026-10-31T01:00:00Z";
  const metadata=(id,source={})=>({id,title:renamedTitles.get(id)??source.title??`会话${id}`,model:"test-model",created_at:now,updated_at:now,pinned:false,archived:false,management_version:0,...source,...conversationManagement.get(id)});
  const pendingQueues = new Map([[`1:${firstConversation}`,{conversation_id:firstConversation,version:initialPending.length?"1":"0",items:initialPending.map(item=>({model:"test-model",content:"排队问题",model_parameters:{},presentation:"work",version:"1",created_at:now,updated_at:now,...item}))}]]);
  const savedDrafts = new Map(initialSavedDrafts.map(value=>[`1:${value.scope}`,{scope:value.scope,version:"1",...value}]));
  const draftOperations = new Map();
  let draftRevision=10;

  let delayRename=false,finishRename;
  let resolveCancel;

  const request = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? "GET", body: init.body,headers:init.headers });
    const url = new URL(path, "http://localhost");
    const draftScope=url.pathname.match(/^\/api\/web-chat\/drafts\/([^/]+)$/)?.[1];
    if(draftScope){
      const key=`${user.id}:${draftScope}`,current=savedDrafts.get(key)??{scope:draftScope,version:"0",draft:null};
      if(!init.method||init.method==="GET")return Response.json(current);
      const input=JSON.parse(init.body),operationKey=`${user.id}:${input.client_operation_id}`,replay=draftOperations.get(operationKey);
      if(replay)return Response.json({...current,applied_version:replay,replayed:true});
      if(input.expected_version!==current.version)return Response.json({reason:"draft_changed"},{status:409});
      const version=String(++draftRevision),next={scope:draftScope,version,draft:init.method==="DELETE"?null:input.draft,updated_at:now,last_operation_id:input.client_operation_id};
      savedDrafts.set(key,next);draftOperations.set(operationKey,version);
      return Response.json({...next,applied_version:version,replayed:false});
    }
    const pendingMatch=url.pathname.match(/^\/api\/web-chat\/conversations\/([^/]+)\/pending(?:\/([^/]+))?(?:\/(submit))?$/);
    if(pendingMatch){
      const [,cid,itemId,submit]=pendingMatch,key=`${user.id}:${cid}`,current=pendingQueues.get(key)??{conversation_id:cid,version:"0",items:[]};
      if(!init.method||init.method==="GET")return Response.json({queue:current});
      const input=JSON.parse(init.body),item=current.items.find(item=>item.client_item_id===itemId);
      const conflict=()=>Response.json({reason:"pending_queue_changed"},{status:409});
      if(submit){
        let run=[...runs.values()].find(run=>run.conversation_id===cid&&run.client_request_id===itemId);
        if(!run){
          if(!item)return Response.json({reason:"pending_not_found"},{status:404});
          if(item.version!==input.expected_version)return conflict();
          if(queueIsFull)return Response.json({reason:"account_queue_full"},{status:429});
          run=snapshot({id:fixtureUUID(++uuid),conversation_id:cid,client_request_id:itemId,model:item.model,model_parameters:item.model_parameters,user_message_id:fixtureUUID(++uuid),assistant_message_id:fixtureUUID(++uuid),state:"queued"});
          runs.set(run.id,run);history.set(cid,[...(history.get(cid)??[]),{id:run.user_message_id,role:"user",content:item.content}]);
          pendingQueues.set(key,{...current,version:String(BigInt(current.version)+1n),items:current.items.filter(entry=>entry!==item)});
        }
        return Response.json({run},{status:202});
      }
      let items=current.items;
      if(itemId==="reorder"){
        if(current.version!==input.expected_version)return conflict();
        items=input.item_ids.map(id=>current.items.find(item=>item.client_item_id===id));
      }else if(itemId){
        if(!item)return Response.json({reason:"pending_not_found"},{status:404});
        if(item.version!==input.expected_version)return conflict();
        items=init.method==="DELETE"?items.filter(entry=>entry!==item):items.map(entry=>entry===item?{...input.item,version:String(BigInt(item.version)+1n),created_at:item.created_at,updated_at:now}:entry);
      }else{
        const existing=items.find(item=>item.client_item_id===input.item.client_item_id);
        if(existing)return Response.json({queue:current});
        if(current.version!==input.expected_version)return conflict();
        items=[...items,{...input.item,version:"1",created_at:now,updated_at:now}];
      }
      const queue={...current,version:String(BigInt(current.version)+1n),items};pendingQueues.set(key,queue);return Response.json({queue});
    }
    if(url.pathname.endsWith("/metadata")){
      const id=url.pathname.split("/").at(-2);return history.has(id)?Response.json({conversation:metadata(id)}):Response.json({error:"missing"},{status:404});
    }
    if(url.pathname.endsWith("/management")){
      const id=url.pathname.split("/").at(-2),current=metadata(id),input=JSON.parse(init.body);
      if(current.management_version!==input.expected_version)return Response.json({reason:"conversation_changed"},{status:409});
      conversationManagement.set(id,{...current,...(input.pinned===undefined?{}:{pinned:input.pinned}),...(input.archived===undefined?{}:{archived:input.archived}),management_version:current.management_version+1});
      return Response.json({conversation:metadata(id)});
    }
    if(url.pathname==="/api/web-chat/conversations/search"){
      const q=url.searchParams.get("q"),index=Number((url.searchParams.get("cursor")??"search-0").slice(7));
      const matches=searchResults??[...history.entries()].flatMap(([cid,messages])=>messages.filter(item=>String(item.content).includes(q)).map(item=>({conversation:metadata(cid),message_id:item.id,role:item.role,excerpt:String(item.content).slice(0,1200),match:"message",created_at:now})));
      const limit=Number(url.searchParams.get("limit")??20),items=matches.slice(index,index+limit).map(item=>({...item,conversation:metadata(item.conversation.id,item.conversation)})),hasMore=index+limit<matches.length;
      return Response.json({items,has_more:hasMore,next_cursor:hasMore?`search-${index+limit}`:""});
    }
    if(url.pathname.endsWith("/branches")){
      const cid=url.pathname.split("/").at(-2),parent=[...branches.values()].find(branch=>branch.conversation.id===cid),children=[...branches.values()].filter(branch=>branch.source_conversation_id===cid).map(branch=>({conversation:metadata(branch.conversation.id,branch.conversation),source_message_id:branch.source_message_id,action:branch.action}));
      return Response.json({source:parent?{conversation_id:parent.source_conversation_id,message_id:parent.source_message_id,action:parent.action,title:metadata(parent.source_conversation_id).title,available:history.has(parent.source_conversation_id)}:null,children,has_more:false,next_cursor:""});
    }
    const windowMatch=url.pathname.match(/^\/api\/web-chat\/conversations\/([^/]+)\/messages\/([^/]+)\/window$/);
    if(windowMatch){
      const [,cid,anchorID]=windowMatch,all=history.get(cid)??[],anchor=all.findIndex(item=>item.id===anchorID);
      if(anchor<0)return Response.json({error:"missing"},{status:404});
      const start=Math.max(0,anchor-Number(url.searchParams.get("before")??20)),end=Math.min(all.length,anchor+Number(url.searchParams.get("after")??20)+1),messages=all.slice(start,end);
      return Response.json({messages,anchor_id:anchorID,has_before:start>0,has_after:end<all.length,next_before_id:start>0?messages[0].id:"",next_after_id:end<all.length?messages.at(-1).id:""});
    }
    if(init.method==='PATCH'&&/^\/api\/web-chat\/conversations\/[^/]+$/.test(url.pathname)){
      const id=url.pathname.split('/').at(-1),title=JSON.parse(init.body).title;renamedTitles.set(id,title);
      if(delayRename)await new Promise(resolve=>{finishRename=resolve;});
      return Response.json({conversation:metadata(id,{title})});
    }
    if(url.pathname==="/api/web-chat/projects")return Response.json({items:[...projectRecords.values()],next_before_id:""});
    if(/^\/api\/web-chat\/projects\/[^/]+\/conversations$/.test(url.pathname)){const projectId=url.pathname.split('/').at(-2);return Response.json({items:[...projectBindings.values()].filter(binding=>binding.project_id===projectId).map(binding=>({...binding,conversation:metadata(binding.conversation_id)})),next_before_id:""});}
    if(url.pathname.startsWith('/api/web-chat/projects/')){const project=projectRecords.get(url.pathname.split('/').at(-1));return project?Response.json(project):Response.json({error:'missing'},{status:404});}
    if(url.pathname.endsWith('/project')){
      const id=url.pathname.split('/').at(-2),current=projectBindings.get(id)??{conversation_id:id,project_id:'',version:0,created_at:''};
      if(init.method==='PUT'){
        const input=JSON.parse(init.body);if(delayProjectAssociation)await new Promise(resolve=>{finishProjectAssociation=resolve;});
        const latest=projectBindings.get(id)??current;
        if(input.expected_version!==latest.version)return Response.json({error:'conflict'},{status:409});
        const binding={...latest,project_id:input.project_id,version:latest.version+1};projectBindings.set(id,binding);return Response.json(binding);
      }
      return Response.json(current);
    }
    if(url.pathname==='/api/web-chat/conversations'&&init.method==='POST'){
      const id='88888888-8888-4888-8888-888888888888';history.set(id,[]);return Response.json({conversation:metadata(id,{title:"新对话"})});
    }
    if (url.pathname === "/api/web-settings") {
      if(init.method==="PATCH")savedWebSettings={...savedWebSettings,...JSON.parse(init.body)};
      return Response.json({ settings:savedWebSettings });
    }
    if(url.pathname==="/api/web-chat/model-limits"){
      if(init.method==="PUT"){
        const input=JSON.parse(init.body);if(input.expected_version!==(savedModelLimits?.version??0))return Response.json({reason:"cloud_model_limits_changed",error:"private conflict details"},{status:409});
        savedModelLimits={provider_key_id:Number(url.searchParams.get("provider_key_id")),model:url.searchParams.get("model"),mode:input.mode,context_window:input.context_window,max_output_tokens:input.max_output_tokens,version:(savedModelLimits?.version??0)+1,updated_at:"2026-10-29T00:00:00Z"};
        if(unknownModelLimitSave)throw new Error("private network failure after save");
      }else if(delayedModelLimits)await new Promise(resolve=>{finishModelLimits=resolve;});
      return Response.json({setting:savedModelLimits});
    }
    if (url.pathname === "/api/web-chat/conversations/catalog") {
      const index=Number((url.searchParams.get("cursor")??"page-0").slice(5));
      if(index&&delayedConversations)await new Promise(resolve=>{finishConversations=resolve;});
      if(index&&failConversationPage)return Response.json({error:"private detail"},{status:503});
      const pages=conversationPages??[[...history.keys()].map(id=>metadata(id))];
      const scope=url.searchParams.get("scope")??"active";
      return Response.json({conversations:(pages[index]??[]).map(item=>metadata(item.id,{...item,title:renamedTitles.get(item.id)??item.title})).filter(item=>scope==="unassigned"?!item.archived&&!projectBindings.get(item.id)?.project_id:scope==="all"?true:scope==="archived"?item.archived:scope==="pinned"?item.pinned&&!item.archived:!item.archived),has_more:index+1<pages.length,next_cursor:index+1<pages.length?`page-${index+1}`:""});
    }
    if(url.pathname.endsWith("/branch")&&init.method==="POST"){
      const input=JSON.parse(init.body);const sourceID=url.pathname.split("/").at(-2);
      let branch=branches.get(input.client_request_id);
      if(!branch){
        const original=history.get(sourceID).map(item=>completeMessages.get(item.id)??item);let anchor=original.findIndex(item=>item.id===input.message_id);let draftContent;
        if(input.action!=="fork"){while(anchor>=0&&original[anchor].role!=="user")anchor--;draftContent=input.action==="edit"?input.content:original[anchor].content;}
        const id=branchConversation(branches.size+1);
        const prefix=original.slice(0,anchor+(input.action==="fork"?1:0)).map((message,index)=>({...message,id:`${id}-message-${index}`}));
        history.set(id,prefix);
        branch={conversation:metadata(id,{title:"新分支"}),source_conversation_id:sourceID,source_message_id:input.message_id,action:input.action,draft_content:draftContent};
        branches.set(input.client_request_id,branch);
      }
      if(delayedBranch)await new Promise(resolve=>{finishBranch=resolve;});
      if(!branchOnline)throw new Error("branch response lost");
      return Response.json({branch,created:true},{status:201});
    }
    if(url.pathname.startsWith("/api/web-chat/branches/")){
      if(!branchOnline)throw new Error("branch lookup offline");
      const branch=branches.get(url.pathname.split("/").at(-1));return branch?Response.json({branch}):Response.json({error:"missing"},{status:404});
    }
    if(url.pathname.endsWith("/export"))return new Response(url.searchParams.get("format")==="json"?JSON.stringify({messages:history.get(url.pathname.split("/").at(-2))}):"# 对话\n\n原问题",{headers:{"Content-Type":"application/octet-stream"}});
    if(url.pathname==="/api/web-chat/artifacts")return Response.json({versions:[...artifacts.values()].filter(version=>(!url.searchParams.has("conversation_id")||version.conversation_id===url.searchParams.get("conversation_id"))&&(!url.searchParams.has("family_id")||version.family_id===url.searchParams.get("family_id"))),next_cursor:""});
    if(url.pathname.startsWith("/api/web-chat/artifacts/versions/")){
      const version=artifacts.get(url.pathname.split("/")[5]);
      if(!version)return Response.json({error:"missing"},{status:404});
      if(url.pathname.endsWith("/download"))return new Response("hello");
      if(delayedArtifact)await new Promise(resolve=>{finishArtifact=resolve;});
      return Response.json({version});
    }
    if(url.pathname==="/api/web-chat/files"&&init.method==="POST"){
      const original=init.body.get("file");
      const file=fileRecord({conversation_id:init.body.get("conversation_id")??"",name:original.name,size:original.size,text_bytes:original.name.endsWith(".pdf")?0:original.size,state:original.name.endsWith(".pdf")?"uploaded":"ready",processing_stage:original.name.endsWith(".pdf")?"awaiting_isolated_parser":"complete"});
      files.set(file.id,file);fileBodies.set(file.id,await original.text());
      if(delayedUpload)await new Promise((resolve)=>{finishUpload=resolve;});
      if(!uploadOnline)throw new Error("response lost after saving the original");
      return Response.json({file},{status:201});
    }
    if(url.pathname==="/api/web-chat/files"&&!fileListOnline)throw new Error("file list offline");
    if(url.pathname==="/api/web-chat/files")return Response.json({files:[...files.values()].filter((file)=>file.state!=="deleted"),next_cursor:""});
    if(url.pathname.startsWith("/api/web-chat/files/")){
      const id=url.pathname.split("/")[4];const file=files.get(id);
      if(!file)return Response.json({error:"missing"},{status:404});
      if(init.method==="DELETE"){file.state="deleted";return Response.json({file});}
      if(url.pathname.endsWith("/download"))return new Response(fileBodies.get(id),{headers:{"Content-Type":file.mime,"Content-Length":String(new TextEncoder().encode(fileBodies.get(id)).length)}});
      if(url.pathname.endsWith("/content")){
        const lines=fileBodies.get(id).split("\n");const from=Number(url.searchParams.get("from_line"));const to=Math.min(Number(url.searchParams.get("to_line")),lines.length);
        return Response.json({file_id:id,name:file.name,sha256:file.sha256,total_lines:lines.length,from_line:from,to_line:to,lines:lines.slice(from-1,to).map((text,index)=>({line:from+index,text}))});
      }
      return Response.json({file});
    }
    if (/\/conversations\/[^/]+\/messages\/[^/]+$/.test(url.pathname)) {
      const id=url.pathname.split("/").at(-1),conversation=url.pathname.split("/").at(-3);
      if(delayedMessage)await new Promise(resolve=>{finishMessage=resolve;});
      if(messageStatus!==200)return Response.json({error:"unavailable"},{status:messageStatus});
      const source=completeMessages.get(id)??history.get(conversation)?.find(message=>message.id===id);
      return source?Response.json({message:{...source,conversation_id:conversation,content_omitted:false}}):Response.json({error:"missing"},{status:404});
    }
    if (url.pathname.endsWith("/messages")) {
      const id = url.pathname.split("/").at(-2);
      const before=url.searchParams.get("before_id"),after=url.searchParams.get("after_id"),limit=Number(url.searchParams.get("limit")??50),all=history.get(id)??[];
      if(before&&delayedHistory)await new Promise(resolve=>{finishHistory=resolve;});
      if(before&&failHistory)return Response.json({error:"unavailable"},{status:503});
      if(!before&&!after&&failInitialHistory)return Response.json({error:"unavailable"},{status:503});
      const start=after?all.findIndex(message=>message.id===after)+1:Math.max(0,(before?all.findIndex(message=>message.id===before):all.length)-limit),end=after?Math.min(all.length,start+limit):before?all.findIndex(message=>message.id===before):all.length,messages=all.slice(start,end);
      return Response.json({messages,next_before_id:start>0?messages[0]?.id??"":"",next_after_id:end<all.length?messages.at(-1)?.id??"":"",has_more:after?end<all.length:start>0});
    }
    if (url.pathname === "/api/web-chat/runs" && init.method === "POST") {
      const body = JSON.parse(init.body);
      let run = [...runs.values()].find((item) => item.client_request_id === body.client_request_id);
      if(!run&&queueIsFull){if(delayedQueueFull)await new Promise(resolve=>{finishQueueFull=resolve;});return Response.json({reason:"account_queue_full",error:"synthetic rejection"},{status:429});}
      if (!run) {
        run = snapshot({
          id: "created-run", client_request_id: body.client_request_id,
          conversation_id: body.conversation_id, user_message_id: "created-user", assistant_message_id: "created-assistant", state: "queued",
        });
        runs.set(run.id, run);
        const content=Array.isArray(body.content)?body.content.map((part)=>part.type==="file_reference"?{...part,name:files.get(part.file_id).name,size:files.get(part.file_id).size,mime:files.get(part.file_id).mime}:part.type==="artifact_reference"?artifactSnapshot(artifacts.get(part.version_id)):part):body.content;
        history.set(body.conversation_id, [...(history.get(body.conversation_id) ?? []), { id: run.user_message_id, role: "user", content }]);
      }
      if (delayedSubmit) await new Promise(resolve => { finishSubmit = resolve; });
      if (!online) throw new Error("response lost after acceptance");
      return Response.json({ run }, { status: 202 });
    }
    if (url.pathname === "/api/web-chat/runs") {
      if (!online) throw new Error("lookup offline");
      const id = url.searchParams.get("conversation_id");
      if(url.searchParams.has("user_message_id")){
        if(delayedRunHead&&id===firstConversation)await new Promise(resolve=>{finishRunHead=resolve;});
        const matching=[...runs.values()].filter(run=>run.conversation_id===id&&run.user_message_id===url.searchParams.get("user_message_id"));
        return Response.json({runs:matching.map(({output,usage,model_parameters,public_research,...head})=>head),output_included:false});
      }
      return Response.json({ runs: [...runs.values()].filter((run) => run.conversation_id === id && (!url.searchParams.has("client_request_id") || run.client_request_id===url.searchParams.get("client_request_id")) &&
        (url.searchParams.get("active") !== "true" || ["queued", "running", "cancelling"].includes(run.state))) });
    }
    if (url.pathname.endsWith("/events")) {
      if(streamLimit)return Response.json({reason:"cloud_stream_limit"},{status:429});
      const id = url.pathname.split("/").at(-2);
      let body;
      const stream = { id, closed: false, emit: (value) => body.enqueue(new TextEncoder().encode(value)) };
      streams.push(stream);
      return new Response(new ReadableStream({
        start(controller) { body = controller; },
        cancel() { stream.closed = true; },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/cancel")) {
      const id = url.pathname.split("/").at(-2);
      const run = { ...runs.get(id), state: "cancelling" };
      runs.set(id, run);
      if (delayedCancel) return new Promise((resolve) => { resolveCancel = () => resolve(Response.json({ run })); });
      return Response.json({ run });
    }
    const run = runs.get(url.pathname.split("/").at(-1));
    if (run) return Response.json({ run });
    throw new Error(`Unexpected fixture request ${path}`);
  };

  env = await createWebDomTestEnv({ mocks: {
    // Keep parent integration independent of Vite's dynamic preview imports, which the VM loader cannot execute.
    ...(readerHarness ? {
      "@liveagent/ui/components/resource-preview/ResourcePreview": {
        ResourceThumbnail:()=>null,
        ResourcePreviewReadingSession:props=>props.children,
        ResourcePreview:props=>env.React.createElement("div",{"data-reader-resource":props.resource.identity,"data-from-line":props.sourceRange?.fromLine,"data-to-line":props.sourceRange?.toLine},props.resource.name),
      },
    } : {}),
    ...(revisionHarness ? {
      "@/components/CloudChatFilePanel": {CloudChatFilePanel: props => {revisionPanel=props;return null;}},
      "@/components/cloudchat/CloudChatArtifactsPanel": {CloudChatArtifactsPanel: props => {revisionPanel=props;return null;}},
    } : {}),
    "@/lib/mobileRuntime": { isEmbeddedMobileRuntime: () => mobileLayout, MOBILE_BACK_EVENT: "zeroagent:mobile-back" },
    "@liveagent/ui/components/IconSet": new Proxy({}, {get:()=>()=>null}),
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx",import.meta.url))]: new Proxy({}, {get:()=>()=>null}),
    ...(realTranscript?{
      "@liveagent/ui/components/IconSet":new Proxy({}, {get:()=>()=>null}),
      [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx",import.meta.url))]:new Proxy({}, {get:()=>()=>null}),
      "@liveagent/ui/i18n/LocaleContext":{useLocale:()=>({locale:"zh-CN",t:key=>key})},
      "@liveagent/ui/i18n/index":{useLocale:()=>({locale:"zh-CN",t:key=>key})},
      [fileURLToPath(new URL("../../../agent-ui/src/i18n/index.ts",import.meta.url))]:{useLocale:()=>({locale:"zh-CN",t:key=>key})},
      "@liveagent/ui/lib/chat/useCommitDetailsLoader":{useCommitDetailsLoader:()=>async()=>null},
      "@liveagent/ui/lib/transcript-virtual/useTranscriptNavigation":{useTranscriptNavigation:()=>{}},
      "@liveagent/ui/components/chat/UserAttachmentCards":{UserAttachmentCards:()=>null},
      [fileURLToPath(new URL("../../../agent-ui/src/components/chat/UserAttachmentCards.tsx",import.meta.url))]:{UserAttachmentCards:props=>env.React.createElement("div",{"data-editor-attachments":""},props.files.map(file=>file.fileName).join(" "))},
      "@liveagent/ui/components/chat/ChatEmptyState":{ChatEmptyState:()=>null},
      "@liveagent/ui/components/chat/ContextCheckpointCard":{ContextCheckpointCard:()=>null},
      "@liveagent/ui/components/chat/RetryDetailsBlock":{RetryDetailsBlock:()=>null},
      "@liveagent/ui/lib/chat/userMessageContent":{UserMessageContent:props=>env.React.createElement("span",null,props.text)},
      "@liveagent/ui/components/chat/TranscriptMessageActions":{TranscriptUserMessageActions:()=>null,TranscriptAssistantMessageActions:()=>null},
      "@liveagent/ui/components/Markdown":{Markdown:props=>env.React.createElement("div",{"data-markdown-leaf":""},props.content??props.children)},
      "@liveagent/ui/components/chat/StreamingSplitMarkdown":{StreamingSplitMarkdown:props=>env.React.createElement("div",{"data-markdown-leaf":""},props.content)},
      "@tanstack/react-virtual":{useVirtualizer:options=>({getVirtualItems:()=>Array.from({length:options.count},(_,index)=>({index,key:options.getItemKey(index),start:index*100,size:100,end:(index+1)*100})),getTotalSize:()=>options.count*100,measureElement:()=>{},scrollToIndex:(index,options)=>editScrolls.push({index,options}),scrollToEnd:()=>{},takeSnapshot:()=>[],getSettledScrollOffset:()=>0})},
    }:{}),
    ...(realModelControls?{
      "@liveagent/app/lib/settings":{DEFAULT_CHAT_RUNTIME_CONTROLS:{reasoning:"medium",thinkingEnabled:true,nativeWebSearchEnabled:true},isAgentDevMode:()=>false,isAgentExecutionMode:()=>false},
      "@liveagent/ui/components/models/ModelPickerContent":{ModelPickerContent:()=>null},
      "@liveagent/ui/components/ProviderBrandIcon":{ProviderBrandIcon:()=>null},
      "@liveagent/ui/components/ui/button":{Button:({variant,size,render,...props})=>env.React.createElement("button",props,props.children),buttonVariants:()=>""},
      "@liveagent/ui/components/ui/menu-surface":{menuSurfaceClassName:()=>""},
      "@liveagent/ui/components/ui/popover":{Popover:props=>{modelPopoverChange=props.onOpenChange;return props.children;},PopoverContent:props=>env.React.createElement("div",null,props.children),PopoverTrigger:props=>env.React.cloneElement(props.render,{...props.render.props,id:props.id,onClick:()=>modelPopoverChange?.(true,{reason:"trigger-press",trigger:{id:props.id}})},props.children)},
      "@liveagent/ui/components/ui/switch":{Switch:props=>env.React.createElement("input",{type:"checkbox",role:"switch","aria-label":props["aria-label"],checked:props.checked,disabled:props.disabled,onChange:event=>props.onCheckedChange(event.target.checked)})},
      "@liveagent/ui/i18n/index":{useLocale:()=>({locale:"zh-CN",t:key=>key})},
      "@liveagent/ui/components/IconSet":new Proxy({}, {get:()=>()=>null}),
    }:{}),
    "@liveagent/ui/application/ApplicationView": { ApplicationView: (props) => props.chat.content },
    "@liveagent/ui/application/AppWorkbenchChrome": { AppWorkbenchChrome: (props) => env.React.createElement("header",null,props.navigationActions,props.leadingActions,props.trailingActions) },
    "@/components/cloudchat/CloudContextSidebar": { CloudContextSidebar: props => env.React.createElement('aside',{'data-context-destination':props.destination},env.React.createElement('button',{onClick:()=>props.onOpenResource('files')},'文件')) },
    "@liveagent/ui/components/AppErrorBoundary": { AppErrorBoundary: (props) => props.children },
    "@liveagent/ui/components/chat/ChatHistorySidebar": { ChatHistorySidebar: (props) => {sidebar=props;return env.React.createElement("nav", {"data-sidebar-loading":props.listStatus},
      env.React.createElement("button", {"data-new-conversation":"",onClick:props.onNewConversation}, "新对话"),
      typeof props.navigationContent === "function" ? props.navigationContent({ renderConversation: item => env.React.createElement("button", { "data-conversation": item.id, "aria-current": item.id === props.currentConversationId ? "page" : undefined, onClick: () => props.onSelectConversation(item.id) }, item.title) }) : props.navigationContent,
      props.items.map((item) => env.React.createElement("button", { key: item.id, "data-conversation": item.id, onClick: () => props.onSelectConversation(item.id) }, item.title)),
      props.hasMore?env.React.createElement("button",{"data-more-conversations":"",disabled:props.isLoadingMore,onClick:props.onLoadMore},props.isLoadingMore?"正在加载更多会话":"加载更多会话"):null,props.accountMenu,props.mobileRail,
      props.errorMessage?env.React.createElement("p",{role:"alert"},props.errorMessage):null,props.footerTrailing); } },
    "@liveagent/ui/components/ui/scroll-area": { ScrollArea: (props) => env.React.createElement("div", { ref: props.viewportRef }, props.children) },
    "@liveagent/ui/components/ui/sidebar": { useSidebar: () => ({ isMobile: mobileLayout, open: true, openMobile: true, setOpen: () => undefined, setOpenMobile: () => undefined }) },
    "@liveagent/ui/components/ui/dialog": {Dialog:props=>props.open===false?null:props.children,DialogContent:props=>env.React.createElement("div",{role:"dialog"},props.children),DialogHeader:props=>props.children,DialogFooter:props=>props.children,DialogTitle:props=>env.React.createElement("h2",null,props.children),DialogDescription:props=>env.React.createElement("p",null,props.children)},
    "@liveagent/ui/lib/shared/id": { createUuid: () => fixtureUUID(++uuid) },
    "@liveagent/ui/lib/sidebar/batchDelete": { deleteSidebarConversations: async () => undefined },
    "@liveagent/ui/pages/chat/transcript/FloorNavRail": {FloorNavRail:props=>{floorNav=props;return null;}},
    "@liveagent/ui/pages/chat/ChatComposerBar": { ChatComposerBar: (props) => {
      composer = props;
      env.React.useImperativeHandle(props.composerRef, () => ({
        getDraft: () => structuredDraft??({ text: draft, textWithoutLargePastes:draft, segments:draft?[{type:"text",text:draft}]:[],largePastes:[],skillMentions:[],appMentions:[],commitMentions:[],gitFileMentions:[],codeMentions:[],isEmpty:!draft }), clear: () => { draft = ""; structuredDraft=null;clearCount++; },setText:(text)=>{draft=text;structuredDraft=null;},setDraft:(next)=>{draft=next.text;structuredDraft=next;},focus:()=>{},
      }));
      return env.React.createElement("footer", null,
        env.React.createElement("div", {"data-fixture-composer":"", contentEditable:true,suppressContentEditableWarning:true}),
        props.feedback,
        realModelControls?env.React.createElement(env.loadModule("../../agent-ui/src/components/chat/ComposerModelControls.tsx").ComposerModelControls,{...props,open:true,showExecutionControls:env.loadModule("@liveagent/ui/contracts/composerPresentation.ts").resolveComposerControls(props.capabilities,{executionControls:props.showExecutionControls}).executionControls}):null,
        env.React.createElement("div",{"data-pending-attachments":""},props.pendingUploadedFiles.map(file=>env.React.createElement("div",{key:file.relativePath},env.React.createElement("button",{onClick:()=>props.onOpenPendingUpload?.(file.relativePath)},file.fileName+(file.statusText?` · ${file.statusText}`:"")),env.React.createElement("button",{"aria-label":`移除 ${file.fileName}`,onClick:()=>props.onRemovePendingUpload(file.relativePath)},"移除")))),
        env.React.createElement("button", { "data-action": "send", onClick: props.onSend, disabled: (props.isSending && !props.allowQueueWhileSending) || props.isInputDisabled }, "发送"),
        env.React.createElement("button", { "data-action": "stop", onClick: props.onStop, disabled: !props.isSending }, "停止"));
    } },
    "@liveagent/ui/pages/settings/SettingsPage": { SettingsPage: props => env.React.createElement("section", {"data-settings-page":props.presentation}, env.React.createElement("button", {"data-settings-back":"",onClick:props.onBack},"返回对话")) },
    "@/app/chatDraft": { buildTextFromComposerDraft: (value) => value.text },
    "@/app/UserMenu": { UserMenu: (props) => env.React.createElement("button", {"data-account-menu":props.variant,onClick:props.onOpenSettings}, "账户菜单") },
    "@/components/ExecutionEnvironmentSwitcher": { ExecutionEnvironmentSwitcher: () => null },
    "@/components/GatewayBrand": { GatewayBrand: () => null },
    "@/components/cloudchat/CloudProjectSettingsDialog":{CloudProjectSettingsDialog:(props)=>{projectPanel=props;return env.React.createElement("section",{"data-project-panel":""},"项目测试面板");}},
    "@/components/cloudchat/CloudChatContextPicker":{CloudChatContextPicker:props=>{composerContextPicker=props;return null;},CloudChatWorkToolbar:()=>null},
    "@/components/cloudchat/CloudChatMemoryPanel":{CloudChatMemoryPanel:(props)=>{memoryPanel=props;return env.React.createElement("section",{"data-memory-panel":""},"记忆测试面板");}},
    "@/components/onboarding/FirstRunOnboarding": { FirstRunOnboarding: () => null },
    "@/components/GatewayTranscript": { GatewayTranscript: (props) => {transcript=props;if(realTranscript)return env.React.createElement(env.loadModule("src/components/GatewayTranscript.tsx").GatewayTranscript,props);return env.React.createElement("section", { "data-transcript": "", "data-streaming": props.isStreaming },
      !props.rows.length&&!props.isLoading&&props.hasModels?props.emptyState:null,
      props.hasMoreHistory?env.React.createElement("button",{onClick:props.onLoadEarlierHistory,disabled:props.isLoadingMoreHistory},props.isLoadingMoreHistory?"正在加载更早历史...":"加载更早历史"):null,
      props.rows.map((row) => env.React.createElement("p", { key: row.key, "data-message": row.key }, row.kind === "user" ? `${row.text} ${row.attachments.map(file=>file.fileName).join(" ")}` : row.rounds.flatMap((round) => round.blocks.map((block) => block.text)).join(""))),
      props.error ? env.React.createElement("p", { role: "alert" }, props.error) : null,props.footer);} },
    "@/lib/accountRequest": { ACCOUNT_CHANGED_EVENT: "account-changed", accountFetch: request, captureAccountRequestGuard:()=>{const captured=accountRevision;return()=>{if(captured!==accountRevision)throw new Error("Account changed while the request was pending");};} },
    "@/lib/chat/chatPageHelpers": { buildModelOptions: () => [{ value: "test-model", model: "test-model", providerId: "key-1" }] },
    "@/lib/providers/llm": { toModelValue: (_provider, model) => model },
    "@/lib/relay/client": {
      getRelayDashboardStats: async () => ({}), getRelayProfile: async () => ({ id: 1 }),
      listRelayApiKeys: async () => [], listRelayGroups: async () => [], notifyRelaySessionExpired: () => undefined,
      RELAY_SESSION_CHANGED_EVENT: "relay-session-changed", RELAY_SESSION_EXPIRED_EVENT: "relay-session-expired",
    },
    "@/lib/relay/providers": {
      bindRelayKeysToSettings: async (value) => value, mergeRefreshedRelaySettings: (_old, value) => value,
      relayProviderId: (id) => `key-${id}`, relayProviderKeyId: () => 1,
    },
    "@/lib/settings": { DEFAULT_CHAT_RUNTIME_CONTROLS: { reasoning: "medium" }, getNextTheme: () => "light" },
  } });
  const formGlobals=["HTMLInputElement","HTMLTextAreaElement","HTMLSelectElement"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
  for(const [key]of formGlobals)Object.defineProperty(globalThis,key,{value:env.dom.window[key],configurable:true,writable:true});
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.history.replaceState({}, "", newDraft ? "/" : `/?conversation=${firstConversation}`);
  const { CloudChatPage } = env.loadModule("src/pages/CloudChatPage.tsx");
  const container = document.body.appendChild(document.createElement("div"));
  const host = document.body;
  const root = env.createRoot(container);
  const settings = { customProviders:modelSettings,stt: {}, customSettings: { fontScale: { chat: 1, sidebar: 1 } } };
  let user = { id: 1, email: "account-a@example.test" };
  const render = async () => env.act(async () => {
    root.render(env.React.createElement(CloudChatPage, {
      user, onUserChange: () => undefined, environments: [], selection: null, settings,
      setSettings: () => undefined, settingsSaveState: "saved", onSwitch: async () => undefined, onLogout: () => undefined,
    }));
    await tick();
  });
  t.after(async () => { await env.act(async () => root.unmount()); container.remove(); for(const [key,descriptor]of formGlobals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}env.cleanup(); });
  await render();

  return {
    env, calls, streams, history, runs, host, files,branches,artifacts,editScrolls,pendingQueues,savedDrafts,
    get sidebar(){return sidebar;},
    get revisionPanel(){return revisionPanel;},
    set delayRename(value){delayRename=value;},
    async finishRename(){await env.act(async()=>{finishRename();await tick();});},
    get composer() { return composer; }, get clearCount() { return clearCount; },
    get transcript(){return transcript;},
    get floorNav(){return floorNav;},
    get draft(){return draft;},set draft(value){draft=value;structuredDraft=null;},get structuredDraft(){return structuredDraft;},set structuredDraft(value){structuredDraft=value;draft=value.text;},get projectPanel(){return projectPanel;},get memoryPanel(){return memoryPanel;},
    async typeDraft(value){await env.act(async()=>{draft=value;structuredDraft=null;host.querySelector('[data-fixture-composer]').dispatchEvent(new Event('input',{bubbles:true}));await tick();});},
    async flushDraft(){await env.act(async()=>{window.dispatchEvent(new Event('pagehide'));await tick();await tick();});},
    get contextPicker(){return composerContextPicker;},projectRecords,projectBindings,
    set delayProjectAssociation(value){delayProjectAssociation=value;},
    async finishProjectAssociation(){await env.act(async()=>{finishProjectAssociation();await tick();});},
    async updateModels(providers){settings.customProviders=providers;await render();},
    set branchOnline(value){branchOnline=value;},
    set online(value) { online = value; },
    set queueFull(value){queueIsFull=value;},
    async finishQueueFull(){await env.act(async()=>{finishQueueFull();await tick();});},
    set failHistory(value){failHistory=value;},
    set failInitialHistory(value){failInitialHistory=value;},
    set failConversationPage(value){failConversationPage=value;},
    async finishConversations(){await env.act(async()=>{finishConversations();await tick();});},
    async finishRunHead(){await env.act(async()=>{finishRunHead();await tick();});},
    get modelLimits(){return savedModelLimits;},set modelLimits(value){savedModelLimits=value;},
    async finishModelLimits(){await env.act(async()=>{finishModelLimits();await tick();});},
    async finishHistory(){await env.act(async()=>{finishHistory();await tick();});},
    async finishMessage(){await env.act(async()=>{finishMessage();await tick();});},
    async openMessage(id){await env.act(async()=>{transcript.onOpenFileLink({path:`cloud-messages/${id}`,source:"relative"});await tick();});},
    async click(selector) { await env.act(async () => { host.querySelector(selector).click(); await tick(); }); },
    async emit(id, seq, type, data = {}) {
      await env.act(async () => {
        const previous = runs.get(id);
        const next = { ...previous, last_seq: seq };
        if (type === "message.delta") next.output += data.delta;
        if (type === "run.started") next.state = "running";
        if (["run.completed", "run.cancelled", "run.failed", "run.interrupted"].includes(type)) {
          next.state = type.slice(4);
          history.set(next.conversation_id, [...history.get(next.conversation_id), { id: next.assistant_message_id, role: "assistant", content: next.output }]);
        }
        runs.set(id, next);
        streams.findLast((stream) => stream.id === id && !stream.closed)?.emit(`event: cloud_run\ndata: ${JSON.stringify({ run_id: id, seq, type, data })}\n\n`);
        await tick();
      });
    },
    async invalidate() { await env.act(async () => {accountRevision++; window.dispatchEvent(new Event("account-changed")); await tick(); }); },
    async finishCancel() { await env.act(async () => { resolveCancel(); await tick(); }); },
    async finishSubmit() { await env.act(async () => { finishSubmit(); await tick(); }); },
    async switchAccount(id) { user = { id, email: `account-${id}@example.test` }; accountRevision++; await render(); },
    set uploadOnline(value){uploadOnline=value;},
    set fileListOnline(value){fileListOnline=value;},
    async paste(files){await env.act(async()=>{composer.onPasteFiles(files);await tick();});},
    async finishUpload(){await env.act(async()=>{finishUpload();await tick();});},
    async finishBranch(){await env.act(async()=>{finishBranch();await tick();});},
    async finishArtifact(){await env.act(async()=>{finishArtifact();await tick();});},
    async openArtifact(id=artifactVersionID){await env.act(async()=>{transcript.onOpenFileLink({path:`cloud-artifacts/${id}`,source:"relative"});await tick();});},
    async reload(){await env.act(async()=>{root.render(null);await tick();});await render();},
    async chooseArtifact(id){if(!host.querySelector(".za-reader-version")){await this.clickText("版本历史记录");}const button=host.querySelector(`[data-version-id="${id}"]`);assert.ok(button);await env.act(async()=>{button.click();await tick();});},
    async edit(messageID,text,files=[]){const ref=transcript.rows.find(row=>row.key===messageID).messageRef;await env.act(async()=>{transcript.onResendFromEdit(ref,text,files,[]);await tick();});},
    async fork(messageID){const ref=transcript.rows.find(row=>row.key===messageID).messageRef;await env.act(async()=>{transcript.onBranchConversation(ref);await tick();});},
    async clickText(text){
      const find=()=>[...document.querySelectorAll('button,[role="menuitem"]')].find(element=>element.textContent.trim()===text);
      let button=find();
      if(!button && ["引用到消息","文件信息","版本历史记录","与 AI 一起工作"].includes(text)){
        const title=host.querySelector('[aria-label^="文件菜单："]');
        assert.ok(title,`missing file menu for ${text}`);
        await env.act(async()=>{title.click();await tick();});button=find();
      }
      if(!button && text==="文件库"){await env.act(async()=>{sidebar.onOpenResourceHub();await tick();});return;}
      if(!button && text==="项目"){await env.act(async()=>{composerContextPicker.onBrowse("projects");await tick();});return;}
      assert.ok(button,`missing control ${text}`);await env.act(async()=>{button.click();await tick();});
    },
    async setResearchTopic(value){const input=host.querySelector('textarea[aria-label="可用于公开检索的主题"]');assert.ok(input);await env.act(async()=>{Object.getOwnPropertyDescriptor(env.dom.window.HTMLTextAreaElement.prototype,"value").set.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));await tick();});},
    async setInput(label,value){const input=host.querySelector(`input[aria-label="${label}"]`);assert.ok(input);await env.act(async()=>{Object.getOwnPropertyDescriptor(env.dom.window.HTMLInputElement.prototype,"value").set.call(input,String(value));input.dispatchEvent(new Event("input",{bubbles:true}));await tick();});},
    async effort(level) {
      const input=host.querySelector('input[type="range"]'); assert.ok(input);
      const choices=["off",...composer.reasoningOptions.filter(value=>value!=="off")], index=choices.indexOf(level); assert.ok(index>=0);
      await env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(input,String(index));input.dispatchEvent(new Event("input",{bubbles:true}));await tick();});
      await env.act(async()=>{input.dispatchEvent(new KeyboardEvent("keyup",{key:"ArrowRight",bubbles:true}));await tick();});
    },    async showReasoning(){const button=[...host.querySelectorAll("button")].find(node=>node.getAttribute("aria-label")?.startsWith("chat.runtime.reasoning:"));assert.ok(button);await env.act(async()=>{button.click();await tick();});},
  };
}

test("reopening a conversation restores its active run; switching views detaches without server cancellation", async (t) => {
  const app = await mount(t, { initialRun: snapshot({ output: "已生成的内容", last_seq: "2" }) });
  assert.match(app.host.textContent, /已生成的内容/);
  assert.equal(app.composer.isSending, true);
  assert.equal(app.streams.length, 1);
  await app.click(`[data-conversation="${alternateConversation}"]`);
  assert.equal(app.streams[0].closed, true);
  assert.match(app.host.textContent, /另一个会话/);
  assert.doesNotMatch(app.host.textContent, /已生成的内容/);
  assert.equal(app.calls.some((call) => call.path.endsWith("/cancel")), false);
  await app.click(`[data-conversation="${defaultConversation}"]`);
  assert.match(app.host.textContent, /已生成的内容/);
  assert.equal(app.streams.length, 2);
  assert.equal(app.composer.isSending, true);
});

test("offline terminal recovery marks the exact last turn without watching, rerunning or replacing its canonical body",async(t)=>{
 for(const scenario of [
  {state:"interrupted",error_code:"cloud_cancellation_outcome_unknown",output:"private stale output",canonical:"服务端保存的部分答复",notice:/远端执行结果.*尚未确认/},
  {state:"failed",output:"",canonical:null,notice:/任务未能完成/},
  {state:"cancelled",output:"partial",canonical:"已保存的片段",notice:/任务已停止/},
  {state:"completed",output:"wrong",canonical:"完整持久答案",notice:null},
 ])await t.test(scenario.state,async(child)=>{
   const messages=[{id:"user-a",role:"user",content:"原问题"},...(scenario.canonical?[{id:"assistant-a",role:"assistant",content:scenario.canonical}]:[])];
   const app=await mount(child,{initialRun:snapshot(scenario),initialMessages:messages});
   assert.equal(app.streams.length,0);assert.equal(app.composer.isSending,false);assert.equal(app.calls.some(call=>call.method==="POST"),false);assert.equal(app.calls.filter(call=>call.path.includes("user_message_id=user-a")).length,1);
   assert.equal(app.transcript.assistantLiveMode,"streaming");assert.equal(app.transcript.isStreaming,false);
   assert.equal(app.transcript.rows.length,messages.length);if(scenario.canonical)assert.ok(app.host.textContent.includes(scenario.canonical));else assert.equal(app.host.querySelector('[data-message="assistant-a"]'),null);
   if(scenario.notice)assert.match(app.host.textContent,scenario.notice);else assert.equal(app.host.querySelector("[data-restored-run-state]"),null);
   assert.doesNotMatch(app.host.textContent,/private stale output|wrong/);
 });
});

test("a late terminal head cannot mark another conversation or a retired account",async(t)=>{
 for(const retire of ["view","account"])await t.test(retire,async(child)=>{
   const app=await mount(child,{initialRun:snapshot({state:"interrupted",error_code:"cloud_cancellation_outcome_unknown"}),delayedRunHead:true});
   if(retire==="view")await app.click(`[data-conversation="${alternateConversation}"]`);else await app.invalidate();
   await app.finishRunHead();assert.equal(app.host.querySelector("[data-restored-run-state]"),null);assert.doesNotMatch(app.host.textContent,/远端执行结果/);assert.equal(app.streams.length,0);
 });
});

test("real Cloud Page recovery renders completed and failed/interrupted partials through the shared AssistantBubble answer layer",async(t)=>{
 for(const state of ["completed","failed","interrupted"])await t.test(state,async(child)=>{
  const text=`${state}：合成公开成品或已保存片段。`.repeat(24),messages=[{id:"user-a",role:"user",content:"原问题"},{id:"assistant-a",role:"assistant",content:text}];
  const app=await mount(child,{realTranscript:true,initialRun:snapshot({state,output:text,...(state==="interrupted"?{error_code:"cloud_cancellation_outcome_unknown"}:{})}),initialMessages:messages});
  const body=()=>[...app.host.querySelectorAll(".assistant-bubble-shell [data-markdown-leaf]")].find(node=>node.textContent===text);
  assert.ok(body());assert.equal(body().closest("[data-chat-work-trace]"),null);assert.equal(app.streams.length,0);assert.equal(app.calls.some(call=>call.method==="POST"),false);if(state!=="completed")assert.equal(app.host.querySelector("[data-restored-run-state]").dataset.restoredRunState,state);
  await app.reload();assert.ok(body());assert.equal(body().closest("[data-chat-work-trace]"),null);
 });
});

test("real Cloud streaming changes to a readable answer after completion even if the user folded the process",async(t)=>{
 const text="合成公开成品方案，包含目标、步骤及交付结果。".repeat(24),app=await mount(t,{realTranscript:true,initialRun:snapshot({output:text})});
 const work=app.host.querySelector("[data-chat-work-trace]");assert.ok(work);assert.equal(work.getAttribute("aria-busy"),"true");await app.env.act(async()=>{work.querySelector("button").click();await tick();});assert.equal(work.querySelector("button").getAttribute("aria-expanded"),"false");
 await app.emit("run-a","2","run.completed");const body=[...app.host.querySelectorAll(".assistant-bubble-shell [data-markdown-leaf]")].find(node=>node.textContent===text);assert.ok(body);assert.equal(body.closest("[data-chat-work-trace]"),null);assert.equal(app.host.querySelector("[data-chat-work-trace]"),null);
});

test("a zero-output failure reviews the last request in the real editor before branching, preserving original refs and the independent draft",async(t)=>{
 const source=[{id:"old-user",role:"user",content:"较早问题"},{id:"old-answer",role:"assistant",content:"较早的已完成答复"},{id:"failed-user",role:"user",content:[{type:"text",text:"请把方案精简到三步"},{type:"file_reference",file_id:fileId,name:"notes.md",mime:"text/markdown",size:5},artifactSnapshot(artifactRecord())]}];
 const app=await mount(t,{realTranscript:true,fileMode:true,initialRun:snapshot({conversation_id:fileConversation,user_message_id:"failed-user",assistant_message_id:"failed-answer",state:"failed",error_code:"model_upstream_unavailable",output:""}),initialMessages:structuredClone(source),initialFiles:[fileRecord()],initialArtifacts:[artifactRecord()]});
 const failure=app.host.querySelector('[data-terminal-run-state="failed"]');
 assert.ok(failure.closest('.gateway-transcript-list'),'task feedback belongs to its conversation reading column');
 assert.equal(failure.closest('[data-app-workbench-chrome]'),null);
 app.draft="保留独立草稿";await app.clickText("编辑并重试");const editor=app.host.querySelector('textarea[aria-label="chat.editMessage"]');assert.ok(editor);assert.equal(editor.value,"请把方案精简到三步");assert.match(app.host.querySelector("[data-editor-attachments]").textContent,/notes.md.*website.html/);assert.equal(app.calls.some(call=>call.method==="POST"),false);assert.equal(app.host.querySelector("[data-terminal-run-state]").dataset.terminalRunState,"failed");assert.equal(app.editScrolls.at(-1).index,2);
 await app.clickText("chat.cancel");assert.equal(app.host.querySelector('textarea[aria-label="chat.editMessage"]'),null);assert.equal(app.calls.some(call=>call.method==="POST"),false);
 await app.clickText("编辑并重试");await app.clickText("chat.send");const branch=app.calls.find(call=>call.path.endsWith("/branch"));assert.ok(branch);assert.equal(JSON.parse(branch.body).message_id,"failed-user");assert.equal(JSON.parse(branch.body).action,"regenerate");const sent=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.notEqual(sent.conversation_id,fileConversation);assert.deepEqual(sent.content,[{type:"text",text:"请把方案精简到三步"},{type:"file_reference",file_id:fileId},{type:"artifact_reference",version_id:artifactVersionID}]);assert.equal(app.draft,"保留独立草稿");assert.deepEqual(app.history.get(fileConversation),source);
});

test("only confirmed cancelled or failed last turns offer review; unknown outcomes and unavailable long bodies never silently retry",async(t)=>{
 for(const state of ["cancelled","interrupted"])await t.test(state,async(child)=>{const app=await mount(child,{initialRun:snapshot({state,output:"",error_code:state==="interrupted"?"cloud_cancellation_outcome_unknown":""})});assert.equal([...app.host.querySelectorAll("button")].some(button=>button.textContent==="编辑并重试"),state==="cancelled");assert.equal(app.calls.some(call=>call.method==="POST"),false);if(state==="interrupted")assert.match(app.host.textContent,/尚未确认/);});
 for(const omitted of [false,true])await t.test(omitted?"omitted":"large",async(child)=>{const complete="中".repeat(40000),message={id:"user-a",role:"user",content:omitted?null:complete,...(omitted?{content_omitted:true,content_bytes:120000,content_sha256:"a".repeat(64)}:{})};const app=await mount(child,{realTranscript:true,initialRun:snapshot({state:"failed",output:""}),initialMessages:[message],fullMessages:[{...message,content:complete,content_omitted:false}]});assert.equal([...app.host.querySelectorAll("button")].some(button=>button.textContent==="编辑并重试"),false);await app.clickText("查看原请求正文");assert.equal(app.host.querySelector('textarea[aria-label="chat.editMessage"]'),null);assert.equal(app.calls.some(call=>call.method==="POST"),false);assert.ok(app.host.textContent.length<16000);});
});

test("conversation pagination keeps draft and history, deduplicates changed pages and recovers a failed page explicitly",async(t)=>{
 const record=(id,title=`会话${id}`)=>({id,title,model:"test-model",updated_at:"2026-10-29T00:00:00Z"});
 const app=await mount(t,{conversationPages:[[record(defaultConversation),record(alternateConversation)],[record(alternateConversation,"更新的会话b"),record("c")],[record("d")]]});
 app.draft="未发送草稿";const messageReads=()=>app.calls.filter(call=>call.path.includes("/messages")).length,before=messageReads();app.failConversationPage=true;
 await app.click('[data-more-conversations]');assert.match(app.host.textContent,/暂时无法处理对话/);assert.equal(app.host.querySelector('[data-conversation="c"]'),null);assert.equal(app.draft,"未发送草稿");
 app.failConversationPage=false;await app.clickText("重试会话列表");assert.equal(app.host.querySelectorAll(`[data-conversation="${alternateConversation}"]`).length,1);assert.equal(app.host.querySelector(`[data-conversation="${alternateConversation}"]`).textContent,"更新的会话b");assert.ok(app.host.querySelector('[data-conversation="c"]'));
 await app.click('[data-more-conversations]');assert.ok(app.host.querySelector('[data-conversation="d"]'));assert.equal(app.host.querySelector('[data-more-conversations]'),null);assert.equal(app.draft,"未发送草稿");assert.equal(messageReads(),before);assert.match(app.host.querySelector('[data-transcript]').textContent,/原问题/);
 assert.ok(app.calls.filter(call=>call.path.includes("conversations/catalog")).every(call=>call.method==="GET"));
});

test("late conversation pages cannot repopulate a retired account",async(t)=>{
 const record=id=>({id,title:`会话${id}`,model:"test-model",updated_at:"2026-10-29T00:00:00Z"});
 const app=await mount(t,{conversationPages:[[record(defaultConversation),record(alternateConversation)],[record("private-older")]],delayedConversations:true});
 await app.click('[data-more-conversations]');assert.equal(app.host.querySelector('[data-more-conversations]').disabled,true);await app.invalidate();await app.finishConversations();assert.equal(app.host.querySelector('[data-conversation="private-older"]'),null);assert.equal(app.host.querySelectorAll("[data-conversation]").length,0);
});

test("send binds server message IDs and cancel waits for the server terminal result", async (t) => {
  const app = await mount(t);
  await app.click('[data-action="send"]');
  assert.equal(app.calls.filter((call) => call.path === "/api/web-chat/runs" && call.method === "POST").length, 1);
  assert.equal(app.clearCount, 1);
  assert.equal(app.host.querySelectorAll('[data-message="created-user"]').length, 1);
  await app.emit("created-run", "2", "run.started");
  await app.emit("created-run", "3", "message.delta", { delta: "部分结果" });
  assert.match(app.host.textContent, /部分结果/);
  await app.click('[data-action="stop"]');
  assert.equal(app.calls.filter((call) => call.path.endsWith("/cancel")).length, 1);
  assert.equal(app.composer.isSending, true, "cancelling is not yet cancelled");
  assert.equal(app.streams[0].closed, false, "cancellation still observes its final event");
  await app.emit("created-run", "4", "run.cancelled");
  assert.equal(app.composer.isSending, false);
  assert.match(app.host.textContent, /任务已停止，已生成的内容已保留/);
  assert.equal(app.host.querySelectorAll('[data-message="created-assistant"]').length, 1);
  assert.equal(app.host.querySelectorAll('[data-message="created-user"]').length, 1);
});

test("a first-use model display submits its actual provider key instead of a hidden default", async (t) => {
  const app = await mount(t, { initialProviderKeyId: 0 });
  await app.click('[data-action="send"]');
  const request = app.calls.find((call) => call.path === "/api/web-chat/runs" && call.method === "POST");
  assert.ok(request, "first-use selection remains usable");
  assert.equal(JSON.parse(request.body).provider_key_id, 1);
});

test("uncertain acceptance keeps the original request and offers a reconciliation action", async (t) => {
  const app = await mount(t);
  app.online = false;
  await app.click('[data-action="send"]');
  assert.match(app.host.textContent, /提交结果尚未确认/);
  assert.equal(app.clearCount, 0);
  assert.equal(app.composer.isInputDisabled, true);
  app.online = true;
  const retry = [...app.host.querySelectorAll("button")].find((button) => button.textContent === "核对提交状态");
  await app.env.act(async () => { retry.click(); await tick(); });
  const posts = app.calls.filter((call) => call.path === "/api/web-chat/runs" && call.method === "POST");
  assert.equal(posts.length, 3);
  assert.ok(posts.every((call) => call.body === posts[0].body));
  assert.equal(app.runs.size, 1);
  assert.equal(app.history.get(defaultConversation).filter((message) => message.id === "created-user").length, 1);
  assert.equal(app.clearCount, 1);
  assert.equal(app.composer.isSending, true);
});

test("a delayed cancel acknowledgement cannot overwrite a newer terminal event", async (t) => {
  const app = await mount(t, { initialRun: snapshot({ output: "已完成的内容" }), delayedCancel: true });
  await app.click('[data-action="stop"]');
  await app.emit("run-a", "2", "run.completed");
  assert.equal(app.composer.isSending, false);
  await app.finishCancel();
  assert.equal(app.composer.isSending, false);
  assert.match(app.host.textContent, /已完成的内容/);
});

test("account invalidation clears the view and closes its subscriber without issuing cancel", async (t) => {
  const app = await mount(t, { initialRun: snapshot({ output: "账户A私有内容" }) });
  assert.match(app.host.textContent, /账户A私有内容/);
  await app.invalidate();
  assert.equal(app.streams[0].closed, true);
  assert.doesNotMatch(app.host.textContent, /账户A私有内容|原问题|会话a/);
  assert.equal(app.calls.some((call) => call.path.endsWith("/cancel")), false);
});

test("a persisted upload sends only a file reference and remains visible in the canonical message",async(t)=>{
 const app=await mount(t,{fileMode:true});
 await app.paste([new File(["hello"],"notes.md",{type:"text/markdown"})]);
 assert.equal(app.composer.pendingUploadedFiles.length,1);
 assert.match(app.host.textContent,/notes.md · 可引用/);
 const upload=app.calls.find(call=>call.path==="/api/web-chat/files"&&call.method==="POST");assert.ok(upload);assert.equal(upload.body.get("conversation_id"),fileConversation);
 await app.click('[data-action="send"]');
 const submit=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);
 assert.deepEqual(submit.content,[{type:"text",text:"新的问题"},{type:"file_reference",file_id:fileId}]);
 assert.equal(app.composer.pendingUploadedFiles.length,0);
 await app.emit("created-run","2","run.completed");
 assert.match(app.host.querySelector('[data-message="created-user"]').textContent,/notes.md/);
 assert.equal(app.transcript.rows.find(row=>row.kind==="user"&&row.key==="created-user").attachments[0].sizeBytes,5);
});

test("unparsed PDFs retain an original and cannot silently enter a model request",async(t)=>{
 const app=await mount(t,{fileMode:true});
 await app.paste([new File(["%PDF-1.7"],"source.pdf",{type:"application/pdf"})]);
 assert.match(app.host.textContent,/原件已保存，等待隔离解析/);
 await app.click('[data-action="send"]');
 assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);
 assert.match(app.host.textContent,/有附件尚未完成解析/);
 await app.env.act(async()=>{app.composer.onRemovePendingUpload(fileId);await tick();});
 assert.equal(app.composer.pendingUploadedFiles.length,0);
 assert.equal(app.files.has(fileId),true,"removing from a draft does not delete the original");
});

test("a late upload is detached on conversation switch and cannot contaminate the next draft",async(t)=>{
 const app=await mount(t,{fileMode:true,delayedUpload:true});
 await app.paste([new File(["hello"],"private-notes.md")]);
 assert.equal(app.composer.isUploadingFiles,true);
 await app.click(`[data-conversation="${secondFileConversation}"]`);
 await app.finishUpload();
 assert.equal(app.composer.pendingUploadedFiles.length,0);
 assert.equal(app.composer.isUploadingFiles,false);
 assert.doesNotMatch(app.host.textContent,/private-notes/);
 assert.equal(app.calls.some(call=>call.path.includes("/files/")&&call.method==="DELETE"),false);
 assert.equal(app.files.size,1,"the original stays discoverable from the account library");
});

test("the library restores reusable originals and small-text citations target the authenticated shared reader",async(t)=>{
 const app=await mount(t,{fileMode:true,readerHarness:true,initialFiles:[fileRecord()]});
 await app.clickText("文件库");
 assert.match(app.host.querySelector('[data-cloud-resource-inline]').textContent,/notes.md/);
 await app.clickText("notes.md");
 // Opening an original now uses the shared authenticated reader instead of the legacy line excerpt.
 assert.equal(app.host.querySelector('[data-reader-resource]').getAttribute("data-reader-resource"),`${fileId}:${fixtureBodySHA}`);
 assert.match(app.host.querySelector('[data-cloud-resource-inline]').textContent,/notes.md/);
 await app.clickText("引用到消息");
 assert.equal(app.composer.pendingUploadedFiles[0].relativePath,fileId);
 assert.equal(app.host.querySelector('[data-cloud-resource-inline]'),null);
 await app.env.act(async()=>{app.transcript.onOpenFileLink({path:`cloud-files/${fileId}`,source:"relative",line:1,endLine:1});await tick();});
 assert.equal(app.host.querySelector('[data-reader-resource]').getAttribute("data-from-line"),"1");assert.equal(app.host.querySelector('[data-reader-resource]').getAttribute("data-to-line"),"1");assert.equal(app.calls.some(call=>call.path.includes("/content?")),false);
 await app.invalidate();
 assert.equal(app.host.querySelector('[data-cloud-resource-inline]'),null);
 assert.doesNotMatch(app.host.textContent,/notes.md|hello/);
});

test("library deletion requires a concrete choice and removes draft references after confirmation",async(t)=>{
 const app=await mount(t,{fileMode:true,initialFiles:[fileRecord()]});
 await app.clickText("文件库");await app.clickText("删除原件");
 assert.equal(app.calls.some(call=>call.method==="DELETE"),false);
 await app.clickText("确认删除");
 assert.equal(app.calls.filter(call=>call.method==="DELETE"&&call.path===`/api/web-chat/files/${fileId}`).length,1);
 assert.equal(app.files.get(fileId).state,"deleted");
 assert.doesNotMatch(app.host.querySelector('[data-cloud-resource-inline]').textContent,/notes.md/);
});

const branchMessages=[{id:"source-user",role:"user",content:"原始问题"},{id:"source-assistant",role:"assistant",content:"原始回复"},{id:"later-user",role:"user",content:"后续问题"},{id:"later-assistant",role:"assistant",content:"后续回复"}];

test("editing a persisted user message creates a new branch and Run while preserving the unsent draft",async(t)=>{
 const app=await mount(t,{initialMessages:structuredClone(branchMessages)});
 const ref=app.transcript.rows.find(row=>row.key==="source-user").messageRef;
 assert.deepEqual(ref,{segmentIndex:0,messageIndex:0,segmentId:defaultConversation,messageId:"source-user",role:"user",contentHash:""});
 await app.edit("source-user","改写后的问题");
 const branchCall=app.calls.find(call=>call.path.endsWith("/branch"));
 assert.deepEqual({...JSON.parse(branchCall.body),client_request_id:"stable"},{client_request_id:"stable",message_id:"source-user",action:"edit",content:"改写后的问题"});
 const run=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);
 assert.equal(run.conversation_id,branchConversation(1));assert.equal(run.content,"改写后的问题");
 assert.equal(app.draft,"新的问题");assert.equal(app.clearCount,0);
 assert.deepEqual(app.history.get(defaultConversation),branchMessages);
 assert.match(app.host.textContent,/改写后的问题/);assert.doesNotMatch(app.host.textContent,/后续回复/);
});

test("an unchanged prompt regenerates its source files and preserves independent draft attachments",async(t)=>{
 const draftID="44444444-4444-4444-8444-444444444444";
 const sourceContent=[{type:"text",text:"阅读原件"},{type:"file_reference",file_id:fileId,name:"source.md",mime:"text/markdown",size:5}];
 const original=[{id:"source-user",role:"user",content:sourceContent},{id:"source-assistant",role:"assistant",content:"原件回复"}];
 const app=await mount(t,{fileMode:true,initialMessages:structuredClone(original),initialFiles:[fileRecord({name:"source.md"}),fileRecord({id:draftID,name:"draft.md"})]});
 await app.clickText("文件库");await app.clickText("draft.md");await app.clickText("引用到消息");
 assert.equal(app.composer.pendingUploadedFiles[0].relativePath,draftID);
 await app.edit("source-user","阅读原件",[{relativePath:fileId,fileName:"source.md",kind:"text",sizeBytes:5}]);
 const request=JSON.parse(app.calls.find(call=>call.path.endsWith("/branch")).body);assert.equal(request.action,"regenerate");assert.equal("content" in request,false);
 const run=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);
 assert.deepEqual(run.content,[{type:"text",text:"阅读原件"},{type:"file_reference",file_id:fileId}]);assert.equal(app.draft,"新的问题");assert.equal(app.clearCount,0);
 assert.equal(app.composer.pendingUploadedFiles[0].relativePath,draftID);
 assert.deepEqual(app.history.get(fileConversation),original);
});

test("forking an answer anchors its assistant and clones only that prefix without generating",async(t)=>{
 const app=await mount(t,{initialMessages:structuredClone(branchMessages)});await app.fork("source-user");
 const input=JSON.parse(app.calls.find(call=>call.path.endsWith("/branch")).body);
 assert.equal(input.action,"fork");assert.equal(input.message_id,"source-assistant");
 assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);
 assert.deepEqual(app.history.get(branchConversation(1)).map(message=>message.content),["原始问题","原始回复"]);
 assert.equal(app.draft,"新的问题");assert.equal(new URLSearchParams(window.location.search).get("conversation"),branchConversation(1));
});

test("an unknown branch retains one request through offline reconciliation and uses its receipt",async(t)=>{
 const app=await mount(t,{initialMessages:structuredClone(branchMessages),uncertainBranch:true});await app.fork("source-user");
 assert.match(app.host.textContent,/分支结果尚未确认/);assert.equal(app.composer.isInputDisabled,true);
 await app.clickText("核对分支状态");assert.match(app.host.textContent,/分支结果尚未确认/);
 app.branchOnline=true;await app.clickText("核对分支状态");
 const posts=app.calls.filter(call=>call.path.endsWith("/branch")&&call.method==="POST");assert.equal(posts.length,1);
 const request=JSON.parse(posts[0].body);assert.ok(app.calls.some(call=>call.path===`/api/web-chat/branches/${request.client_request_id}`));
 assert.equal(app.branches.size,1);assert.equal(new URLSearchParams(window.location.search).get("conversation"),branchConversation(1));assert.equal(app.draft,"新的问题");
});

test("late branch receipts cannot navigate after a conversation switch or account invalidation",async(t)=>{
 for(const invalidate of [false,true]){
   await t.test(invalidate?"account invalidation":"conversation switch",async(child)=>{
   const app=await mount(child,{initialMessages:structuredClone(branchMessages),delayedBranch:true});await app.fork("source-user");
   assert.equal(app.transcript.onResendFromEdit,undefined,"busy operations disable duplicate callbacks");
   if(invalidate)await app.invalidate();else await app.click(`[data-conversation="${alternateConversation}"]`);
   await app.finishBranch();
   assert.doesNotMatch(window.location.search,/branch-/);assert.doesNotMatch(app.host.textContent,/原始回复/);
   assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);
   });
 }
});

test("conversation chrome removes resource, export and model-parameter entries and controls recent collapse",async(t)=>{
 const app=await mount(t);assert.equal(app.host.querySelector('[aria-label="对话资料与项目"]'),null);
 await app.env.act(async()=>{app.sidebar.onRecentCollapsedChange(true);await tick();});assert.equal(app.sidebar.recentCollapsed,true);
 await app.env.act(async()=>{app.sidebar.onRecentCollapsedChange(false);await tick();});assert.equal(app.sidebar.recentCollapsed,false);
 await app.click('[aria-label="对话选项"]');assert.doesNotMatch(app.host.textContent,/导出 Markdown|导出 JSON|模型参数/);
});

test("project settings open as an overlay without replacing the conversation and retire with the account",async(t)=>{
 const app=await mount(t);const before=app.transcript.rows.map(row=>row.key);const draft=app.draft;
 await app.clickText("项目");assert.ok(app.host.querySelector('[data-project-panel]'));
 assert.equal(typeof app.projectPanel.filesClient.upload,"function");
 assert.deepEqual(app.transcript.rows.map(row=>row.key),before);assert.equal(app.draft,draft);
 assert.equal(app.host.querySelector('[data-cloud-resource-page]'),null);
 const guard=app.projectPanel.captureGuard();guard();await app.invalidate();assert.throws(guard,/Account changed/);
 assert.equal(app.host.querySelector('[data-project-panel]'),null);
});

test("continuing a saved artifact submits only its exact version ID and survives reload with an old-version download",async(t)=>{
 const older=artifactRecord({id:olderArtifactID,number:1,name:"website-v1.html",download_url:`/api/web-chat/artifacts/versions/${olderArtifactID}/download`});
 const app=await mount(t,{fileMode:true,initialArtifacts:[artifactRecord(),older]});
 await app.openArtifact();await app.chooseArtifact(olderArtifactID);await app.clickText("继续修改");
 assert.equal(app.host.querySelector('[data-cloud-resource-inline]'),null);assert.equal(app.draft,"新的问题");assert.equal(app.composer.pendingUploadedFiles[0].fileName,"website-v1.html");assert.match(app.composer.pendingUploadedFiles[0].statusText,/v1/);
 assert.match(app.host.querySelector('[data-pending-attachments]').textContent,/website-v1.html · 已保存 · v1/);assert.equal(app.host.textContent.match(/website-v1.html · 已保存 · v1/g).length,1);assert.doesNotMatch(app.draft,/artifact|444444|555555|workspace/);
 await app.click('[data-action="send"]');
 const input=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);
 assert.deepEqual(input.content,[{type:"text",text:"新的问题"},{type:"artifact_reference",version_id:olderArtifactID}]);
 assert.match(app.host.querySelector('[data-message="created-user"]').textContent,/website-v1.html · v1/);
 await app.emit("created-run","2","message.delta",{delta:`已保存【成果:${olderArtifactID}】`});await app.emit("created-run","3","run.completed");
 await app.reload();assert.match(app.host.querySelector('[data-message="created-user"]').textContent,/website-v1.html · v1/);
 assert.match(app.transcript.rows.find(row=>row.kind==="assistant").rounds[0].blocks[0].text,new RegExp(`cloud-artifacts/${olderArtifactID}`));
 await app.openArtifact(olderArtifactID);assert.match(app.host.querySelector('[data-cloud-resource-inline]').textContent,/v1 · 正式版本已就绪/);
 const downloads=[];const create=URL.createObjectURL,revoke=URL.revokeObjectURL;URL.createObjectURL=()=>"blob:old-artifact";URL.revokeObjectURL=()=>{};t.after(()=>{URL.createObjectURL=create;URL.revokeObjectURL=revoke;});
 app.env.dom.window.HTMLAnchorElement.prototype.click=function(){downloads.push(this.download);};
 await app.clickText("下载此版本");assert.deepEqual(downloads,["website-v1.html"]);
 const download=app.calls.find(call=>call.path===`/api/web-chat/artifacts/versions/${olderArtifactID}/download`);assert.equal(download.headers.Accept,"application/octet-stream");
});

test("unknown artifact versions never become sendable or downloadable references",async(t)=>{
 const app=await mount(t,{fileMode:true,initialArtifacts:[artifactRecord({state:"unknown",download_url:undefined})]});await app.openArtifact();
 assert.match(app.host.querySelector('[data-cloud-resource-inline]').textContent,/保存结果待核对/);
 for(const label of ["继续修改","下载此版本"])assert.equal([...app.host.querySelectorAll("button")].find(button=>button.textContent===label).disabled,true);
 await app.clickText("继续修改");assert.equal(app.composer.pendingUploadedFiles.length,0);assert.equal(app.calls.some(call=>call.path.endsWith("/download")),false);
});

test("an unconfirmed artifact continuation reconciles one immutable request without losing its draft card",async(t)=>{
 const app=await mount(t,{fileMode:true,initialArtifacts:[artifactRecord()]});await app.openArtifact();await app.clickText("继续修改");app.online=false;await app.click('[data-action="send"]');
 assert.match(app.host.textContent,/提交结果尚未确认/);assert.equal(app.composer.pendingUploadedFiles[0].relativePath,`cloud-artifacts/${artifactVersionID}`);assert.equal(app.draft,"新的问题");
 const before=app.calls.filter(call=>call.path==="/api/web-chat/runs"&&call.method==="POST");assert.equal(before.length,2);assert.ok(before.every(call=>call.body===before[0].body));
 app.online=true;await app.clickText("核对提交状态");
 assert.equal(app.runs.size,1);const posts=app.calls.filter(call=>call.path==="/api/web-chat/runs"&&call.method==="POST");assert.equal(posts.length,3);assert.ok(posts.every(call=>call.body===before[0].body));assert.equal(app.composer.pendingUploadedFiles.length,0);
 const request=JSON.parse(before[0].body);assert.deepEqual(request.content,[{type:"text",text:"新的问题"},{type:"artifact_reference",version_id:artifactVersionID}]);
 assert.match(app.host.querySelector('[data-message="created-user"]').textContent,/website.html · v2/);
});

test("late artifact metadata cannot enter a switched conversation or account draft",async(t)=>{
 for(const invalidate of [false,true])await t.test(invalidate?"account":"conversation",async(child)=>{
   const app=await mount(child,{fileMode:true,initialArtifacts:[artifactRecord()],delayedArtifact:true});await app.openArtifact();
   if(invalidate)await app.invalidate();else await app.click(`[data-conversation="${secondFileConversation}"]`);
   await app.finishArtifact();assert.equal(app.host.querySelector('[role="dialog"]'),null);assert.equal(app.composer.pendingUploadedFiles.length,0);assert.doesNotMatch(app.host.textContent,/website.html/);
 });
});

test("editing and regenerating retain source artifact references while preserving a different unsent version",async(t)=>{
 for(const changed of [false,true])await t.test(changed?"edit":"regenerate",async(child)=>{
   const older=artifactRecord({id:olderArtifactID,number:1,name:"original.html",download_url:`/api/web-chat/artifacts/versions/${olderArtifactID}/download`});
   const sourceContent=[{type:"text",text:"修改网页"},{type:"file_reference",file_id:fileId,name:"notes.md",mime:"text/markdown",size:5},artifactSnapshot(older)];
   const messages=[{id:"source-user",role:"user",content:sourceContent},{id:"source-assistant",role:"assistant",content:"原始版本"}];
   const app=await mount(child,{fileMode:true,initialMessages:structuredClone(messages),initialFiles:[fileRecord()],initialArtifacts:[artifactRecord(),older]});
   await app.openArtifact();await app.clickText("继续修改");
   const sourceAttachments=app.transcript.rows.find(row=>row.key==="source-user").attachments;
   await app.edit("source-user",changed?"改成深色网页":"修改网页",sourceAttachments);
   const branch=JSON.parse(app.calls.find(call=>call.path.endsWith("/branch")).body);assert.equal(branch.action,changed?"edit":"regenerate");
   const run=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);
   assert.deepEqual(run.content,[{type:"text",text:changed?"改成深色网页":"修改网页"},{type:"file_reference",file_id:fileId},{type:"artifact_reference",version_id:olderArtifactID}]);
   assert.equal(app.draft,"新的问题");assert.equal(app.clearCount,0);assert.equal(app.composer.pendingUploadedFiles[0].relativePath,`cloud-artifacts/${artifactVersionID}`);
   assert.match(app.host.querySelector('[data-pending-attachments]').textContent,/website.html · 已保存 · v2/);assert.deepEqual(app.history.get(fileConversation),messages);
 });
});

test("files and artifacts share one eight-resource limit and switching views clears pending versions",async(t)=>{
 const originals=Array.from({length:8},(_,index)=>fileRecord({id:`88888888-8888-4888-8888-${String(index+1).padStart(12,"0")}`,name:`file-${index}.md`}));
 const app=await mount(t,{fileMode:true,initialFiles:originals,initialArtifacts:[artifactRecord()]});await app.openArtifact();await app.clickText("继续修改");
 for(const file of originals.slice(0,7)){await app.clickText("文件库");await app.clickText(file.name);await app.clickText("引用到消息");}
 assert.equal(app.composer.pendingUploadedFiles.length,8);await app.paste([new File(["hello"],"ninth.md")]);
 assert.equal(app.calls.some(call=>call.path==="/api/web-chat/files"&&call.method==="POST"),false);assert.match(app.host.textContent,/最多引用 8 个文件或成果/);
 await app.click(`[data-conversation="${secondFileConversation}"]`);assert.equal(app.composer.pendingUploadedFiles.length,0);assert.equal(app.host.querySelector('[data-pending-attachments]').textContent,"");
});

const configuredProvider=(overrides={})=>({id:"key-1",type:"codex",requestFormat:"openai-responses",promptCacheHintMode:"none",models:[{id:"test-model",contextWindow:64000,maxOutputToken:8000,inputModalities:["text","image"],promptCacheHintMode:"auto",...overrides}]});
const modelLimitRecord=(overrides={})=>({provider_key_id:1,model:"test-model",mode:"custom",context_window:64000,max_output_tokens:8000,version:1,updated_at:"2026-10-29T00:00:00Z",...overrides});

test("platform account limits remain inherited without exposing a conversation settings panel",async(t)=>{
 const provider=configuredProvider(),app=await mount(t,{modelSettings:[provider],initialModelLimits:modelLimitRecord({mode:"platform"})});
 await app.click('[data-action="send"]');const request=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);
 assert.equal(request.model_parameters.context_window,undefined);assert.equal(request.model_parameters.max_output_tokens,undefined);assert.equal(provider.models[0].contextWindow,64000);
});

test("saved account limits still apply to new messages after reload",async(t)=>{
 const app=await mount(t,{modelSettings:[configuredProvider()],initialModelLimits:modelLimitRecord({context_window:96000,max_output_tokens:12000})});
 await app.reload();await app.click('[data-action="send"]');const request=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);
 assert.equal(request.model_parameters.context_window,96000);assert.equal(request.model_parameters.max_output_tokens,12000);
});

test("fresh account facts affect a new send while unknown submissions and branch execution keep their original accepted parameters",async(t)=>{
 await t.test("fresh read",async(child)=>{const app=await mount(child,{modelSettings:[configuredProvider()],initialModelLimits:modelLimitRecord()});app.modelLimits=modelLimitRecord({mode:"platform",version:2});await app.click('[data-action="send"]');const input=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.equal(input.model_parameters.context_window,undefined);});
 await t.test("unknown retry",async(child)=>{const app=await mount(child,{modelSettings:[configuredProvider()],initialModelLimits:modelLimitRecord({mode:"platform"})});app.online=false;await app.click('[data-action="send"]');const reads=app.calls.filter(call=>call.path.includes("model-limits")).length;app.modelLimits=modelLimitRecord({mode:"custom",context_window:96000,max_output_tokens:12000,version:2});app.online=true;await app.clickText("核对提交状态");const posts=app.calls.filter(call=>call.path==="/api/web-chat/runs"&&call.method==="POST");assert.ok(posts.length>1);assert.ok(posts.every(call=>call.body===posts[0].body));assert.equal(JSON.parse(posts[0].body).model_parameters.context_window,undefined);assert.equal(app.calls.filter(call=>call.path.includes("model-limits")).length,reads);});
 await t.test("branch",async(child)=>{const app=await mount(child,{modelSettings:[configuredProvider()],initialMessages:structuredClone(branchMessages),initialModelLimits:modelLimitRecord({mode:"platform"}),delayedBranch:true});await app.edit("source-user","修改问题");app.modelLimits=modelLimitRecord({version:2,context_window:96000,max_output_tokens:12000});await app.finishBranch();const request=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.equal(request.model_parameters.context_window,undefined);assert.equal(request.model_parameters.max_output_tokens,undefined);});
});


test("late account preference reads cannot submit or install controls in another account or view",async(t)=>{
 for(const retire of ["view","account"])await t.test(retire,async(child)=>{const app=await mount(child,{modelSettings:[configuredProvider()],delayedModelLimits:true});await app.click('[data-action="send"]');assert.equal(app.composer.isInputDisabled,true);if(retire==="view")await app.click(`[data-conversation="${alternateConversation}"]`);else await app.invalidate();await app.finishModelLimits();assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);assert.doesNotMatch(app.host.textContent,/当前会话已切换/);});
});
test("ordinary sends apply configured model parameters and every reasoning level without changing the device request format",async(t)=>{
 const provider=configuredProvider();const app=await mount(t,{modelSettings:[provider],initialReasoning:"max"});
 assert.deepEqual(app.composer.reasoningOptions,["off","minimal","low","medium","high","xhigh","max"]);await app.click('[data-action="send"]');
 const request=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);
 assert.equal(request.reasoning_effort,"max");assert.deepEqual(request.model_parameters,{request_format:"openai-completions",context_window:64000,max_output_tokens:8000,input_modalities:["text","image"],provider_cache_mode:"none",model_cache_mode:"auto",time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:navigator.language});assert.equal(request.model_parameters.now,undefined);
 assert.equal(provider.requestFormat,"openai-responses");
});
test("unknown submissions and delayed branches freeze the model parameter snapshot taken at the user's action",async(t)=>{
 await t.test("unknown run",async(child)=>{
   const app=await mount(child,{modelSettings:[configuredProvider()],initialReasoning:"none"});app.online=false;await app.click('[data-action="send"]');
   await app.updateModels([configuredProvider({contextWindow:128000,maxOutputToken:16000,inputModalities:["text"]})]);app.online=true;await app.clickText("核对提交状态");
   const posts=app.calls.filter(call=>call.path==="/api/web-chat/runs"&&call.method==="POST");assert.ok(posts.every(call=>call.body===posts[0].body));const request=JSON.parse(posts[0].body);assert.equal(request.model_parameters.context_window,64000);assert.equal(request.reasoning_effort,"none");
 });
 await t.test("delayed branch",async(child)=>{
   const app=await mount(child,{modelSettings:[configuredProvider()],initialMessages:structuredClone(branchMessages),delayedBranch:true});await app.edit("source-user","改写");
   await app.updateModels([configuredProvider({contextWindow:128000,maxOutputToken:16000})]);await app.finishBranch();
   const request=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.equal(request.model_parameters.context_window,64000);assert.equal(request.model_parameters.max_output_tokens,8000);
 });
});
test("unsupported effective cache and explicit text-only image settings are explained before a model request",async(t)=>{
 await t.test("cache",async(child)=>{const app=await mount(child,{modelSettings:[configuredProvider({promptCacheHintMode:"openai-key"})]});await app.click('[data-action="send"]');assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);assert.match(app.host.textContent,/不支持的手动缓存提示/);});
 await t.test("image",async(child)=>{
   const app=await mount(child,{fileMode:true,initialFiles:[fileRecord({name:"photo.png",mime:"image/png",state:"vision_ready",text_bytes:0})],modelSettings:[configuredProvider({inputModalities:["text"]})]});await app.clickText("文件库");await app.clickText("photo.png");await app.clickText("引用到消息");await app.click('[data-action="send"]');
   assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);assert.match(app.host.textContent,/仅文本输入/);
 });
});
test("a workspace-loadable original is attached without treating an unparsed or large source as extracted text",async(t)=>{
 const app=await mount(t,{fileMode:true,initialFiles:[fileRecord({name:"large.csv",mime:"text/csv",size:2*1024*1024,state:"ready",text_bytes:600000,workspace_loadable:true})]});await app.clickText("文件库");await app.clickText("large.csv");
 assert.equal(app.calls.some(call=>call.path.includes("/content?")),false);await app.clickText("文件信息");assert.match(app.host.textContent,/CSV 文件/);assert.doesNotMatch(app.host.querySelector('[data-cloud-resource-inline]').textContent,/AI 使用|状态/);await app.clickText("引用到消息");assert.match(app.host.textContent,/原件可在隔离沙箱读取/);await app.click('[data-action="send"]');
 const request=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.deepEqual(request.content,[{type:"text",text:"新的问题"},{type:"file_reference",file_id:fileId}]);
});

test("a ZIP file is offered by the chooser and sent only as a canonical workspace-only reference",async(t)=>{
 const app=await mount(t,{fileMode:true,initialFiles:[fileRecord({name:"project.zip",mime:"application/zip",state:"uploaded",processing_stage:"workspace_only",text_bytes:0,workspace_loadable:true})]});
 assert.match(app.host.querySelector('input[type="file"]').accept,/\.zip/);await app.clickText("文件库");await app.clickText("project.zip");
 await app.clickText("文件信息");assert.match(app.host.textContent,/ZIP 文件/);assert.equal(app.files.get(fileId).workspace_loadable,true);assert.equal(app.calls.some(call=>call.path.includes("/content?")),false);
 await app.clickText("引用到消息");await app.click('[data-action="send"]');const request=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.deepEqual(request.content,[{type:"text",text:"新的问题"},{type:"file_reference",file_id:fileId}]);
});
test("the single pending artifact card opens its exact version and removes only its draft reference",async(t)=>{
 const app=await mount(t,{fileMode:true,initialArtifacts:[artifactRecord()]});await app.openArtifact();await app.clickText("继续修改");assert.equal(app.host.textContent.match(/website.html · 已保存 · v2/g).length,1);
 await app.clickText("website.html · 已保存 · v2");assert.ok(app.host.querySelector('[data-cloud-resource-inline]'));await app.click('[aria-label="关闭成果库"]');await app.click('[aria-label="移除 website.html"]');assert.equal(app.composer.pendingUploadedFiles.length,0);assert.equal(app.artifacts.size,1);assert.equal(app.calls.some(call=>call.method==="DELETE"),false);
});

test("a full account queue preserves the draft and both attachment kinds until an explicit same-request retry succeeds",async(t)=>{
 const app=await mount(t,{fileMode:true,queueFull:true,initialFiles:[fileRecord()],initialArtifacts:[artifactRecord()],modelSettings:[configuredProvider()]});
 await app.clickText("文件库");await app.clickText("notes.md");await app.clickText("引用到消息");await app.openArtifact();await app.clickText("继续修改");
 const lookups=app.calls.filter(call=>call.path.startsWith("/api/web-chat/runs?")).length;
 await app.click('[data-action="send"]');
 assert.equal(app.calls.filter(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").length,1);assert.equal(app.calls.filter(call=>call.path.startsWith("/api/web-chat/runs?")).length,lookups);
 assert.match(app.host.textContent,/账户队列已满.*尚未受理.*草稿和附件已保留/);assert.doesNotMatch(app.host.textContent,/提交结果尚未确认/);
 assert.equal(app.draft,"新的问题");assert.equal(app.clearCount,0);assert.equal(app.composer.pendingUploadedFiles.length,2);assert.equal(app.composer.isSending,false);assert.equal(app.composer.isInputDisabled,true);assert.equal(app.runs.size,0);assert.equal(app.host.querySelectorAll('[data-message]').length,1,"unaccepted optimistic rows must not masquerade as history");
 await app.clickText("重试提交");assert.equal(app.calls.filter(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").length,2);assert.equal(app.runs.size,0);
 await app.updateModels([configuredProvider({contextWindow:128000})]);app.queueFull=false;await app.clickText("重试提交");
 const posts=app.calls.filter(call=>call.path==="/api/web-chat/runs"&&call.method==="POST");assert.equal(posts.length,3);assert.ok(posts.every(call=>call.body===posts[0].body));assert.equal(app.runs.size,1);assert.equal(app.clearCount,1);assert.equal(app.composer.pendingUploadedFiles.length,0);assert.doesNotMatch(app.host.textContent,/账户队列已满/);
 assert.match(app.host.querySelector('[data-message="created-user"]').textContent,/notes.md.*website.html · v2/);assert.equal(app.host.querySelectorAll('[data-message="created-user"]').length,1);
});

test("returning from a known unaccepted queue rejection permits deliberate draft editing without deleting originals",async(t)=>{
 const app=await mount(t,{fileMode:true,queueFull:true,initialArtifacts:[artifactRecord()]});await app.openArtifact();await app.clickText("继续修改");await app.click('[data-action="send"]');
 const first=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);await app.clickText("返回编辑");assert.equal(app.composer.isInputDisabled,false);assert.equal(app.composer.pendingUploadedFiles.length,1);assert.equal(app.draft,"新的问题");assert.equal(app.calls.some(call=>call.method==="DELETE"),false);
 app.draft="重新编辑的问题";app.queueFull=false;await app.click('[data-action="send"]');const last=JSON.parse(app.calls.findLast(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.notEqual(last.client_request_id,first.client_request_id);assert.equal(last.content[0].text,"重新编辑的问题");assert.equal(app.runs.size,1);
});

test("a branch queue rejection retains the independent draft when its unaccepted generation is cancelled",async(t)=>{
 const app=await mount(t,{fileMode:true,queueFull:true,initialMessages:structuredClone(branchMessages),initialArtifacts:[artifactRecord()]});await app.openArtifact();await app.clickText("继续修改");await app.edit("source-user","修改后的源问题");
 assert.match(app.host.textContent,/账户队列已满/);assert.equal(app.runs.size,0);assert.equal(app.draft,"新的问题");assert.equal(app.composer.pendingUploadedFiles[0].relativePath,`cloud-artifacts/${artifactVersionID}`);await app.clickText("取消本次生成");assert.equal(app.composer.isInputDisabled,false);assert.equal(app.draft,"新的问题");assert.equal(app.composer.pendingUploadedFiles.length,1);assert.deepEqual(app.history.get(fileConversation),branchMessages);
});

test("an accepted unknown request is recovered by its identity even if the account queue becomes full later",async(t)=>{
 const app=await mount(t);app.online=false;await app.click('[data-action="send"]');assert.match(app.host.textContent,/提交结果尚未确认/);assert.equal(app.runs.size,1);app.queueFull=true;app.online=true;await app.clickText("核对提交状态");assert.equal(app.runs.size,1);assert.equal(app.clearCount,1);assert.doesNotMatch(app.host.textContent,/账户队列已满|提交结果尚未确认/);
});

test("a delayed full-queue response cannot install a retry action after a view or account switch",async(t)=>{
 for(const invalidate of [false,true])await t.test(invalidate?"account":"view",async(child)=>{
   const app=await mount(child,{queueFull:true,delayedQueueFull:true});await app.click('[data-action="send"]');if(invalidate)await app.invalidate();else await app.click(`[data-conversation="${alternateConversation}"]`);await app.finishQueueFull();assert.doesNotMatch(app.host.textContent,/账户队列已满|重试提交|返回编辑/);assert.equal(app.composer.pendingUploadedFiles.length,0);assert.equal(app.runs.size,0);assert.equal(app.calls.some(call=>call.path.endsWith("/cancel")),false);
 });
});

const manyHistory=()=>Array.from({length:120},(_,index)=>({id:`history-${index}`,role:index%2?"assistant":"user",content:`历史消息 ${index}`}));
test("a failed initial history read offers an explicit same-conversation retry without losing the saved draft or creating work",async(t)=>{
 const rich=richComposerDraft();
 const app=await mount(t,{initialHistoryFailure:true,initialDraftText:"",initialSavedDrafts:[{scope:defaultConversation,draft:{version:1,draft:{composer:rich,files:[],artifacts:[],presentation:"work",researchEnabled:false},modelSelection:{model:"test-model",providerKeyId:1,reasoningEffort:"medium"}}}]});
 const historyReads=()=>app.calls.filter(call=>new URL(call.path,"http://localhost").pathname===`/api/web-chat/conversations/${defaultConversation}/messages`);
 const metadataReads=()=>app.calls.filter(call=>call.path===`/api/web-chat/conversations/${defaultConversation}/metadata`);
 const workWrites=()=>app.calls.filter(call=>call.method==="POST"&&["/api/web-chat/conversations","/api/web-chat/runs"].includes(call.path));
 assert.equal(historyReads().length,1);assert.match(app.host.textContent,/暂时无法读取对话消息/);
 assert.equal(app.transcript.rows.length,0);assert.equal(app.composer.isInputDisabled,true);
 assert.equal(app.host.querySelector('[data-action="send"]').disabled,true);assert.equal(app.host.querySelector('.cloud-mode-switch'),null,"failed history must not appear to be a new blank conversation");
 assert.equal(app.host.querySelector('[data-layout="landing"]'),null);assert.deepEqual(app.structuredDraft,rich);
 await app.click('[data-action="send"]');assert.deepEqual(workWrites(),[]);
 const metadataBefore=metadataReads().length;
 app.failInitialHistory=false;await app.clickText("重试加载历史");
 assert.equal(historyReads().length,2);assert.equal(metadataReads().length,metadataBefore+1);
 assert.equal(app.composer.isInputDisabled,false);assert.deepEqual(app.structuredDraft,rich);
 assert.equal(app.transcript.rows[0].key,"user-a");assert.match(app.host.querySelector('[data-transcript]').textContent,/原问题/);
 assert.equal(new URL(window.location.href).searchParams.get("conversation"),defaultConversation);
 assert.doesNotMatch(app.host.textContent,/暂时无法读取对话消息|重试加载历史/);
 assert.deepEqual(workWrites(),[]);assert.equal(app.clearCount,0);assert.equal(app.runs.size,0);
});

test("loading earlier pages preserves active output, canonical refs and the composer draft through terminal refresh",async(t)=>{
 const history=manyHistory();const app=await mount(t,{initialMessages:history,initialRun:snapshot({user_message_id:"history-118",assistant_message_id:"active-assistant",output:"进行中的内容"})});
 assert.equal(app.transcript.rows.length,51);assert.equal(app.transcript.rows[0].key,"history-70");assert.equal(app.composer.isSending,true);const stream=app.streams[0];
 app.failHistory=true;await app.clickText("加载更早历史");assert.match(app.host.textContent,/暂时无法读取对话消息/);assert.equal(app.transcript.rows.length,51);
 app.failHistory=false;await app.clickText("加载更早历史");assert.equal(app.transcript.rows[0].key,"history-20");assert.equal(app.transcript.rows.length,101);assert.equal(stream.closed,false);assert.equal(app.draft,"新的问题");assert.equal(app.transcript.viewportFollowing,false);assert.equal(app.transcript.isViewportFollowing(),false);
 await app.clickText("加载更早历史");assert.equal(app.transcript.rows[0].key,"history-0");assert.equal(app.transcript.rows.length,121);assert.doesNotMatch(app.host.textContent,/加载更早历史/);
 const ref=app.transcript.rows.find(row=>row.key==="history-0").messageRef;assert.equal(ref,undefined,"editing is still disabled while the run is active");
 await app.emit("run-a","2","run.completed");assert.equal(app.transcript.rows.length,121);assert.equal(app.transcript.rows[0].key,"history-0");assert.equal(new Set(app.transcript.rows.map(row=>row.key)).size,121);assert.equal(app.transcript.rows[0].messageRef.messageId,"history-0");assert.equal(app.draft,"新的问题");
});

test("omitted messages keep their identity and require an explicit safe body read before editing",async(t)=>{
 const head={id:"large-user",role:"user",content:null,content_omitted:true,content_bytes:2200000,content_sha256:"a".repeat(64)};
 const original=[{type:"text",text:"完整原问题 <script>not executable</script>"},{type:"file_reference",file_id:fileId,name:"notes.md",mime:"text/markdown",size:5},artifactSnapshot(artifactRecord())];
 const app=await mount(t,{fileMode:true,initialMessages:[head,{id:"answer",role:"assistant",content:"回复"}],initialFiles:[fileRecord()],initialArtifacts:[artifactRecord()],fullMessages:[{...head,content:original,content_omitted:false}]});
 const row=app.transcript.rows.find(row=>row.key==="large-user");assert.equal(row.contentOmitted,true);assert.equal(row.messageRef.messageId,"large-user");assert.match(row.text,/按需加载/);assert.equal(app.calls.some(call=>call.path.includes("/messages/large-user")),false);
 await app.openMessage("large-user");assert.match(app.host.querySelector('[role="dialog"] pre').textContent,/完整原问题/);assert.equal(app.host.querySelector('[role="dialog"] script'),null);assert.equal(app.transcript.rows.find(row=>row.key==="large-user").contentOmitted,false);assert.equal(app.draft,"新的问题");
 await app.clickText("关闭消息原文");const full=app.transcript.rows.find(row=>row.key==="large-user");await app.edit("large-user",full.text,full.attachments);
 assert.equal(JSON.parse(app.calls.find(call=>call.path.endsWith("/branch")).body).action,"regenerate");const input=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.deepEqual(input.content,[{type:"text",text:"完整原问题 <script>not executable</script>"},{type:"file_reference",file_id:fileId},{type:"artifact_reference",version_id:artifactVersionID}]);
});

test("an omitted answer is an explicit body link and a hard-limit response is never presented as an empty answer",async(t)=>{
 const app=await mount(t,{initialMessages:[{id:"user",role:"user",content:"问题"},{id:"huge-answer",role:"assistant",content:null,content_omitted:true,content_bytes:40*1024*1024,content_sha256:"a".repeat(64)}],messageStatus:413});
 assert.match(app.transcript.rows.find(row=>row.key==="huge-answer").rounds[0].blocks[0].text,/cloud-messages\/huge-answer/);await app.openMessage("huge-answer");assert.match(app.host.querySelector('[role="dialog"]').textContent,/超过单条查看上限/);assert.equal(app.host.querySelector('[role="dialog"] pre'),null);assert.equal(app.transcript.rows.find(row=>row.key==="huge-answer").contentOmitted,true);
});

test("late earlier pages and body reads cannot repopulate another view or account",async(t)=>{
 for(const kind of ["page","body"])for(const invalidate of [false,true])await t.test(`${kind}-${invalidate?"account":"view"}`,async(child)=>{
   const messages=kind==="page"?manyHistory():[{id:"private-message",role:"user",content:null,content_omitted:true,content_bytes:100,content_sha256:"a".repeat(64)}];
   const app=await mount(child,{initialMessages:messages,delayedHistory:kind==="page",delayedMessage:kind==="body",fullMessages:[{id:"private-message",role:"user",content:"私有原文",content_sha256:"a".repeat(64)}]});
   if(kind==="page")await app.clickText("加载更早历史");else await app.openMessage("private-message");
   if(invalidate)await app.invalidate();else await app.click(`[data-conversation="${alternateConversation}"]`);
   if(kind==="page")await app.finishHistory();else await app.finishMessage();
   assert.equal(app.host.querySelector('[role="dialog"]'),null);assert.doesNotMatch(app.host.textContent,/私有原文|历史消息|加载更早历史/);
 });
});

test("history lookup progress stays in the same persisted Run while the browser only displays its status",async(t)=>{
 const app=await mount(t,{initialRun:snapshot({active_tools:[{tool_id:"history-op",name:"read_history",state:"executing",status:"正在查阅当前会话历史"}]})});assert.equal(app.transcript.toolStatus,"正在查阅当前会话历史");assert.equal(app.composer.isSending,true);assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);
});

test("a real 2 MiB body stays bounded in transcript and reader DOM, downloads intact and preserves canonical regeneration", async(t)=>{
 const text="BEGIN_CLOUDCHAT_SYNTHETIC_LARGE_HISTORY\n"+"0123456789ABCDEFGHIJ\n".repeat(110000)+"END_CLOUDCHAT_SYNTHETIC_LARGE_HISTORY";
 const content=[{type:"text",text},{type:"file_reference",file_id:fileId,name:"notes.md",mime:"text/markdown",size:5},artifactSnapshot(artifactRecord())];
 const bytes=Buffer.from(JSON.stringify(content)),sha=createHash("sha256").update(bytes).digest("hex");
 const head={id:"large-user",role:"user",content:null,content_omitted:true,content_bytes:bytes.length,content_sha256:sha};
 const app=await mount(t,{fileMode:true,initialMessages:[head],initialFiles:[fileRecord()],initialArtifacts:[artifactRecord()],fullMessages:[{...head,content,content_omitted:false}],initialRun:snapshot({conversation_id:fileConversation,user_message_id:"large-user",assistant_message_id:"active-assistant",output:"正在继续回复"})});
 app.draft="保留未发送草稿";await app.paste([new File(["hello"],"notes.md",{type:"text/markdown"})]);
 const stream=app.streams[0],pending=app.composer.pendingUploadedFiles.map(file=>file.relativePath);
 await app.openMessage("large-user");
 assert.ok(app.host.textContent.length<16000,"opening a complete 2 MiB record must not insert that whole body into the DOM");
 assert.ok(app.host.querySelector('[role="dialog"] pre').textContent.length<=8192);assert.match(app.host.textContent,/当前片段不代表完整正文/);
 const row=app.transcript.rows.find(row=>row.key==="large-user");assert.equal(row.contentOmitted,false);assert.equal(row.contentPreview,true);assert.equal(row.retryText,text);assert.ok(row.text.length<4300);assert.equal(row.attachments.length,2);
 await app.clickText("末段");assert.match(app.host.querySelector('[role="dialog"] pre').textContent,/END_CLOUDCHAT_SYNTHETIC_LARGE_HISTORY$/);assert.ok(app.host.textContent.length<16000);
 const createURL=URL.createObjectURL,revokeURL=URL.revokeObjectURL,digest=crypto.subtle.digest,blobs=[],downloads=[],revoked=[];let digestPromise;
 crypto.subtle.digest=function(...args){digestPromise=digest.apply(this,args);return digestPromise;};
 URL.createObjectURL=blob=>{blobs.push(blob);return "blob:complete-message";};URL.revokeObjectURL=url=>revoked.push(url);
 app.env.dom.window.HTMLAnchorElement.prototype.click=function(){downloads.push({name:this.download,href:this.href});};
 t.after(()=>{URL.createObjectURL=createURL;URL.revokeObjectURL=revokeURL;crypto.subtle.digest=digest;});
 await app.clickText("下载完整正文（TXT）");await app.env.act(async()=>{await digestPromise;await tick();});
 assert.equal(downloads.length,1);assert.equal(downloads[0].name,"消息完整正文.txt");const downloaded=Buffer.from(await blobs[0].arrayBuffer());assert.equal(downloaded.toString("utf8"),text);const textSHA=createHash("sha256").update(Buffer.from(text)).digest("hex");assert.equal(createHash("sha256").update(downloaded).digest("hex"),textSHA);assert.match(app.host.textContent,new RegExp(textSHA));assert.deepEqual(revoked,["blob:complete-message"]);
 await app.clickText("关闭消息原文");assert.ok(app.host.textContent.length<7000,"closing the reader must leave only the labelled transcript preview");assert.doesNotMatch(app.host.textContent,/END_CLOUDCHAT_SYNTHETIC_LARGE_HISTORY/);assert.equal(app.draft,"保留未发送草稿");assert.deepEqual(app.composer.pendingUploadedFiles.map(file=>file.relativePath),pending);assert.equal(stream.closed,false);assert.equal(app.composer.isSending,true);
 const reads=app.calls.filter(call=>call.path.endsWith("/messages/large-user")).length;await app.openMessage("large-user");assert.equal(app.calls.filter(call=>call.path.endsWith("/messages/large-user")).length,reads,"cached canonical body should reopen without refetching 2 MiB");assert.ok(app.host.textContent.length<16000);await app.clickText("关闭消息原文");
 await app.emit("run-a","2","run.completed");assert.equal(app.transcript.rows.find(row=>row.key==="large-user").retryText,text,"terminal page omission must not replace the cached complete body");
 const canonical=app.transcript.rows.find(row=>row.key==="large-user");await app.edit("large-user",canonical.retryText,canonical.attachments);
 const branch=JSON.parse(app.calls.find(call=>call.path.endsWith("/branch")).body);assert.equal(branch.action,"regenerate");
 const submission=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.deepEqual(submission.content,[{type:"text",text},{type:"file_reference",file_id:fileId},{type:"artifact_reference",version_id:artifactVersionID}]);assert.equal(createHash("sha256").update(Buffer.from(submission.content[0].text)).digest("hex"),textSHA);assert.equal(app.draft,"保留未发送草稿");assert.ok(app.host.textContent.length<15000);
});

test("a retired account cannot publish a complete-body Blob while its digest is pending", async(t)=>{
 const text="PRIVATE_BEGIN\n"+"private body\n".repeat(180000)+"PRIVATE_END";
 const head={id:"private-big",role:"user",content:null,content_omitted:true,content_bytes:Buffer.byteLength(JSON.stringify(text)),content_sha256:"a".repeat(64)};
 const app=await mount(t,{initialMessages:[head],fullMessages:[{...head,content:text,content_omitted:false}]});await app.openMessage(head.id);
 const digest=crypto.subtle.digest,createURL=URL.createObjectURL;let finish,created=0;
 crypto.subtle.digest=()=>new Promise(resolve=>{finish=resolve;});URL.createObjectURL=()=>{created++;return "blob:retired-message";};
 t.after(()=>{crypto.subtle.digest=digest;URL.createObjectURL=createURL;});
 await app.clickText("下载完整正文（TXT）");assert.equal(typeof finish,"function");await app.invalidate();await app.env.act(async()=>{finish(new Uint8Array(32).buffer);await tick();});assert.equal(created,0);assert.equal(app.host.querySelector('[role="dialog"]'),null);assert.doesNotMatch(app.host.textContent,/PRIVATE_BEGIN|PRIVATE_END|private body/);
});

test("an 8k report previews briefly but copies and edits the complete canonical text with references",async(t)=>{
 const text="中".repeat(8192)+"END_8K",content=[{type:"text",text},{type:"file_reference",file_id:fileId,name:"notes.md",mime:"text/markdown",size:5},artifactSnapshot(artifactRecord())];
 const app=await mount(t,{fileMode:true,initialMessages:[{id:"report",role:"user",content}],initialFiles:[fileRecord()],initialArtifacts:[artifactRecord()]});
 const copied=[];Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{copied.push(text);}}});
 const row=app.transcript.rows.find(row=>row.key==="report");assert.equal(row.contentPreview,true);assert.equal(row.inlineEditText,text);assert.equal(typeof row.copyContent,"function");assert.ok(app.host.textContent.length<5000);
 await app.env.act(async()=>{assert.equal(await row.copyContent(),true);});assert.deepEqual(copied,[text]);assert.equal(app.host.querySelector("textarea"),null,"private clipboard path must not use a textarea fallback");
 await app.openMessage("report");await app.clickText("复制完整正文");assert.deepEqual(copied,[text,text]);assert.ok(app.host.textContent.length<14000);await app.clickText("关闭消息原文");
 await app.edit("report",row.inlineEditText+"修订",row.attachments);const branch=JSON.parse(app.calls.find(call=>call.path.endsWith("/branch")).body);assert.equal(branch.action,"edit");const input=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.deepEqual(input.content,[{type:"text",text:text+"修订"},{type:"file_reference",file_id:fileId},{type:"artifact_reference",version_id:artifactVersionID}]);assert.equal(app.draft,"新的问题");
 await app.env.act(async()=>{assert.equal(await row.copyContent(),false);});assert.equal(copied.length,2,"a stale row must not copy its old conversation text after branch navigation");
});

test("Cloud work starters append to the existing draft without creating a paid Run or enabling research",async(t)=>{
 const app=await mount(t,{initialMessages:[]});assert.match(app.host.textContent,/我们要做什么/);const originalDraft=app.draft;
 for(const [label,prompt]of [["研究一个问题","研究一个问题"],["分析表格与数据","分析表格与数据"],["撰写或完善文档","撰写或完善"]]){const starter=[...app.host.querySelectorAll("button.conversation-starter")].find(node=>node.querySelector(".conversation-starter-title").textContent===label);assert.ok(starter);await app.env.act(async()=>{starter.click();await tick();});assert.ok(app.draft.includes(prompt));assert.ok(app.draft.startsWith(originalDraft));}
 assert.equal(app.composer.chatRuntimeControls.nativeWebSearchEnabled,false);
 assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);
 const editor=app.host.querySelector("footer");const clearBefore=app.clearCount;
 await app.clickText("对话");assert.equal(app.host.querySelector("footer"),editor);assert.equal(app.clearCount,clearBefore);assert.ok(app.draft.includes("撰写或完善"));assert.match(app.host.textContent,/今天有什么安排/);
 await app.clickText("工作");assert.equal(app.host.querySelector("footer"),editor);assert.ok(app.draft.includes("撰写或完善"));
});

test("the actual model controls off callback persists none across reload and later high selection",async(t)=>{
 const app=await mount(t,{realModelControls:true});await app.showReasoning();
 await app.effort("off");
 assert.equal(app.composer.chatRuntimeControls.reasoning,"off");assert.equal(app.composer.chatRuntimeControls.thinkingEnabled,false);
 const saved=app.calls.filter(call=>call.path==="/api/web-settings"&&call.method==="PATCH");assert.equal(JSON.parse(saved.at(-1).body).reasoning_effort,"none");
 await app.reload();assert.equal(app.composer.chatRuntimeControls.reasoning,"off");assert.equal(app.composer.chatRuntimeControls.thinkingEnabled,false);
 await app.click('[data-action="send"]');let input=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.equal(input.reasoning_effort,"none");await app.emit("created-run","2","run.completed");
 await app.showReasoning();await app.effort("high");assert.equal(app.composer.chatRuntimeControls.thinkingEnabled,true);assert.equal(JSON.parse(app.calls.filter(call=>call.path==="/api/web-settings"&&call.method==="PATCH").at(-1).body).reasoning_effort,"high");await app.reload();assert.equal(app.composer.chatRuntimeControls.reasoning,"high");assert.equal(app.composer.chatRuntimeControls.thinkingEnabled,true);
});

test("the existing network switch defaults off and authorizes exactly one visible public topic per send",async(t)=>{
 const app=await mount(t,{realModelControls:true});assert.deepEqual(app.composer.capabilities,{executionControls:false,gitControls:false,workspaceFolders:false});assert.equal(app.host.querySelector('[role="switch"]'),null,"CloudChat does not expose device execution controls");assert.equal(app.composer.chatRuntimeControls.nativeWebSearchEnabled,false);await app.env.act(async()=>{app.composer.capabilityMenu.props.onToggleResearch();await tick();});
 await app.click('[data-action="send"]');assert.match(app.host.querySelector('[role="dialog"]').textContent,/确认公开检索主题/);assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);assert.equal(app.draft,"新的问题");
 await app.clickText("取消联网发送");assert.equal(app.host.querySelector('[role="dialog"]'),null);assert.equal(app.runs.size,0);app.draft="新的公开问题";
 await app.click('[data-action="send"]');assert.equal(app.host.querySelector('textarea[aria-label="可用于公开检索的主题"]').value,"新的公开问题");await app.setResearchTopic("公开主题：行业报告");app.draft="关闭窗口前出现的私有草稿";await app.clickText("确认公开主题并继续");
 const input=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.equal(input.content,"新的公开问题");assert.deepEqual(input.public_research,{topic:"公开主题：行业报告"});assert.equal(input.model_parameters.nativeWebSearchEnabled,undefined);
});

test("public topic approval remains frozen during lost-receipt reconciliation and never borrows the next draft",async(t)=>{
 const app=await mount(t);await app.env.act(async()=>app.composer.onChatRuntimeControlsChange({nativeWebSearchEnabled:true}));await app.click('[data-action="send"]');await app.setResearchTopic("approved topic");app.online=false;await app.clickText("确认公开主题并继续");assert.match(app.host.textContent,/提交结果尚未确认/);app.draft="private changed later";app.online=true;await app.clickText("核对提交状态");const posts=app.calls.filter(call=>call.path==="/api/web-chat/runs"&&call.method==="POST");assert.ok(posts.length>=2);assert.ok(posts.every(call=>call.body===posts[0].body));assert.deepEqual(JSON.parse(posts[0].body).public_research,{topic:"approved topic"});assert.equal(app.host.querySelector('[role="dialog"]'),null);
});

test("editing or regenerating confirms a fresh public topic before creating a branch and preserves the independent draft",async(t)=>{
 for(const action of ["edit","regenerate"])await t.test(action,async(child)=>{
  const app=await mount(child,{initialMessages:[{id:"original",role:"user",content:"old public question"},{id:"answer",role:"assistant",content:"old answer"}]});app.draft="independent private draft";await app.env.act(async()=>app.composer.onChatRuntimeControlsChange({nativeWebSearchEnabled:true}));
  await app.edit("original",action==="edit"?"new edited question":"old public question");assert.equal(app.calls.some(call=>call.path.endsWith("/branch")),false);assert.equal(app.host.querySelector('textarea[aria-label="可用于公开检索的主题"]').value,action==="edit"?"new edited question":"old public question");await app.setResearchTopic("explicit new topic");await app.clickText("确认公开主题并继续");const input=JSON.parse(app.calls.find(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").body);assert.deepEqual(input.public_research,{topic:"explicit new topic"});assert.equal(app.draft,"independent private draft");assert.equal(JSON.parse(app.calls.find(call=>call.path.endsWith("/branch")).body).action,action);
 });
});

test("a public-topic confirmation cannot survive an account or conversation switch",async(t)=>{
 for(const invalidation of ["account","conversation"])await t.test(invalidation,async(child)=>{const app=await mount(child);await app.env.act(async()=>app.composer.onChatRuntimeControlsChange({nativeWebSearchEnabled:true}));await app.click('[data-action="send"]');const retired=[...app.host.querySelectorAll("button")].find(node=>node.textContent==="确认公开主题并继续");if(invalidation==="account")await app.invalidate();else await app.click(`[data-conversation="${alternateConversation}"]`);await app.env.act(async()=>{retired.click();await tick();});assert.equal(app.host.querySelector('[role="dialog"]'),null);assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);});
});

test("a multi-megabyte private draft is never copied into a public-topic textarea",async(t)=>{
 const app=await mount(t);app.draft="PRIVATE_"+"x".repeat(2*1024*1024);await app.env.act(async()=>app.composer.onChatRuntimeControlsChange({nativeWebSearchEnabled:true}));await app.click('[data-action="send"]');assert.equal(app.host.querySelector('textarea[aria-label="可用于公开检索的主题"]').value,"");assert.ok(app.host.textContent.length<2000);assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);await app.clickText("取消联网发送");assert.equal(app.draft.length,2*1024*1024+8);
});

test("the capability menu enables research without sending or copying a draft before confirmation",async(t)=>{
 const app=await mount(t,{initialMessages:[],realModelControls:true});assert.equal(app.composer.chatRuntimeControls.nativeWebSearchEnabled,false);
 const before=app.draft;await app.env.act(async()=>{app.composer.capabilityMenu.props.onToggleResearch();await tick();});
 assert.equal(app.draft,before);assert.equal(app.composer.chatRuntimeControls.nativeWebSearchEnabled,true);
 assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);
 await app.click('[data-action="send"]');assert.match(app.host.querySelector('[role="dialog"]').textContent,/确认公开检索主题/);
 assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);
});

const composerProjectRecord=()=>({id:'99999999-9999-4999-8999-999999999999',name:'工作计划',description:'',instructions:'项目指令',version:1,created_at:'2026-10-29T00:00:00Z',updated_at:'2026-10-29T00:00:00Z'});

test('an existing conversation hides the mode switch without affecting its live Run or draft',async t=>{
 const app=await mount(t,{initialRun:snapshot({output:'正在执行'})});const subscription=app.streams[0],editor=app.host.querySelector('footer'),model=app.composer.selectedValue,draft=app.draft;
 assert.equal(app.host.querySelector('.cloud-mode-switch'),null);
 await app.emit('run-a','2','message.delta',{delta:'继续执行'});
 assert.equal(app.host.querySelector('footer'),editor);assert.equal(app.composer.selectedValue,model);assert.equal(app.draft,draft);assert.equal(app.composer.isSending,true);assert.equal(subscription.closed,false);
 assert.equal(app.calls.some(call=>call.path.endsWith('/cancel')||call.path==='/api/web-chat/runs'&&call.method==='POST'),false);
});

test('the mode switch disappears on the first send, stays hidden after completion and returns for a new empty conversation',async t=>{
 const app=await mount(t,{initialMessages:[]});assert.ok(app.host.querySelector('.cloud-mode-switch'));
 await app.clickText('对话');const editor=app.host.querySelector('footer'),model=app.composer.selectedValue;
 assert.equal(app.composer.expandedInput,false);
 await app.click('[data-action="send"]');assert.equal(app.host.querySelector('.cloud-mode-switch'),null);
 assert.equal(app.composer.expandedInput,false);assert.equal(app.composer.selectedValue,model);assert.equal(app.host.querySelector('footer'),editor);
 await app.emit('created-run','2','run.completed');assert.equal(app.host.querySelector('.cloud-mode-switch'),null);
 await app.click(`[data-conversation="${alternateConversation}"]`);assert.equal(app.host.querySelector('.cloud-mode-switch'),null,'reopened history cannot switch modes');
 await app.click('[data-new-conversation]');assert.ok(app.host.querySelector('.cloud-mode-switch'));
 await app.clickText('工作');assert.equal(app.composer.expandedInput,true);
});

test('an unconfirmed first submission does not restore the mode switch',async t=>{
 const app=await mount(t,{initialMessages:[]});assert.ok(app.host.querySelector('.cloud-mode-switch'));app.online=false;
 await app.click('[data-action="send"]');assert.match(app.host.textContent,/提交结果尚未确认/);
 assert.equal(app.host.querySelector('.cloud-mode-switch'),null);
 assert.equal(app.runs.size,1,'receipt recovery must not create another Run');
 const submissions=app.calls.filter(call=>call.path==='/api/web-chat/runs'&&call.method==='POST');
 assert.equal(new Set(submissions.map(call=>JSON.parse(call.body).client_request_id)).size,1);
});

test('CloudChat keeps one account avatar in the desktop or mobile navigation rail without a rail settings button',async t=>{
 for(const mobileLayout of [false,true]) await t.test(mobileLayout?'mobile rail':'desktop rail',async child=>{
  const app=await mount(child,{mobileLayout});
  assert.equal(app.host.querySelectorAll('[data-account-menu]').length,1);
  const rail=app.host.querySelector('.application-rail');
  assert.equal(rail.querySelector('[aria-label="设置"]'),null);
  assert.equal(Boolean(rail.querySelector('[data-account-menu="rail"]')),true);
  assert.equal(Boolean(app.host.querySelector('nav[data-sidebar-loading] .application-rail')),mobileLayout);
  assert.equal(app.host.querySelector('[data-account-menu="sidebar"]'),null);
 });
});

test('new conversation only opens a blank draft and repeated clicks never create sidebar records',async t=>{
 const app=await mount(t);const conversations=app.host.querySelectorAll('[data-conversation]').length,model=app.composer.selectedValue;
 for(let count=0;count<3;count++){
  app.draft='应在新对话中清空的草稿';
  await app.click('[data-new-conversation]');
  assert.equal(app.draft,'');assert.equal(app.transcript.rows.length,0);assert.ok(app.host.querySelector('.cloud-mode-switch'));
  assert.equal(new URLSearchParams(window.location.search).has('conversation'),false);
  assert.equal(app.host.querySelectorAll('[data-conversation]').length,conversations);
 }
 assert.equal(app.composer.selectedValue,model);
 assert.equal(app.calls.some(call=>call.path==='/api/web-chat/conversations'&&call.method==='POST'),false);
 assert.equal(app.calls.some(call=>call.path==='/api/web-chat/runs'&&call.method==='POST'),false);
 app.draft='首次实际发送的问题';await app.click('[data-action="send"]');
 assert.equal(app.calls.filter(call=>call.path==='/api/web-chat/conversations'&&call.method==='POST').length,1);
 assert.equal(app.calls.filter(call=>call.path==='/api/web-chat/runs'&&call.method==='POST').length,1);
 assert.equal(app.host.querySelectorAll('[data-conversation]').length,conversations+1);
 assert.equal(JSON.parse(app.calls.find(call=>call.path==='/api/web-chat/runs'&&call.method==='POST').body).content,'首次实际发送的问题');
});

test('opening a blank draft detaches the old live Run without cancelling it or creating a conversation',async t=>{
 const app=await mount(t,{initialRun:snapshot({output:'后台正在执行'})});const subscription=app.streams[0];
 await app.click('[data-new-conversation]');
 assert.equal(subscription.closed,true);assert.equal(app.composer.isSending,false);assert.equal(app.transcript.rows.length,0);
 assert.ok(app.host.querySelector('.cloud-mode-switch'));assert.equal(app.runs.get('run-a').state,'running');
 assert.equal(app.calls.some(call=>call.path.endsWith('/cancel')||call.path==='/api/web-chat/conversations'&&call.method==='POST'),false);
});

test('composer project selection uses the server version and preserves the existing draft without starting a Run',async t=>{
 const app=await mount(t,{fileMode:true,initialMessages:[]});const project=composerProjectRecord();app.projectRecords.set(project.id,project);
 const draft=app.draft,model=app.composer.selectedValue;
 await app.env.act(async()=>{await app.contextPicker.onSelectProject(project);await tick();});
 assert.equal(app.projectBindings.get(fileConversation).project_id,project.id);assert.equal(app.projectBindings.get(fileConversation).version,1);
 assert.equal(app.draft,draft);assert.equal(app.composer.selectedValue,model);assert.equal(app.clearCount,0);
 assert.equal(app.calls.some(call=>call.path==='/api/web-chat/runs'&&call.method==='POST'),false);
});

test('choosing a project for a blank draft preserves it without creating a conversation, then binds on first send',async t=>{
 const app=await mount(t,{fileMode:true,initialMessages:[],newDraft:true});const project=composerProjectRecord();app.projectRecords.set(project.id,project);
 const paste={id:'large-one',text:'原始长文本',label:'Pasted text'};
 const rich={text:'草稿与长文本',textWithoutLargePastes:'草稿',segments:[{type:'text',text:'草稿'},{type:'largePaste',paste}],largePastes:[paste],skillMentions:[],appMentions:[],commitMentions:[],gitFileMentions:[],codeMentions:[],isEmpty:false};app.structuredDraft=rich;
 await app.env.act(async()=>{app.contextPicker.onAttach(fileRecord());await tick();});
 await app.env.act(async()=>{await app.contextPicker.onSelectProject(project);await tick();});
 assert.equal(app.contextPicker.selectedProjectId,project.id);assert.deepEqual(app.structuredDraft,rich);
 assert.equal(app.composer.pendingUploadedFiles.length,1);assert.equal(app.composer.pendingUploadedFiles[0].relativePath,fileId);
 assert.equal(app.calls.filter(call=>call.path==='/api/web-chat/conversations'&&call.method==='POST').length,0);
 assert.equal(app.calls.some(call=>call.path==='/api/web-chat/runs'&&call.method==='POST'),false);
 app.files.set(fileId,fileRecord());await app.click('[data-action="send"]');
 const id='88888888-8888-4888-8888-888888888888';
 assert.equal(app.projectBindings.get(id).project_id,project.id);
 assert.equal(app.calls.filter(call=>call.path==='/api/web-chat/conversations'&&call.method==='POST').length,1);
 assert.equal(app.calls.filter(call=>call.path==='/api/web-chat/runs'&&call.method==='POST').length,1);
});

test('pending project selection blocks duplicate changes and sending; late account results cannot update the current page',async t=>{
 const app=await mount(t,{fileMode:true,initialMessages:[]});const project=composerProjectRecord();app.projectRecords.set(project.id,project);app.delayProjectAssociation=true;
 let outcome;
 await app.env.act(async()=>{outcome=app.contextPicker.onSelectProject(project).catch(error=>error);await tick();});
 assert.equal(app.composer.isInputDisabled,true);
 await app.env.act(async()=>{await app.contextPicker.onSelectProject(project);app.composer.onSend();await tick();});
 assert.equal(app.calls.filter(call=>call.path.endsWith('/project')&&call.method==='PUT').length,1);
 assert.equal(app.calls.some(call=>call.path==='/api/web-chat/runs'&&call.method==='POST'),false);
 await app.invalidate();await app.finishProjectAssociation();assert.ok(await outcome instanceof Error);
 assert.doesNotMatch(app.host.textContent,/已选择项目：工作计划/);assert.equal(app.contextPicker.selectedProjectId,undefined);
});

test('project conflicts remain explicit and a fresh user retry uses the new server version',async t=>{
 const app=await mount(t,{fileMode:true,initialMessages:[]});const project=composerProjectRecord();app.projectRecords.set(project.id,project);app.delayProjectAssociation=true;
 let outcome;await app.env.act(async()=>{outcome=app.contextPicker.onSelectProject(project).catch(error=>error);await tick();});
 app.projectBindings.set(fileConversation,{conversation_id:fileConversation,project_id:'',version:2,created_at:''});
 await app.finishProjectAssociation();assert.ok(await outcome instanceof Error);assert.equal(app.projectBindings.get(fileConversation).version,2);
 app.delayProjectAssociation=false;await app.env.act(async()=>{await app.contextPicker.onSelectProject(project);await tick();});
 assert.equal(app.projectBindings.get(fileConversation).version,3);assert.equal(app.projectBindings.get(fileConversation).project_id,project.id);
});

test("a stream limit explains how to recover while the accepted Run keeps running without resubmission",async(t)=>{
 const app=await mount(t,{initialRun:snapshot({output:"已接受的内容"}),streamLimit:true});assert.match(app.host.textContent,/打开的实时页面已达上限.*任务会继续运行/);assert.equal(app.composer.isSending,true);assert.doesNotMatch(app.host.textContent,/尚未受理|重试提交/);assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);await app.click(`[data-conversation="${alternateConversation}"]`);assert.doesNotMatch(app.host.textContent,/打开的实时页面/);assert.equal(app.calls.some(call=>call.path.endsWith("/cancel")),false);
});

test('CloudChat settings replaces the workspace in normal flow and preserves the editor, draft and live run',async t=>{
 const app=await mount(t,{initialRun:snapshot({output:'已生成'})});
 app.draft='保留的草稿';
 const editor=app.host.querySelector('footer'),workspace=app.host.querySelector('[data-cloud-conversation-workspace]');
 await app.click('[data-account-menu]');
 const page=app.host.querySelector('[data-settings-page="page"]');
 assert.ok(page);
 const settingsWorkspace=page.closest('[data-settings-workspace]');
 assert.ok(settingsWorkspace);
 assert.ok(page.closest('[data-settings-canvas]'));
 assert.ok(settingsWorkspace.parentElement===workspace.parentElement,'settings replace the hidden conversation beside the owning rail');
 assert.ok(workspace.hasAttribute('inert'));
 assert.equal(workspace.getAttribute('aria-hidden'),'true');
 assert.ok(workspace.classList.contains('hidden'));
 assert.equal(app.host.querySelector('footer'),editor);
 await app.emit('run-a',2,'text_delta',{delta:'期间的输出'});
 await app.click('[data-settings-back]');
 assert.equal(app.host.querySelector('[data-settings-page]'),null);
 assert.equal(workspace.hasAttribute('inert'),false);
 assert.equal(app.host.querySelector('footer'),editor);
 assert.equal(app.draft,'保留的草稿');
 assert.equal(app.calls.filter(call=>call.path==='/api/web-chat/conversations'&&call.method==='POST').length,0);
 assert.equal(app.calls.filter(call=>call.path.includes('/cancel')).length,0);
 await app.click('[data-account-menu]');
 await app.click('[data-rail-item="chat"]');
 assert.equal(app.host.querySelector('[data-settings-page]'),null);
});

test('header new conversation opens a local draft and inline rename uses the existing conversation API without changing its Run',async t=>{
 const app=await mount(t,{initialRun:snapshot({output:'保留的输出'})});
 const editor=app.host.querySelector('footer');app.draft='保留的编辑内容';
 await app.click('.cloud-title-trigger');
 const input=app.host.querySelector('[aria-label="对话标题"]');
 await app.env.act(async()=>{
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'更明确的标题');
  input.dispatchEvent(new Event('input',{bubbles:true}));
 });
 await app.env.act(async()=>{input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await tick();});
 assert.match(app.host.querySelector('.cloud-title-trigger').textContent,/更明确的标题/);
 assert.equal(app.host.querySelector('footer'),editor);assert.equal(app.draft,'保留的编辑内容');
 const patches=app.calls.filter(call=>call.path===`/api/web-chat/conversations/${defaultConversation}`&&call.method==='PATCH');
 assert.equal(patches.length,1);assert.equal(JSON.parse(patches[0].body).title,'更明确的标题');
 assert.equal(app.calls.filter(call=>call.path.includes('/cancel')).length,0);
 await app.click('header .cloud-header-new-chat');
 assert.equal(app.draft,'');assert.equal(app.host.querySelector('footer'),editor);
 assert.equal(app.calls.filter(call=>call.path==='/api/web-chat/conversations'&&call.method==='POST').length,0);
});

test('a late inline-title response cannot restore conversation metadata after account invalidation',async t=>{
 const app=await mount(t);app.delayRename=true;
 await app.click('.cloud-title-trigger');const input=app.host.querySelector('[aria-label="对话标题"]');
 await app.env.act(async()=>{
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'旧账号标题');
  input.dispatchEvent(new Event('input',{bubbles:true}));
 });
 await app.env.act(async()=>{input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await tick();});
 await app.invalidate();await app.finishRename();
 assert.equal(app.host.querySelectorAll('[data-conversation]').length,0);
 assert.doesNotMatch(app.host.textContent,/旧账号标题/);
 assert.match(app.host.textContent,/登录状态已更新，请刷新页面后继续。/);
});

test('closing project settings leaves the conversation draft and Run intact on mobile',async t=>{
 const app=await mount(t,{mobileLayout:true,initialRun:snapshot({output:'保留的输出'})});
 app.draft='未发送的草稿';await app.clickText('项目');
 assert.ok(app.host.querySelector('[data-project-panel]'));
 await app.env.act(async()=>{app.projectPanel.onClose();await tick();});
 assert.equal(app.host.querySelector('[data-project-panel]'),null);
 assert.equal(app.draft,'未发送的草稿');assert.match(app.host.textContent,/保留的输出/);
 assert.equal(app.calls.filter(call=>call.path.includes('/cancel')).length,0);
 assert.equal(app.calls.filter(call=>call.path==='/api/web-chat/runs'&&call.method==='POST').length,0);
});


function dropTransfer(types=["Files"],files=[]){const values=new Map();return {types,files,items:[],setData(type,value){values.set(type,value);if(!this.types.includes(type))this.types.push(type);},getData(type){return values.get(type)??"";}};}
async function cloudDrop(app,data,type="drop"){
 const event=new window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:data});
 await app.env.act(async()=>{app.host.querySelector('[data-file-drop-boundary]').dispatchEvent(event);await tick();});return event;
}

test("first-draft file drops preserve structured content without creating a conversation or sending automatically",async t=>{
 const app=await mount(t,{newDraft:true,fileMode:true});
 const paste={id:"large-file-drop",text:"保留原始长文本",label:"Pasted text"};
 const rich={text:"草稿与长文本",textWithoutLargePastes:"草稿",segments:[{type:"text",text:"草稿"},{type:"largePaste",paste}],largePastes:[paste],skillMentions:[],appMentions:[],commitMentions:[],gitFileMentions:[],codeMentions:[],isEmpty:false};app.structuredDraft=rich;
 const file=new File(["hello"],"notes.md",{type:"text/markdown"});
 await cloudDrop(app,dropTransfer(["Files"],[file]));
 assert.equal(app.calls.filter(call=>call.path==="/api/web-chat/conversations"&&call.method==="POST").length,0);
 assert.equal(app.calls.filter(call=>call.path==="/api/web-chat/files"&&call.method==="POST").length,1);
 assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);
 assert.deepEqual(app.structuredDraft,rich);assert.equal(app.composer.pendingUploadedFiles.length,1);
});

test("rejected first-draft files do not create a conversation and a claimed upload blocks immediate repeated drops",async t=>{
 const app=await mount(t,{newDraft:true,fileMode:true,delayedUpload:true});
 const oversized=new File([],"too-large.pdf");Object.defineProperty(oversized,"size",{value:33*1024*1024});
 await cloudDrop(app,dropTransfer(["Files"],[oversized,new File([],"program.exe")]));
 assert.equal(app.calls.some(call=>call.method==="POST"),false);assert.match(app.host.textContent,/32 MiB/);assert.match(app.host.textContent,/格式/);
 const data=dropTransfer(["Files"],[new File(["hello"],"notes.md")]);
 const boundary=app.host.querySelector('[data-file-drop-boundary]');
 await app.env.act(async()=>{for(let index=0;index<2;index++){const event=new window.Event("drop",{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:data});boundary.dispatchEvent(event);}await tick();});
 assert.equal(app.calls.filter(call=>call.path==="/api/web-chat/files"&&call.method==="POST").length,1);await app.finishUpload();
});

test("an unknown file upload prevents further uploads until an explicit successful library check",async t=>{
 const app=await mount(t,{fileMode:true});app.uploadOnline=false;
 const file=new File(["hello"],"notes.md");await cloudDrop(app,dropTransfer(["Files"],[file]));
 assert.match(app.host.textContent,/上传结果尚未确认/);assert.equal(app.files.size,1);
 await app.paste([file]);assert.equal(app.calls.filter(call=>call.path==="/api/web-chat/files"&&call.method==="POST").length,1);
 app.fileListOnline=false;await app.clickText("刷新文件库核对");await app.paste([file]);
 assert.equal(app.calls.filter(call=>call.path==="/api/web-chat/files"&&call.method==="POST").length,1);
 app.fileListOnline=true;app.uploadOnline=true;await app.clickText("刷新文件库核对");
 assert.equal(app.host.textContent.includes("继续添加前请核对文件库"),false);
 await app.paste([file]);assert.equal(app.calls.filter(call=>call.path==="/api/web-chat/files"&&call.method==="POST").length,2);
});

test("cloud identity drops re-read canonical metadata, deduplicate and reject a forged identity without uploading",async t=>{
 const app=await mount(t,{fileMode:true,initialFiles:[fileRecord()]});
 const api=app.env.loadModule("src/lib/cloudResourceDrag.ts"),data=dropTransfer([]);
 api.writeCloudResourceDragPayload(data,[{kind:"file",id:fileId,target_id:fileId}]);
 await cloudDrop(app,data);assert.equal(app.composer.pendingUploadedFiles.length,1);
 assert.ok(app.calls.some(call=>call.path===`/api/web-chat/files/${fileId}`));
 await cloudDrop(app,data);assert.equal(app.composer.pendingUploadedFiles.length,1);
 assert.equal(app.calls.some(call=>call.path==="/api/web-chat/files"&&call.method==="POST"),false);
 for(let index=0;index<7;index++)await app.env.act(async()=>app.contextPicker.onAttach(fileRecord({id:`99999999-9999-4999-8999-99999999999${index}`})));
 assert.equal(app.composer.pendingUploadedFiles.length,8);await cloudDrop(app,data);assert.equal(app.composer.pendingUploadedFiles.length,8);
 api.writeCloudResourceDragPayload(data,[{kind:"file",id:artifactVersionID,target_id:fileId}]);
 await cloudDrop(app,data);assert.match(app.host.textContent,/身份已变化/);assert.equal(app.composer.pendingUploadedFiles.length,8);
});

test("cloud reference validation cannot attach late metadata to another conversation",async t=>{
 const app=await mount(t,{fileMode:true,initialArtifacts:[artifactRecord()],delayedArtifact:true});
 const api=app.env.loadModule("src/lib/cloudResourceDrag.ts"),data=dropTransfer([]);
 api.writeCloudResourceDragPayload(data,[{kind:"artifact",id:artifactFamilyID,target_id:artifactVersionID}]);
 await cloudDrop(app,data);await app.click(`[data-conversation="${secondFileConversation}"]`);await app.finishArtifact();
 assert.equal(app.composer.pendingUploadedFiles.length,0);assert.doesNotMatch(app.host.textContent,/website.html/);
});

const richComposerDraft = () => {
 const paste = { id: "large-draft", label: "Pasted text", text: "需要保留的长文本", preview:"需要保留的长文本",charCount:8,lineCount:1 };
 return { text: "问题与长文本", textWithoutLargePastes: "问题", segments: [{ type: "text", text: "问题" }, { type: "largePaste", paste }], largePastes: [paste], skillMentions: [], appMentions: [], commitMentions: [], gitFileMentions: [], conversationMentions: [], codeMentions: [], isEmpty: false };
};

test("conversation navigation restores each full draft with its exact file and artifact references", async t => {
 const app = await mount(t, { fileMode: true, initialFiles: [fileRecord()], initialArtifacts: [artifactRecord()] });
 const rich = richComposerDraft(); app.structuredDraft = rich;
 await app.env.act(async () => { app.contextPicker.onAttach(fileRecord()); await tick(); });
 await app.openArtifact(); await app.clickText("继续修改");
 await app.click(`[data-conversation="${secondFileConversation}"]`);
 assert.equal(app.draft, ""); assert.equal(app.composer.pendingUploadedFiles.length, 0);
 app.draft = "另一会话草稿";
 await app.click(`[data-conversation="${fileConversation}"]`);
 assert.deepEqual(app.structuredDraft, rich);
 assert.deepEqual(app.composer.pendingUploadedFiles.map(file => file.relativePath), [fileId, `cloud-artifacts/${artifactVersionID}`]);
 await app.click(`[data-conversation="${secondFileConversation}"]`);
 assert.equal(app.draft, "另一会话草稿"); assert.equal(app.composer.pendingUploadedFiles.length, 0);
 assert.equal(app.calls.some(call => call.path === "/api/web-chat/runs" && call.method === "POST"), false);
});

test("new conversation resets only the blank draft while existing structured drafts remain recoverable", async t => {
 const app = await mount(t); const rich = richComposerDraft(); app.structuredDraft = rich;
 await app.click('[data-new-conversation]'); assert.equal(app.draft, "");
 app.draft = "即将丢弃的空白草稿";
 await app.click('[data-new-conversation]'); assert.equal(app.draft, "");
 await app.click(`[data-conversation="${defaultConversation}"]`); assert.deepEqual(app.structuredDraft, rich);
 assert.equal(app.calls.some(call => call.path === "/api/web-chat/conversations" && call.method === "POST"), false);
});

test("conversation drafts retain their own input presentation and explicit research selection", async t => {
 const app = await mount(t, { initialMessages: [] }); app.draft = "A 的问题";
 await app.clickText("对话");
 await app.env.act(async () => { app.composer.onChatRuntimeControlsChange({ nativeWebSearchEnabled: true }); await tick(); });
 await app.click(`[data-conversation="${alternateConversation}"]`);
 assert.equal(app.composer.expandedInput, true); assert.equal(app.composer.chatRuntimeControls.nativeWebSearchEnabled, false);
 await app.click(`[data-conversation="${defaultConversation}"]`);
 assert.equal(app.composer.expandedInput, false); assert.equal(app.composer.chatRuntimeControls.nativeWebSearchEnabled, true); assert.equal(app.draft, "A 的问题");
 assert.equal(app.calls.some(call => call.path === "/api/web-chat/runs" && call.method === "POST"), false);
});

test("branch editing carries the independent structured draft without changing its original conversation snapshot", async t => {
 const app = await mount(t); const rich = richComposerDraft(); app.structuredDraft = rich;
 await app.edit("user-a", "新的分支问题");
 assert.deepEqual(app.structuredDraft, rich);
 app.draft = "分支继续编辑";
 await app.click(`[data-conversation="${defaultConversation}"]`); assert.deepEqual(app.structuredDraft, rich);
 await app.click(`[data-conversation="${branchConversation(1)}"]`); assert.equal(app.draft, "分支继续编辑");
 assert.equal(app.runs.size, 1);
});

test("unknown submissions survive a conversation roundtrip and reconcile the original request only on explicit action", async t => {
 const app = await mount(t); app.structuredDraft = richComposerDraft(); app.online=false;
 await app.click('[data-action="send"]');
 const posts = () => app.calls.filter(call => call.path === "/api/web-chat/runs" && call.method === "POST");
 const count = posts().length, body = posts()[0].body;
 await app.click(`[data-conversation="${alternateConversation}"]`); assert.equal(app.draft, "");
 app.draft = "保留 B 草稿"; app.online = true;
 await app.click(`[data-conversation="${defaultConversation}"]`);
 assert.equal(posts().length, count); assert.match(app.host.textContent, /提交结果尚未确认/);
 assert.equal(app.composer.isInputDisabled, true); assert.deepEqual(app.structuredDraft, richComposerDraft());
 assert.ok(app.transcript.rows.some(row => row.key === "user-a"), "history remains readable during reconciliation");
 await app.clickText("核对提交状态");
 assert.ok(posts().every(call => call.body === body)); assert.equal(app.runs.size, 1); assert.equal(app.draft, "");
 await app.click(`[data-conversation="${alternateConversation}"]`); assert.equal(app.draft, "保留 B 草稿");
 await app.click(`[data-conversation="${defaultConversation}"]`); assert.equal(app.draft, "");
});

test("acceptance clears the submitted snapshot but never newer text typed while its receipt is pending", async t => {
 for (const changed of [false, true]) await t.test(changed ? "new text survives" : "submitted draft cleared", async child => {
  const app = await mount(child, { delayedSubmit: true }); app.draft = "提交的内容";
  await app.click('[data-action="send"]');
  if (changed) app.structuredDraft = richComposerDraft();
  await app.finishSubmit();
  assert.equal(app.draft, changed ? "问题与长文本" : "");
  await app.click(`[data-conversation="${alternateConversation}"]`); await app.click(`[data-conversation="${defaultConversation}"]`);
  assert.equal(app.draft, changed ? "问题与长文本" : "");
  assert.equal(app.runs.size, 1);
 });
});

test("a rejected first send transfers its complete blank draft to the created conversation for retry", async t => {
 const app = await mount(t, { newDraft: true, queueFull: true }); const rich = richComposerDraft(); app.structuredDraft = rich;
 await app.click('[data-action="send"]'); const created = new URLSearchParams(window.location.search).get("conversation");
 assert.ok(created); assert.deepEqual(app.structuredDraft, rich); assert.match(app.host.textContent, /账户队列已满/);
 await app.click(`[data-conversation="${defaultConversation}"]`); assert.equal(app.draft, "");
 await app.click(`[data-conversation="${created}"]`); assert.deepEqual(app.structuredDraft, rich); assert.match(app.host.textContent, /账户队列已满/);
 await app.clickText("返回编辑"); app.draft = "修改后发送"; app.queueFull = false;
 await app.click('[data-action="send"]'); assert.equal(app.draft, "");
 assert.equal(app.calls.filter(call => call.path === "/api/web-chat/conversations" && call.method === "POST").length, 1);
});

test("account replacement and invalidation erase cached drafts and unknown request ownership", async t => {
 for (const invalidate of [false, true]) await t.test(invalidate ? "invalidated session" : "new account", async child => {
  const app = await mount(child); app.structuredDraft = richComposerDraft(); app.online=false;
  await app.click('[data-action="send"]'); assert.match(app.host.textContent,/提交结果尚未确认/); await app.click(`[data-conversation="${alternateConversation}"]`); app.draft = "账户私有草稿";
  if (invalidate) await app.invalidate(); else await app.switchAccount(2);
  assert.equal(app.draft, ""); assert.equal(app.composer.pendingUploadedFiles.length, 0);
  assert.doesNotMatch(app.host.textContent, /提交结果尚未确认|核对提交状态/);
  if (!invalidate) { app.online = true; assert.ok(app.host.querySelector(`[data-conversation="${defaultConversation}"]`), app.host.textContent+JSON.stringify(app.calls.filter(call=>call.path.includes('catalog'))));await app.click(`[data-conversation="${defaultConversation}"]`); assert.equal(app.draft, ""); }
 });
});

test("editing a pending message keeps its frozen model parameters and never admits it as a Run", async t => {
 const parameters={request_format:"openai-completions",context_window:96000,max_output_tokens:12000,input_modalities:["text","image"],provider_cache_mode:"none",model_cache_mode:"auto",time_zone:"Asia/Hong_Kong",locale:"zh-CN"};
 const item={client_item_id:fixtureUUID(900),model:"test-model",provider_key_id:1,reasoning_effort:"high",content:"排队时的原问题",model_parameters:parameters};
 const app=await mount(t,{initialPending:[item],modelSettings:[configuredProvider()],initialDraftText:"保留独立草稿"});
 assert.equal(app.composer.queuedTurns.length,1,app.host.textContent+JSON.stringify(app.calls.filter(call=>call.path.includes('/pending'))));
 assert.equal(app.calls.some(call=>call.method==='POST'&&call.path.includes('/submit')),false);
 await app.env.act(async()=>{app.composer.onEditQueuedTurn(item.client_item_id);await tick();});
 assert.equal(app.draft,"排队时的原问题");app.draft="编辑后的问题";
 await app.click('[data-action="send"]');
 const write=app.calls.find(call=>call.method==='PATCH'&&call.path.endsWith(`/pending/${item.client_item_id}`));assert.ok(write);
 assert.deepEqual(JSON.parse(write.body).item.model_parameters,parameters);
 assert.equal(JSON.parse(write.body).item.content,"编辑后的问题");
 assert.equal(app.draft,"保留独立草稿");assert.equal(app.runs.size,0);
 assert.equal(app.calls.some(call=>call.path==='/api/web-chat/runs'&&call.method==='POST'||call.path.endsWith('/submit')),false);
});

test("saved structured drafts restore from the server and keep each conversation isolated through input and submission", async t => {
 const rich=richComposerDraft();
 const app=await mount(t,{initialDraftText:"",initialSavedDrafts:[{scope:defaultConversation,draft:{version:1,draft:{composer:rich,files:[],artifacts:[],presentation:"work",researchEnabled:false},modelSelection:{model:"test-model",providerKeyId:1,reasoningEffort:"medium"}}}]});
 assert.deepEqual(app.structuredDraft,rich);
 await app.typeDraft("A 的最新输入");await app.flushDraft();
 assert.equal(app.savedDrafts.get(`1:${defaultConversation}`).draft.draft.composer.text,"A 的最新输入");
 await app.click(`[data-conversation="${alternateConversation}"]`);assert.equal(app.draft,"");
 await app.typeDraft("B 的独立输入");await app.flushDraft();
 await app.click(`[data-conversation="${defaultConversation}"]`);assert.equal(app.draft,"A 的最新输入");
 await app.click('[data-action="send"]');
 assert.equal(app.savedDrafts.get(`1:${defaultConversation}`).draft,null);
 assert.equal(app.savedDrafts.get(`1:${alternateConversation}`).draft.draft.composer.text,"B 的独立输入");
 await app.click(`[data-conversation="${alternateConversation}"]`);assert.equal(app.draft,"B 的独立输入");
});

test("server history search opens the matched message window without dropping the unsent draft or starting a Run", async t => {
 const history=Array.from({length:120},(_,index)=>({id:`search-message-${index}`,role:index%2?'assistant':'user',content:index===4?'跨页验收关键词':'其他合成内容'}));
 const app=await mount(t,{initialMessages:history,initialDraftText:"搜索前的草稿"});
 assert.equal(app.transcript.rows.some(row=>row.key==='search-message-4'),false);
 const adapter=app.sidebar.conversationSearchAdapter,page=await adapter.search('跨页验收关键词',{signal:new AbortController().signal});
 assert.equal(page.items.length,1);
 await app.env.act(async()=>{adapter.onSelectResult(page.items[0]);await tick();});
 assert.ok(app.calls.some(call=>call.path.includes('/messages/search-message-4/window')));
 assert.ok(app.transcript.rows.some(row=>row.key==='search-message-4'));
 assert.equal(app.draft,"搜索前的草稿");assert.equal(app.runs.size,0);
});

test("an active Run allows attachments for the next pending message while project changes stay locked", async t => {
 const app=await mount(t,{fileMode:true,initialRun:snapshot({conversation_id:fileConversation}),initialDraftText:"下一条消息"});
 const project=composerProjectRecord();app.projectRecords.set(project.id,project);await app.env.act(async()=>{await app.contextPicker.onSelectProject(project);await tick();});assert.equal(app.calls.some(call=>call.path.endsWith('/project')&&call.method==='PUT'),false);
 await app.paste([new File(["hello"],"next.md",{type:"text/markdown"})]);
 assert.equal(app.composer.pendingUploadedFiles.length,1);assert.equal(app.composer.isSending,true);
 await app.click('[data-action="send"]');
 const post=app.calls.find(call=>call.method==='POST'&&call.path.endsWith(`/conversations/${fileConversation}/pending`));assert.ok(post);
 assert.deepEqual(JSON.parse(post.body).item.content,[{type:'text',text:'下一条消息'},{type:'file_reference',file_id:fileId}]);
 assert.equal(app.runs.size,1);assert.equal(app.calls.some(call=>call.path.endsWith('/submit')),false);
 assert.equal(app.composer.pendingUploadedFiles.length,0);
});

test("uploading in a blank draft stores the file without a conversation and creates the conversation only on send", async t => {
 const app=await mount(t,{fileMode:true,newDraft:true,initialDraftText:""});
 await app.paste([new File(["hello"],"blank.md",{type:"text/markdown"})]);
 assert.equal(app.calls.filter(call=>call.path==='/api/web-chat/conversations'&&call.method==='POST').length,0);
 const upload=app.calls.find(call=>call.path==='/api/web-chat/files'&&call.method==='POST');assert.ok(upload);assert.equal(upload.body.get('conversation_id')??'', '');
 assert.equal(app.composer.pendingUploadedFiles.length,1);
 await app.typeDraft('使用这份文件');await app.click('[data-action="send"]');
 assert.equal(app.calls.filter(call=>call.path==='/api/web-chat/conversations'&&call.method==='POST').length,1);
 const run=JSON.parse(app.calls.find(call=>call.path==='/api/web-chat/runs'&&call.method==='POST').body);
 assert.ok(run.content.some(part=>part.type==='file_reference'&&part.file_id===fileId));assert.equal(app.composer.pendingUploadedFiles.length,0);
});


test("switching conversations keeps exactly one branch action and no duplicate React identities",async(t)=>{
 const problems=[],original=console.error;console.error=(...args)=>{if(args.some(arg=>String(arg).includes("same key")))problems.push(args);else original(...args);};t.after(()=>{console.error=original;});
 const app=await mount(t);
 for(const id of [alternateConversation,defaultConversation,alternateConversation,defaultConversation]){
   await app.click(`[data-conversation="${id}"]`);
   assert.equal(app.host.querySelectorAll('button[aria-label="查看对话分支"]').length,1);
   assert.equal(app.host.querySelectorAll('button[aria-label="对话选项"]').length,1);
 }
 assert.deepEqual(problems,[]);
});

test("CloudChat uses the existing floor rail with exact message identities and virtual-list jumps",async(t)=>{
 const app=await mount(t,{initialMessages:[{id:"floor-user-1",role:"user",content:"第一条问题"},{id:"floor-answer-1",role:"assistant",content:"第一条回答"},{id:"floor-user-2",role:"user",content:"第二条问题"},{id:"floor-answer-2",role:"assistant",content:"第二条回答"}]});
 assert.deepEqual(app.floorNav.floors.map(floor=>[floor.messageId,floor.preview]),[["floor-user-1","第一条问题"],["floor-user-2","第二条问题"]]);
 assert.equal(app.floorNav.conversationId,`cloud:1:${defaultConversation}`);
 const jumps=[];app.transcript.navRef.current={scrollToRowKey:key=>jumps.push(key)};
 await app.env.act(async()=>{app.floorNav.onJump("floor-user-1");await tick();});assert.deepEqual(jumps,["floor-user-1"]);
 assert.equal(app.host.querySelector('[role="tablist"][aria-label="对话范围"]'),null);
 assert.equal(app.sidebar.loadMoreMode,"scroll");assert.doesNotMatch(app.host.textContent,/本会话附件|本会话成果/);
});

test("sidebar project creation opens a dialog and cancels without navigating or creating a conversation",async(t)=>{
 const app=await mount(t,{newDraft:true});
 await app.click('[aria-label="新建项目"]');assert.ok(app.host.querySelector('input[aria-label="项目名称"]'));
 assert.equal(app.host.querySelector('[data-project-panel]'),null);assert.equal(app.host.querySelector('.cloud-chat-shell').getAttribute('data-workspace-view'),"chat");
 await app.clickText("取消");assert.equal(app.host.querySelector('input[aria-label="项目名称"]'),null);
 assert.equal(app.calls.some(call=>call.path==="/api/web-chat/conversations"&&call.method==="POST"),false);
});

test("switching accounts retires the previous project creation dialog and its draft",async(t)=>{
 const app=await mount(t,{newDraft:true});await app.click('[aria-label="新建项目"]');await app.setInput("项目名称","旧账户项目草稿");
 await app.switchAccount(2);assert.equal(app.host.querySelector('input[aria-label="项目名称"]'),null);
 assert.doesNotMatch(app.host.textContent,/旧账户项目草稿/);assert.equal(app.calls.some(call=>call.path==="/api/web-chat/projects"&&call.method==="POST"),false);
});

test('project moves relocate the sidebar row, and project New keeps context without creating an empty record', async t => {
 const app=await mount(t,{fileMode:true,initialMessages:[],initialDraftText:"现有草稿"});
 const project=composerProjectRecord();app.projectRecords.set(project.id,project);
 await app.env.act(async()=>{await app.contextPicker.onSelectProject(project);await tick();await tick();});
 assert.ok(app.calls.some(call=>call.path.includes('catalog?')&&call.path.includes('scope=unassigned')));
 assert.equal(app.sidebar.items.some(item=>item.id===fileConversation),false);
 assert.equal(app.host.querySelector('.cloud-project-conversation button')?.getAttribute('aria-current'),"page");
 assert.equal(app.draft,"现有草稿");
 const before=app.calls.filter(call=>call.path==='/api/web-chat/conversations'&&call.method==='POST').length;
 await app.env.act(async()=>{app.host.querySelector('.cloud-project-actions button[aria-label^="在"]').click();await tick();});
 assert.equal(app.contextPicker.selectedProjectId,project.id);
 assert.equal(app.calls.filter(call=>call.path==='/api/web-chat/conversations'&&call.method==='POST').length,before);
 assert.equal(app.runs.size,0);
 await app.env.act(async()=>{app.host.querySelector('.cloud-project-conversation button').click();await tick();});
 assert.equal(app.draft,"现有草稿");
 await app.env.act(async()=>{await app.contextPicker.onSelectProject(null);await tick();await tick();});
 assert.equal(app.sidebar.items.some(item=>item.id===fileConversation),true);
 assert.equal(app.host.querySelector('.cloud-project-conversation'),null);
});

test("a sidebar project move targets its own row and preserves the current conversation and draft", async t => {
 const app=await mount(t,{initialDraftText:"正在编写的草稿"});
 const project=composerProjectRecord();app.projectRecords.set(project.id,project);
 const menu=()=>app.sidebar.renderConversationMoveMenu({id:alternateConversation}).props;
 await app.env.act(async()=>{await menu().onMove(project);await tick();});
 assert.equal(app.projectBindings.get(alternateConversation).project_id,project.id);
 assert.equal(app.sidebar.currentConversationId,defaultConversation);assert.equal(app.draft,"正在编写的草稿");
 assert.equal(app.sidebar.items.some(item=>item.id===alternateConversation),false);
 await app.clickText(project.name);
 assert.equal(app.sidebar.navigationItems.some(item=>item.id===alternateConversation),true);
 await app.env.act(async()=>{await menu().onMove(null);await tick();});
 assert.equal(app.projectBindings.get(alternateConversation).project_id,"");
 assert.equal(app.sidebar.items.some(item=>item.id===alternateConversation),true);
 assert.equal(app.sidebar.navigationItems.some(item=>item.id===alternateConversation),false);
 assert.equal(app.sidebar.currentConversationId,defaultConversation);assert.equal(app.draft,"正在编写的草稿");
 assert.equal(app.runs.size,0);
});

test("creating a destination from another row keeps creation in the dialog without changing current project context", async t => {
 const app=await mount(t,{initialDraftText:"独立草稿"});
 await app.env.act(async()=>{app.sidebar.renderConversationMoveMenu({id:alternateConversation}).props.onCreate();await tick();});
 assert.ok(app.host.querySelector('input[aria-label="项目名称"]'));
 assert.equal(app.sidebar.currentConversationId,defaultConversation);assert.equal(app.draft,"独立草稿");
 await app.clickText("取消");
 assert.equal(app.host.querySelector('input[aria-label="项目名称"]'),null);
 assert.equal(app.calls.some(call=>call.method==="PUT"&&call.path.endsWith('/project')),false);
});

test("a late sidebar project move cannot refresh another account or replace its draft", async t => {
 const app=await mount(t,{initialDraftText:"账户一草稿"});const project=composerProjectRecord();app.projectRecords.set(project.id,project);
 app.delayProjectAssociation=true;
 let pending;
 await app.env.act(async()=>{pending=app.sidebar.renderConversationMoveMenu({id:alternateConversation}).props.onMove(project).catch(()=>undefined);await tick();});
 await app.switchAccount(2);
 const requests=app.calls.length;
 await app.finishProjectAssociation();await pending;
 assert.equal(app.sidebar.navigationItems.length,0);
 assert.equal(app.calls.slice(requests).some(call=>call.path.includes('/catalog?')),false);
 assert.doesNotMatch(app.draft,/账户一草稿/);
});

test("moving the current row locks sending until its project association is confirmed and keeps the draft", async t => {
 const app=await mount(t,{initialDraftText:"移动期间保留的草稿"});const project=composerProjectRecord();app.projectRecords.set(project.id,project);
 app.delayProjectAssociation=true;let pending;
 await app.env.act(async()=>{pending=app.sidebar.renderConversationMoveMenu({id:defaultConversation}).props.onMove(project);await tick();});
 assert.equal(app.composer.isInputDisabled,true);
 await app.click('[data-action="send"]');assert.equal(app.runs.size,0);
 await app.env.act(async()=>{await app.contextPicker.onSelectProject(null);await tick();});
 assert.equal(app.calls.filter(call=>call.method==="PUT"&&call.path.endsWith('/project')).length,1);
 await app.finishProjectAssociation();await pending;
 assert.equal(app.composer.isInputDisabled,false);assert.equal(app.draft,"移动期间保留的草稿");
 assert.equal(app.contextPicker.selectedProjectId,project.id);
 assert.equal(app.runs.size,0);
});


test("explicit document revision sends the original draft and exact immutable resource through normal Run submission",async t=>{
 for(const kind of ["file","artifact"])await t.test(kind,async child=>{
  const resource=kind==="file"?fileRecord({name:"review.docx",workspace_loadable:true}):artifactRecord({name:"review.docx"});
  const app=await mount(child,{fileMode:true,revisionHarness:true,initialFiles:kind==="file"?[resource]:[],initialArtifacts:kind==="artifact"?[resource]:[],initialDraftText:"保留已有补充要求"});
  if(kind==="artifact")await app.openArtifact(resource.id);
  else await app.env.act(async()=>{app.transcript.onOpenFileLink({path:`cloud-files/${resource.id}`,source:"relative"});await tick();});
  assert.ok(app.revisionPanel?.onRequestRevision);
  assert.equal(app.calls.filter(call=>call.path==="/api/web-chat/runs"&&call.method==="POST").length,0);
  let accepted;
  await app.env.act(async()=>{accepted=await app.revisionPanel.onRequestRevision(resource,[{id:"comment-1",page:2,block:"za-reader-block-3",start:4,end:8,quote:"原文片段",comment:"改为简洁表达"}]);await tick();});
  assert.equal(accepted,true);
  const posts=app.calls.filter(call=>call.path==="/api/web-chat/runs"&&call.method==="POST");assert.equal(posts.length,1);
  const input=JSON.parse(posts[0].body);
  assert.equal(input.model,"test-model");assert.equal(input.provider_key_id,1);
  assert.match(input.content[0].text,/保留已有补充要求/);assert.match(input.content[0].text,/第 2 页 · za-reader-block-3 · 字符 4–8/);assert.match(input.content[0].text,/原文：原文片段/);assert.match(input.content[0].text,/修改要求：改为简洁表达/);
  assert.deepEqual(input.content[1],kind==="file"?{type:"file_reference",file_id:resource.id}:{type:"artifact_reference",version_id:resource.id});
 });
});

test("a late revision resource check cannot send annotations into a switched conversation",async t=>{
 const resource=artifactRecord({name:"review.docx"}),app=await mount(t,{fileMode:true,revisionHarness:true,initialArtifacts:[resource],delayedArtifact:true});
 await app.openArtifact(resource.id);
 let result;
 const pending=app.revisionPanel.onRequestRevision(resource,[{id:"c",page:1,block:"za-reader-block-1",start:0,end:1,quote:"原",comment:"改"}]).then(value=>{result=value;},()=>{result=false;});
 await app.click(`[data-conversation="${secondFileConversation}"]`);
 const nextDraft=app.draft;await app.finishArtifact();await pending;
 assert.equal(result,false);assert.equal(app.calls.some(call=>call.path==="/api/web-chat/runs"&&call.method==="POST"),false);assert.equal(app.draft,nextDraft);
});
