import {remoteRpc} from './native-pair-rpc.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
const rpc=await remoteRpc();
try{
 const native=await rpc.target.invoke('settings_load_all');
 const workdir=native.defaultWorkdir;
 assert.ok(workdir.includes('two-client-remote-20261028'));
 for(const decision of ['approve','deny']){
  const marker=decision==='approve'?'ALLOW':'DENY';
  const file=path.join(workdir,'qa-'+marker.toLowerCase()+'-'+Date.now()+'.txt');
  assert.equal(existsSync(file),false);
  const clientId='qa-tool-'+Date.now();
  const accepted=await rpc.request({chat_command:{type:'chat.submit',request:{message:`QA_TOOL_WRITE_${marker} ${JSON.stringify({path:file})}`,selected_model:{custom_provider_id:'relay-key-11',provider_type:'codex',model:'gpt-qa-local'},workdir,execution_mode:'tools',client_request_id:clientId,command_safety_mode:'ask'}}},'approval.chat.submit');
  const toolId='qa-write-'+marker.toLowerCase();
  let conversation='';let pending=false;const events=[];
  for(let attempt=0;attempt<80;attempt++){
   await new Promise(r=>setTimeout(r,100));
   await rpc.request({status_get:{}},'approval.wait-status');
   if(!conversation){conversation=rpc.buffered.find(row=>row.chat_command_update?.run_id===accepted.chat_accepted.run_id&&row.chat_command_update.conversation_id)?.chat_command_update.conversation_id||'';if(conversation){const reply=await rpc.request({chat_subscribe:{conversation_id:conversation}},'approval.subscribe');for(const encoded of reply.chat_subscribed.events_json||[])events.push(JSON.parse(Buffer.from(encoded,'base64').toString()));}}
   for(const frame of rpc.buffered.splice(0)){if(frame.chat_event)events.push(JSON.parse(Buffer.from(frame.chat_event.payload_json,'base64').toString()));}
   pending=events.some(event=>event.id===toolId&&event.arguments?.__toolApprovalPending===true);
   if(pending)break;
  }
  if(!pending)console.log('APPROVAL DIAGNOSTIC '+JSON.stringify(events.filter(event=>event.type!=='token')));
  assert.equal(pending,true,'actual Go execution must pause at a real permission request');
  assert.equal(existsSync(file),false,'approval precedes all writes');
  const reply=await rpc.request({agent_request:{chat_queue:{action:'tool_approval',conversation_id:conversation,item_id:toolId,request_json:JSON.stringify({decision})}}},'approval.'+decision);
  assert.equal(reply.agent_response.chat_queue_resp.accepted,true);
  let settled=false;
  for(let attempt=0;attempt<60;attempt++){
   await new Promise(r=>setTimeout(r,100));
   const active=await rpc.request({chat_activities:{}},'approval.activities');
   if(!(active.chat_activities.running_conversations||[]).some(run=>run.conversation_id===conversation)){settled=true;break;}
  }
  assert.equal(settled,true,'permission result must finish the actual remote run');
  if(decision==='approve')assert.equal(readFileSync(file,'utf8'),'isolated remote approval ALLOW\n');
  else assert.equal(existsSync(file),false,'deny must never create a file');
  console.log('REAL TOOL '+decision.toUpperCase()+' PASS');
 }
}finally{await rpc.close()}
