import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { ChatCommandPipeline } = loader.loadModule("src/lib/chat/stream/chatCommandPipeline.ts");
const { createGatewayChatCommandActions } = loader.loadModule("src/app/gatewayChatCommandActions.ts");
const { sendComposerCommandTurn } = loader.loadModule("src/app/sendComposerCommandTurn.ts");
const { normalizeSettings } = loader.loadModule("src/lib/settings/index.ts");
const deferred = () => {
  let resolve;
  return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) };
};
const accepted = { runId: "r", conversationId: "c", acceptedSeq: 0 };
const failed = { runId: "r", conversationId: "c", clientRequestId: "req", phase: "failed", errorCode: "conversation_busy", message: "busy" };
function fixture() {
  const errors = [], optimistic = [];
  const pipeline = new ChatCommandPipeline({ getTranscriptStore: () => ({
    addOptimisticUserEntry: e => optimistic.push(e), removeOptimisticUserEntry() {},
    appendLocalError: e => errors.push(e),
  }) });
  return { pipeline, errors, optimistic };
}

for (const before of [false, true]) test(`composer rejection ${before ? "before" : "after"} acceptance restores caller without transcript pollution`, async () => {
  const f = fixture(), ack = deferred(); let settled = false;
  const result = f.pipeline.submit({ conversationId: "c", clientRequestId: "req", message: "/goal task", waitForStart: true, optimistic: false, submit: () => ack.promise }).then(v => { settled = true; return v; });
  if (before) f.pipeline.handleCommandUpdate(failed);
  ack.resolve(accepted); await Promise.resolve(); await Promise.resolve();
  if (!before) { assert.equal(settled, false); f.pipeline.handleCommandUpdate(failed); }
  assert.equal((await result).errorCode, "conversation_busy");
  assert.deepEqual(f.errors, []); assert.deepEqual(f.optimistic, []); assert.equal(f.pipeline.hasPending("c"), false);
});

test("composer start ignores foreign runs and resolves once on its own run", async () => {
  const {pipeline} = fixture(); let settled = false;
  const result = pipeline.submit({ conversationId: "c", clientRequestId: "req", message: "/plan task", waitForStart: true, submit: async () => accepted }).then(v => { settled = true; return v; });
  await Promise.resolve();pipeline.handleRunSignal("c", "foreign", "other");await Promise.resolve();assert.equal(settled,false);
  pipeline.handleRunSignal("c", "r", "req", false);await Promise.resolve();assert.equal(settled,false);
  pipeline.handleRunSignal("c", "r", "req");assert.equal((await result).kind,"settled");pipeline.reset();
});

test("ordinary messages still return immediately and keep their optimistic echo", async () => {
  const f=fixture();assert.equal((await f.pipeline.submit({conversationId:"c",clientRequestId:"req",message:"ordinary",submit:async()=>accepted})).kind,"accepted");assert.equal(f.optimistic.length,1);f.pipeline.reset();
});

test("a scoped follow-up can join a device queue before the first command starts", async (t) => {
  const { pipeline, optimistic } = fixture();
  t.after(() => pipeline.reset());
  const commands = [];
  const refreshed = [];
  const cleared = [];
  const conversationId = "task-conversation";
  const { sendChat } = createGatewayChatCommandActions({
    activeProviders: [],
    api: {
      captureActiveAgentScope: () => () => true,
      chatCommand: async (command) => {
        commands.push(command);
        return { runId: command.clientRequestId, conversationId, acceptedSeq: 0 };
      },
    },
    chatCommandPipeline: pipeline,
    clearCachedComposerDraft: (id) => cleared.push(id),
    conversationWorkdirsRef: { current: new Map() },
    isAgentMode: true,
    isDisplayedConversation: () => false,
    isLocalDraftConversationId: () => false,
    prepareChatRuntime: async () => {},
    protectedConversationRef: { current: "" },
    refreshChatQueueSnapshot: (id) => refreshed.push(id),
    selectionForConversation: () => undefined,
    sendChatRef: { current: null },
    setChatError: () => {},
    settings: normalizeSettings({}),
    sidebarStore: { peek: () => undefined },
  });
  const scope = { conversationId, preserveComposerOnStart: true };
  await sendChat("first", { ...scope, clientRequestId: "first" });
  assert.equal(pipeline.hasPending(conversationId), true);
  assert.equal(await sendChat("duplicate direct submit", scope), null);

  const followup = await sendChat("follow-up", {
    ...scope,
    clientRequestId: "second",
    workdir: "D:/project",
    queuePolicy: "append",
    optimisticEcho: false,
  });
  assert.equal(followup.kind, "accepted");
  assert.deepEqual(commands.map(({ conversationId, message, queuePolicy }) => ({
    conversationId, message, queuePolicy,
  })), [
    { conversationId, message: "first", queuePolicy: "auto" },
    { conversationId, message: "follow-up", queuePolicy: "append" },
  ]);
  assert.deepEqual(refreshed, [conversationId]);
  assert.deepEqual(cleared, []);
  assert.deepEqual(optimistic.map(({ text }) => text), ["first"]);
  pipeline.handleRunSignal(conversationId, "second", "second");
  assert.equal(pipeline.hasPending(conversationId), true);
  pipeline.handleRunSignal(conversationId, "first", "first");
  assert.equal(pipeline.hasPending(conversationId), false);
});

test("a new conversation binds before waiting for its actual start", async () => {
  const {pipeline}=fixture();
  const result=pipeline.submit({conversationId:"draft",clientRequestId:"req",message:"/plan task",waitForStart:true,submit:async()=>accepted});
  await Promise.resolve();
  assert.equal(pipeline.resolveConversationId("draft"),"c");assert.equal(pipeline.hasPending("c"),true);
  pipeline.handleRunSignal("c","r","req");assert.equal((await result).kind,"settled");
});

test("single plan command is explicit and busy errors are localized", async () => {
  const calls=[];
  await assert.rejects(sendComposerCommandTurn(async(text,options)=>{calls.push(options);return {kind:"failed",errorCode:"conversation_busy",message:"raw"}},k=>k,"/plan task",{kind:"plan"},{isBusy:()=>false,runtimeControls:{planModeEnabled:true}}),/chat.commands.busy/);
  assert.equal(calls[0].planCommand,true);assert.equal(calls[0].promptCommand,undefined);assert.equal(calls[0].waitForStart,true);assert.equal(calls[0].optimisticEcho,false);
});

test("disconnect leaves startup pending for a replayed rejection, reset releases the waiter", async()=>{
 const {pipeline}=fixture();let submissions=0;const result=pipeline.submit({conversationId:"c",clientRequestId:"req",message:"/goal task",waitForStart:true,submit:async()=>{submissions++;if(submissions===2)queueMicrotask(()=>pipeline.handleCommandUpdate(failed));return accepted;}});await Promise.resolve();pipeline.resumePendingCommands();assert.equal((await result).kind,"failed");assert.equal(submissions,2);
 const next=pipeline.submit({conversationId:"c",clientRequestId:"req2",message:"/goal other",waitForStart:true,submit:async()=>({...accepted,runId:"r2"})});await Promise.resolve();pipeline.reset();assert.equal((await next).kind,"settled");
});
