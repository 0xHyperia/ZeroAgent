import {bridge} from './native-pair-bridge.mjs';
import {createWebModuleLoader} from '../../../../agent-gateway/test/helpers/load-web-module.mjs';
import {createGatewayV2Codec} from '../../../../agent-gateway/test/helpers/gateway-v2.mjs';
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import path from 'node:path';
const codec=createGatewayV2Codec(createWebModuleLoader());
let sequence=0;
export async function remoteRpc(controllerPort=19385,targetPort=19383){
 const app=await bridge(controllerPort);
 const target=await bridge(targetPort);
 const account=await app.invoke('account_session_bootstrap');
 const targetAccount=await target.invoke('account_session_bootstrap');
 assert.equal(account.accountScope,'http://127.0.0.1:19375|user:700127','only the isolated synthetic controller may be tested');
 assert.equal(targetAccount.accountScope,'http://127.0.0.1:19373|user:700127','never send test mutations to a real account');
 const identity=await target.invoke('account_device_identity',{sessionHandle:targetAccount.sessionHandle});
 const agent=identity.agentId;
 const origin='http://127.0.0.1:19374';
 const http=async(path,method='GET',body=null)=>{
  const response=await app.invoke('account_gateway_http',{request:{sessionHandle:account.sessionHandle,origin,path,method,body}});
  assert.ok(response.status>=200&&response.status<300,`${path}: ${JSON.stringify(response)}`);
  return response.body;
 };
 const selection=await http('/api/desktop/execution-target/select','POST',{runtime_kind:'device_agent',device_id:agent,workspace_id:'',scope:'device',target_fingerprint:`device_agent:${agent}:`});
 assert.ok(selection.selection_lease);
 const socketId='qa-rpc-'+Date.now();
 await app.js(`globalThis.__qaSocketInbox=[];globalThis.__qaSocketOff=await window.__TAURI__.event.listen('account-gateway-socket',e=>{if(e.payload.id===${JSON.stringify(socketId)})globalThis.__qaSocketInbox.push(e.payload)});return true;`);
 await app.invoke('account_gateway_socket_connect',{request:{id:socketId,sessionHandle:account.sessionHandle,origin,path:'/ws/v2',protocols:['liveagent.v2.pb']}});
 const send=async(init)=>{
  const encoded=codec.pb.toBinary(codec.v2.WebClientFrameSchema,codec.pb.fromJson(codec.v2.WebClientFrameSchema,init));
  await app.invoke('account_gateway_socket_send',{request:{id:socketId,sessionHandle:account.sessionHandle,data:Buffer.from(encoded).toString('base64')}});
 };
 const buffered=[];
 async function receive(id,timeout=30000){
  const deadline=Date.now()+timeout;
  for(;;){
   const found=buffered.findIndex(row=>row.request_id===id);
   if(found>=0)return buffered.splice(found,1)[0];
   if(Date.now()>deadline)throw new Error('Test RPC timeout '+id);
   const events=await app.js('return globalThis.__qaSocketInbox.splice(0);');
   for(const event of events){
    if(event.kind==='message'){
     const frame=codec.pb.fromBinary(codec.v2.WebServerFrameSchema,Buffer.from(event.data,'base64'));
     const json=codec.pb.toJson(codec.v2.WebServerFrameSchema,frame,{useProtoFieldName:true});
     if(json.ping){await send({pong:{timestamp:json.ping.timestamp}});continue;}
     buffered.push(json);
    }else if(event.kind==='error'||event.kind==='close')throw new Error('Native socket '+event.kind+': '+event.data);
   }
   await new Promise(r=>setTimeout(r,25));
  }
 }
 async function request(payload,label){
  const id='qa-'+(++sequence);const start=Date.now();
  await send({request_id:id,agent_id:agent,...payload});
  const response=await receive(id);
  if(process.env.ZEROAGENT_REMOTE_E2E_ARTIFACTS)appendFileSync(path.join(process.env.ZEROAGENT_REMOTE_E2E_ARTIFACTS,'rpc-results.ndjson'),JSON.stringify({label,ms:Date.now()-start,response})+'\n');
  if(response.error)throw new Error(response.error.message||JSON.stringify(response.error));
  if(response.local_error)throw new Error(response.local_error.message||JSON.stringify(response.local_error));
  if(response.agent_response?.error)throw new Error(response.agent_response.error.message||JSON.stringify(response.agent_response.error));
  console.log(label+' '+(Date.now()-start)+'ms');return response;
 }
 const hello=await request({hello:{protocol_version:2,role:'CLIENT_ROLE_BROWSER',token:account.sessionHandle,selection_lease:selection.selection_lease,client_name:'desktop-native-e2e'}},'hello');
 assert.equal(hello.hello.ok,true);
 return {app,target,account,agent,http,selection,send,receive,request,buffered,async close(){await app.invoke('account_gateway_socket_close',{id:socketId,sessionHandle:account.sessionHandle}).catch(()=>{});app.close();target.close()}};
}
if(process.argv[1]?.endsWith('remote-rpc.mjs')){
 const rpc=await remoteRpc();
 try{
  await rpc.request({status_get:{}},'status');
  await rpc.request({agent_request:{settings_get:{}}},'settings.get');
  await rpc.request({agent_request:{history_workdirs:{}}},'history.workdirs');
  await rpc.request({agent_request:{history_list:{page:1,page_size:20}}},'history.list');
 }finally{await rpc.close()}
}
