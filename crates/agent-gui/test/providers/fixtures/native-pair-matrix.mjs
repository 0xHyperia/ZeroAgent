import {remoteRpc} from './native-pair-rpc.mjs';
import assert from 'node:assert/strict';
const rpc=await remoteRpc();
const agent=async(payload,label)=> {
 for(let attempt=0;;attempt++){
  try{return (await rpc.request({agent_request:payload},label)).agent_response}
  catch(error){if(attempt>=15||!/agent offline/.test(error.message)||!['settings_get','history_get','history_list'].some(key=>key in payload))throw error;await new Promise(r=>setTimeout(r,100));}
 }
};
const settings=async()=>JSON.parse((await agent({settings_get:{}},'settings.get')).settings_get_resp.settings_json);
try{
 const initial=await settings();
 assert.ok(initial.mcp);
 const providers=initial.customProviders.map(p=>({...p,requestFormat:'openai-completions',promptCacheHintMode:'none'}));
 const updated=await agent({settings_update:{settings_json:JSON.stringify({settingsSyncProtocol:initial.settingsSyncProtocol,configurationRevision:initial.configurationRevision,customProviders:providers})}},'settings.update');
 assert.equal(updated.settings_update_resp.accepted,true);
 const saved=await settings();
 assert.equal(saved.customProviders[0].requestFormat,'openai-completions');
 assert.equal(saved.customProviders[0].promptCacheHintMode,'none');
 const stale=await agent({settings_update:{settings_json:JSON.stringify({settingsSyncProtocol:initial.settingsSyncProtocol,configurationRevision:initial.configurationRevision,customProviders:providers})}},'settings.stale');
 assert.equal(stale.settings_update_resp.accepted??false,false);
 await agent({provider_models:{provider_type:'codex',provider_id:'relay-key-11',request_format:'openai-completions'}},'models.refresh');
 const skills=await agent({skill_manage:{payload_json:JSON.stringify({action:'list'})}},'skills.list');
 assert.match(skills.skill_manage_resp.result_json,/zeroagent-code-review/);
 await agent({cron_manage:{action:'snapshot'}},'cron.list');
 await agent({memory_manage:{command:'memory_overview',args_json:'{}'}},'memory.overview');
 const native=await rpc.target.invoke('settings_load_all');
 const workdir=native.defaultWorkdir;
 assert.ok(workdir.includes('two-client-remote-20261028'));
 await agent({fs_list:{workdir,path:"",depth:1,max_results:20}},'files.list');
 let conversation='';
 const previousIds=new Set(((await agent({history_list:{page:1,page_size:100}},'history.before-new-chat')).history_list_resp.conversations||[]).map(c=>c.id));
 const command={type:'chat.submit',request:{conversation_id:'',message:'remote native synthetic message',selected_model:{custom_provider_id:'relay-key-11',provider_type:'codex',model:'gpt-qa-local'},workdir,execution_mode:'tools',client_request_id:'once-qa-native-'+Date.now(),command_safety_mode:'ask'}};
 await rpc.request({chat_prepare:{reason:'qa-native-runtime'}},'chat.prepare');
 const accepted=await rpc.request({chat_command:command},'chat.submit');
 assert.ok(accepted.chat_accepted.run_id);
 const duplicate=await rpc.request({chat_command:command},'chat.deduplicate');
 assert.equal(duplicate.chat_accepted.deduped,true);
 let content='';
 let replay=[];
 for(let i=0;i<20;i++){
  await new Promise(r=>setTimeout(r,250));
  if(!conversation){const h=await agent({history_list:{page:1,page_size:100}},'history.find-new-chat');conversation=rpc.buffered.find(row=>row.chat_command_update?.run_id===accepted.chat_accepted.run_id&&row.chat_command_update?.conversation_id)?.chat_command_update.conversation_id||h.history_list_resp.conversations?.find(c=>!previousIds.has(c.id))?.id||'';if(conversation){const sub=await rpc.request({chat_subscribe:{conversation_id:conversation}},'chat.subscribe');replay=sub.chat_subscribed.events_json||[];}else continue;}
  try{const h=await agent({history_get:{conversation_id:conversation,max_messages:100}},'history.get');content=h.history_get_resp.messages_json;if(content.includes('QA remote response:'))break;}catch(e){if(!/not found|不存在/.test(e.message))throw e;}
 }
 if(!content.includes('QA remote response:'))console.log('CHAT DIAGNOSTICS '+JSON.stringify(rpc.buffered.filter(row=>row.chat_command_update||row.chat_activity||row.chat_event)));
 assert.match(content,/QA remote response:/);
 assert.ok(rpc.buffered.some(frame=>frame.chat_event)||replay.length>0,'real streamed/replayed events passed both Native bridges');
 const renamed=await agent({history_rename:{conversation_id:conversation,title:'QA renamed remote history'}},'history.rename');
 assert.equal(renamed.history_rename_resp.conversation.title,'QA renamed remote history');
 const pinned=await agent({history_pin:{conversation_id:conversation,is_pinned:true}},'history.pin');
 assert.equal(pinned.history_pin_resp.conversation.is_pinned,true);
 await agent({history_set_cwd:{conversation_id:conversation,cwd:workdir}},'history.cwd');
 await agent({history_delete:{conversation_id:conversation}},'history.delete');
 const after=await agent({history_list:{page:1,page_size:100}},'history.list-after-delete');
 assert.ok(!(after.history_list_resp.conversations||[]).some(c=>c.id===conversation));
 console.log('NATIVE E2E MATRIX PASS');
}finally{await rpc.close()}
