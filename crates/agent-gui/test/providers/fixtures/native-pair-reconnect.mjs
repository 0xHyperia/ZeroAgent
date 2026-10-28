import {remoteRpc} from './native-pair-rpc.mjs';
import assert from 'node:assert/strict';
let rpc=await remoteRpc();
try{
 const agent=rpc.agent;
 await rpc.request({agent_request:{history_list:{page:1,page_size:20}}},'history.before-disconnect');
 await rpc.app.js('const events=globalThis.__qaSocketInbox;globalThis.__qaClosedSocket=events;return true;');
 // Retire the actual Native-owned control socket. The old owner cannot send or
 // replay a mutation on a replacement connection.
 const socketIds=await rpc.app.js('return Object.keys(globalThis).filter(key=>key==="__qaSocketInbox");');
 assert.equal(socketIds.length,1);
 await rpc.close();
 await assert.rejects(rpc.request({agent_request:{history_list:{page:1,page_size:20}}},'history.old-socket'),/closed|state|ready|socket|OPEN/i);
 rpc=await remoteRpc();
 assert.equal(rpc.agent,agent);
 await rpc.request({agent_request:{history_list:{page:1,page_size:20}}},'history.after-reconnect');
 const ui=await rpc.target.js('const root=document.getElementById("root");const key=Object.keys(root).find(k=>k.startsWith("__reactContainer"));const stack=[root[key].stateNode.current];let inactive=0;while(stack.length){const f=stack.pop();if(f.memoizedProps?.active===false&&f.memoizedProps?.relayUser)inactive++;if(f.sibling)stack.push(f.sibling);if(f.child)stack.push(f.child)}return {inactiveLocalHosts:inactive,visibleFrames:document.querySelectorAll("[data-app-frame=three-column]").length};');
 assert.ok(ui.inactiveLocalHosts>0);
 assert.equal(ui.visibleFrames,0,'the inactive local workbench must render no frame or dialogs');
 const visible=await rpc.target.js('return [...document.querySelectorAll("[data-slot=sidebar-wrapper]")].filter(n=>getComputedStyle(n).display!=="none").length;');
 assert.equal(visible,1,'only the selected remote workbench owns visible UI');
 console.log('NATIVE RECONNECT AND SINGLE VISIBLE WORKBENCH PASS');
}finally{await rpc.close()}
