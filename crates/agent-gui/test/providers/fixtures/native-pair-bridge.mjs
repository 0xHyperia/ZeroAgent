let sequence=0;
export async function bridge(port){
 const ws=new WebSocket(`ws://127.0.0.1:${port}`);
 const pending=new Map();
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
 ws.addEventListener('message',({data})=>{
  let reply;try{reply=JSON.parse(data)}catch{return}
  const job=pending.get(reply.id);if(!job)return;
  pending.delete(reply.id);clearTimeout(job.timer);
  reply.success?job.resolve(reply.data):job.reject(new Error(reply.error||'Bridge request failed'));
 });
 ws.addEventListener('close',()=>{for(const job of pending.values()){clearTimeout(job.timer);job.reject(new Error('Bridge reloaded or closed'))}pending.clear()});
 const client = {
  request(command,args){return new Promise((resolve,reject)=>{const id=`qa-${++sequence}`;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Bridge timeout '+command))},45000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,command,args}))})},
  async js(script){return this.request('execute_js',{script,windowLabel:'main'})},
  async invoke(command,args={}){return this.js(`return await window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`)},
  close(){ws.close()}
 };
 // The repository does not grant the optional inspection plugin IPC permission.
 // Carry its test result over the already-allowed Tauri event API instead; no
 // application command, credentials or capability metadata is changed.
 await client.js('const api = window.__TAURI__; window.__TAURI__ = {...api,core:{...api.core,invoke:(command,args)=> command === "plugin:mcp-bridge|script_result" ? api.event.emit("__script_result",{exec_id:args.execId,success:args.success,data:args.data,error:args.error}) : api.core.invoke(command,args)}}; return {ready:true};');
 return client;
}
if(process.argv[1]?.endsWith('bridge.mjs')){
 const client=await bridge(Number(process.argv[2]));
 try{console.log(JSON.stringify(await client.js(process.argv[3]||'return {isolated:true,ready:!!window.__TAURI__,origin:location.origin}')))}finally{client.close()}
}
