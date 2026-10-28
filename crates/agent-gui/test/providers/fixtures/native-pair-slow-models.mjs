import {remoteRpc} from './native-pair-rpc.mjs';
import assert from 'node:assert/strict';
const rpc=await remoteRpc();
try{
 await fetch('http://127.0.0.1:19373/_qa/model-delay?ms=30000');
 const models=rpc.request({agent_request:{provider_models:{provider_id:'relay-key-11',provider_type:'codex',request_format:'openai-responses'}}},'slow-models').then(v=>({ok:true}),e=>({error:e.message}));
 const nextModels=rpc.request({agent_request:{provider_models:{provider_id:'relay-key-11',provider_type:'codex',request_format:'openai-responses'}}},'next-slow-models').then(v=>({ok:true}),e=>({error:e.message}));
 await new Promise(r=>setTimeout(r,400));
 const started=Date.now();
 const history=rpc.request({agent_request:{history_list:{page:1,page_size:20}}},'history-during-model-refresh').then(v=>({ok:true,ms:Date.now()-started}),e=>({error:e.message}));
 const results=await Promise.all([models,nextModels,history]);
 assert.equal(results[2].ok,true);
 assert.ok(results[2].ms<2000,'unrelated history must not queue behind model discovery');
 for(const result of results.slice(0,2))assert.match(result.error,/model discovery failed/);
 console.log('SLOW MODEL DISCOVERY ISOLATION PASS '+results[2].ms+'ms');
}finally{await fetch('http://127.0.0.1:19373/_qa/model-delay?ms=0');await rpc.close()}
