import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const output=process.env.ZEROAGENT_REMOTE_E2E_ARTIFACTS||path.resolve('.codex-artifacts/native-pair');
mkdirSync(output,{recursive:true});
const trace = path.join(output,'upstream.ndjson');
const group = {id:3,name:'Local QA models',platform:'openai',status:'active',rate_multiplier:1};
const servers=[];
let modelDelay=0;
for (const port of [19373,19375]) {
 const server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(path==='/_qa/model-delay'){modelDelay=Number(new URL(req.url,'http://127.0.0.1').searchParams.get('ms'))||0;res.end('ok');return;}
  const chunks=[];for await (const chunk of req) chunks.push(chunk);
  const raw=Buffer.concat(chunks).toString();
  appendFileSync(trace,JSON.stringify({time:Date.now(),port,method:req.method,path})+'\n');
  let data;
  if (path.endsWith('/me') || path.endsWith('/user/profile')) data={id:700127,email:'remote-qa@example.test',username:'Remote QA',status:'active',role:'user',balance:100,concurrency:4};
  else if (path.endsWith('/keys')) data={items:[{id:11,name:'QA managed key',key:'sk-local-qa-only-not-a-real-key-20261028',group_id:3,group,status:'active',quota:0,quota_used:0,created_at:'2026-10-28T00:00:00Z'}],total:1,page:1,page_size:100,pages:1};
  else if (path.endsWith('/groups') || path.endsWith('/groups/available')) data=[group];
  else if (path.endsWith('/settings/public')) data={registration_enabled:false,email_verify_enabled:false,invitation_code_enabled:false,turnstile_enabled:false,site_name:'ZeroAgent isolated QA'};
  else if (path.endsWith('/subscriptions')) data=[];
  else if (path.endsWith('/stats') || path.endsWith('/usage')) data={today_tokens:0};
  else if (path.endsWith('/models')) {await new Promise(r=>setTimeout(r,modelDelay));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'gpt-qa-local',object:'model',owned_by:'openai'}]}));return;}
  else if (path.endsWith('/chat/completions')) {
   const body=JSON.parse(raw||'{}');
   const marker=JSON.stringify(body.messages||[]).match(/QA_TOOL_WRITE_(ALLOW|DENY)/)?.[1];
   if(marker&&!body.messages?.some(message=>message.role==='tool')){
    const tool=body.tools?.find(tool=>/^(Write|write_file|write)$/i.test(tool.function?.name||''));
    if(!tool){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'QA fixture: Write tool not available'}}));return;}
    const args=JSON.parse((body.messages.find(message=>message.role==='user'&&JSON.stringify(message.content).includes('QA_TOOL_WRITE_'))?.content||'').match(/QA_TOOL_WRITE_(?:ALLOW|DENY)\s+(\{[^\n]+\})/)?.[1]||'{}');
    const properties=tool.function.parameters.properties;
    const input={};input['file_path' in properties?'file_path':'path']=args.path;input['content' in properties?'content':'text']='isolated remote approval '+marker+'\n';
    const chunk={id:'qa-write',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'qa-write-'+marker.toLowerCase(),type:'function',function:{name:tool.function.name,arguments:JSON.stringify(input)}}]},finish_reason:null}]};
    res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify(chunk)+'\n\ndata: '+JSON.stringify({id:'qa-write',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');return;
   }
   const text='QA remote response: '+(body.messages?.at(-1)?.content||'ok');
   if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();await new Promise(r=>setTimeout(r,500));for(const part of text.match(/.{1,8}/g)||[]){res.write('data: '+JSON.stringify({id:'qa-chat',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:part},finish_reason:null}]})+'\n\n');await new Promise(r=>setTimeout(r,80));}res.end('data: '+JSON.stringify({id:'qa-chat',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\ndata: [DONE]\n\n');return;}
   data={id:'qa-chat',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}]};
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));return;
  }
  else {res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({code:1,message:'Unhandled isolated fixture path '+path}));return;}
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify(path.includes('/app/')?{success:true,data}:{code:0,data}));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});
 servers.push(server);
}
console.log('Synthetic account/model services ready on loopback 19373 and 19375');
for (const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>{for(const server of servers)server.close();process.exit(0)});
