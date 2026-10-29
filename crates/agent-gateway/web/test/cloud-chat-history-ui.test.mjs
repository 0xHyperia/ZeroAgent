import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("the real omitted user row exposes an explicit body read and never edits or copies its placeholder",async(t)=>{
 let env,actions;const opened=[];
 const nullComponent=()=>null;
 env=await createWebDomTestEnv({mocks:{
  "@liveagent/ui/i18n/LocaleContext":{useLocale:()=>({locale:"zh-CN",t:key=>key})},
  "@liveagent/ui/lib/chat/useCommitDetailsLoader":{useCommitDetailsLoader:()=>async()=>null},
  "@liveagent/ui/lib/transcript-virtual/useTranscriptNavigation":{useTranscriptNavigation:()=>{}},
  "@liveagent/ui/components/chat/UserAttachmentCards":{UserAttachmentCards:nullComponent},
  "@liveagent/ui/components/chat/AssistantBubble":{AssistantBubble:nullComponent,LiveAssistantStatus:nullComponent},
  "@liveagent/ui/components/chat/ChatEmptyState":{ChatEmptyState:nullComponent},
  "@liveagent/ui/components/chat/ContextCheckpointCard":{ContextCheckpointCard:nullComponent},
  "@liveagent/ui/components/chat/EditableUserMessageBubble":{EditableUserMessageBubble:nullComponent},
  "@liveagent/ui/components/chat/RetryDetailsBlock":{RetryDetailsBlock:nullComponent},
  "@liveagent/ui/lib/chat/userMessageContent":{UserMessageContent:props=>env.React.createElement("span",null,props.text)},
  "@liveagent/ui/components/chat/TranscriptMessageActions":{
    TranscriptUserMessageActions:props=>{actions=props;return env.React.createElement("button",{disabled:props.editDisabled,title:props.editTitle,onClick:props.onEdit},"编辑");},
    TranscriptAssistantMessageActions:nullComponent,
  },
  "@tanstack/react-virtual":{useVirtualizer:options=>({getVirtualItems:()=>Array.from({length:options.count},(_,index)=>({index,key:options.getItemKey(index),start:index*100,size:100,end:(index+1)*100})),getTotalSize:()=>options.count*100,measureElement:()=>{},scrollToEnd:()=>{},takeSnapshot:()=>[],getSettledScrollOffset:()=>0})},
 }});
 const {GatewayTranscript}=env.loadModule("src/components/GatewayTranscript.tsx");
 const row={key:"source-user",kind:"user",origin:"history",text:"这条消息正文按需加载。",contentOmitted:true,attachments:[],referencedConversations:[],messageRef:{messageId:"source-user",segmentId:"conversation",segmentIndex:0,messageIndex:0,role:"user",contentHash:""}};
 const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 await env.act(async()=>root.render(env.React.createElement(GatewayTranscript,{conversationId:"conversation",rows:[row],onOpenFileLink:link=>opened.push(link),onResendFromEdit:()=>assert.fail("placeholder was edited")})));
 const button=[...host.querySelectorAll("button")].find(node=>node.textContent==="查看消息正文");assert.ok(button);assert.equal(actions.editDisabled,true);assert.equal(actions.copyDisabled,true);assert.match(actions.editTitle,/先读取完整消息/);assert.doesNotMatch(actions.editTitle,/旧历史|缺少稳定/);
 await env.act(async()=>button.click());assert.deepEqual(opened,[{path:"cloud-messages/source-user",source:"relative"}]);
});

test("the real transcript displays only a preview but regeneration uses the intact 2 MiB prompt",async(t)=>{
 let env,userActions,assistantActions,editor;const opened=[],resent=[];const nil=()=>null;
 env=await createWebDomTestEnv({mocks:{
  "@liveagent/ui/i18n/LocaleContext":{useLocale:()=>({locale:"zh-CN",t:key=>key})},
  "@liveagent/ui/lib/chat/useCommitDetailsLoader":{useCommitDetailsLoader:()=>async()=>null},
  "@liveagent/ui/lib/transcript-virtual/useTranscriptNavigation":{useTranscriptNavigation:()=>{}},
  "@liveagent/ui/components/chat/UserAttachmentCards":{UserAttachmentCards:nil},
  "@liveagent/ui/components/chat/AssistantBubble":{AssistantBubble:nil,LiveAssistantStatus:nil},
  "@liveagent/ui/components/chat/ChatEmptyState":{ChatEmptyState:nil},
  "@liveagent/ui/components/chat/ContextCheckpointCard":{ContextCheckpointCard:nil},
  "@liveagent/ui/components/chat/EditableUserMessageBubble":{EditableUserMessageBubble:props=>{editor=props;return env.React.createElement("textarea",{readOnly:true,value:props.initialText});}},
  "@liveagent/ui/components/chat/RetryDetailsBlock":{RetryDetailsBlock:nil},
  "@liveagent/ui/lib/chat/userMessageContent":{UserMessageContent:props=>env.React.createElement("span",null,props.text)},
  "@liveagent/ui/components/chat/TranscriptMessageActions":{
   TranscriptUserMessageActions:props=>{userActions=props;return env.React.createElement("button",{disabled:props.editDisabled,title:props.editTitle,onClick:props.onEdit},"编辑");},
   TranscriptAssistantMessageActions:props=>{assistantActions=props;return env.React.createElement("button",{disabled:props.retryDisabled,onClick:props.onRetry},"重新生成");},
  },
  "@tanstack/react-virtual":{useVirtualizer:options=>({getVirtualItems:()=>Array.from({length:options.count},(_,index)=>({index,key:options.getItemKey(index),start:index*100,size:100,end:(index+1)*100})),getTotalSize:()=>options.count*100,measureElement:()=>{},scrollToEnd:()=>{},takeSnapshot:()=>[],getSettledScrollOffset:()=>0})},
 }});
 const {GatewayTranscript}=env.loadModule("src/components/GatewayTranscript.tsx");
 const {cloudMessageTranscriptPreview}=env.loadModule("src/lib/cloudChatMessagePreview.ts");
 const complete="BEGIN\n"+"0123456789ABCDEFGHIJ\n".repeat(110000)+"END",preview=cloudMessageTranscriptPreview(complete);
 const user={key:"large",kind:"user",origin:"history",text:preview.text+"\n\n"+preview.notice,contentPreview:true,retryText:complete,attachments:[],referencedConversations:[],messageRef:{messageId:"large",segmentId:"conversation",segmentIndex:0,messageIndex:0,role:"user",contentHash:""}};
 const assistant={key:"reply",kind:"assistant",origin:"history",turnKey:"reply",rounds:[{key:"reply-round",round:1,runningToolCallIds:[],blocks:[{kind:"text",id:"answer-text",text:"回答"}]}]};
 const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 await env.act(async()=>root.render(env.React.createElement(GatewayTranscript,{conversationId:"conversation",rows:[user,assistant],onOpenFileLink:link=>opened.push(link),onResendFromEdit:(...args)=>resent.push(args)})));
 assert.ok(host.textContent.length<6000);assert.equal(userActions.editDisabled,true);assert.equal(userActions.copyDisabled,true);assert.match(userActions.editTitle,/消息较长/);assert.doesNotMatch(userActions.editTitle,/请先读取完整|旧历史/);assert.equal(assistantActions.retryDisabled,false);assert.equal(assistantActions.shareSource,undefined);
 await env.act(async()=>[...host.querySelectorAll("button")].find(node=>node.textContent==="分段查看完整正文").click());assert.equal(opened[0].path,"cloud-messages/large");
 await env.act(async()=>[...host.querySelectorAll("button")].find(node=>node.textContent==="重新生成").click());assert.equal(resent.length,1);assert.equal(resent[0][1],complete);assert.equal(resent[0][0].messageId,"large");assert.ok(host.textContent.length<6000);
 assert.equal(editor,undefined,"2 MiB original must not enter an inline editor");
 const medium="中".repeat(8192)+"END_8K",copied=[];
 const moderate={...user,key:"medium",messageRef:{...user.messageRef,messageId:"medium"},text:cloudMessageTranscriptPreview(medium).text+"\n仅显示预览",retryText:medium,inlineEditText:medium,copyContent:async()=>{copied.push(medium);return true;}};
 await env.act(async()=>root.render(env.React.createElement(GatewayTranscript,{conversationId:"conversation",rows:[moderate,assistant],onOpenFileLink:link=>opened.push(link),onResendFromEdit:(...args)=>resent.push(args)})));
 assert.equal(userActions.editDisabled,false);assert.equal(userActions.copyDisabled,false);assert.equal(assistantActions.shareSource.prompt,medium,"ordinary reports keep full-text sharing independently of transcript preview size");await env.act(async()=>{userActions.onCopy();await Promise.resolve();});assert.deepEqual(copied,[medium]);assert.equal(host.querySelector("textarea"),null,"copying full text must not create a hidden editor");
 await env.act(async()=>userActions.onEdit());assert.equal(editor.initialText,medium);assert.equal(host.querySelector("textarea").value,medium);
 await env.act(async()=>editor.onSubmit(medium+"修订",[]));assert.equal(resent.at(-1)[1],medium+"修订");assert.ok(host.textContent.length<12000);
});
