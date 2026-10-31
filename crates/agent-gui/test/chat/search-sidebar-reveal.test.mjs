import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import React from "react";

let dialogProps;
const scrolls = [];
const virtualizer = {
  getVirtualItems: () => [],
  getTotalSize: () => 3200,
  scrollToIndex: (index) => scrolls.push(index),
  measureElement() {},
};
const icons = [
  "AlertCircle",
  "Blend",
  "Brain",
  "Cable",
  "Check",
  "ChevronRight",
  "CirclePlus",
  "Clock3",
  "CalendarDays",
  "Folder",
  "FolderClosed",
  "FolderOpen",
  "ImageIcon",
  "ListChecks",
  "Loader2",
  "MessageSquare",
  "PanelLeft",
  "PanelLeftClose",
  "Plus",
  "Search",
  "Settings",
  "Share2",
  "SquarePen",
  "Trash2",
  "X",
];
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": Object.fromEntries(icons.map((name) => [name, () => null])),
    "@liveagent/ui/components/ui/button": {
      Button: ({ children, onClick, ...props }) =>
        React.createElement(
          "button",
          { onClick, "aria-expanded": props["aria-expanded"], "data-testid": props["data-testid"] },
          children,
        ),
    },
    "@liveagent/ui/components/ui/confirm-dialog": {
      useConfirmDialog: () => ({ requestConfirmDialog: async () => false }),
    },
    "@liveagent/ui/components/ui/dropdown-menu": Object.fromEntries(
      ["DropdownMenu", "DropdownMenuContent", "DropdownMenuItem", "DropdownMenuTrigger"].map(
        (name) => [name, ({ children }) => React.createElement("div", null, children)],
      ),
    ),
    "@liveagent/ui/components/ui/input": { Input: (props) => React.createElement("input", props) },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key, locale: "en" }) },
    "@tanstack/react-virtual": { useVirtualizer: () => virtualizer },
    "./ChatHistorySidebarRows": {
      HistoryRow: () => null,
      ProjectRow: () => null,
      ProjectGroupHeader: () => null,
    },
    "./ConversationSearchDialog": {
      ConversationSearchDialog: (props) => {
        dialogProps = props;
        return null;
      },
    },
  },
});
const { act, createRoot } = env;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
HTMLElement.prototype.scrollTo = () => {};
const { ChatHistorySidebar } = env.loadModule(
  "@liveagent/ui/components/chat/ChatHistorySidebar.tsx",
);
// 侧栏现在基于 ui/sidebar 壳（需要 SidebarProvider 上下文）。
const { SidebarProvider } = env.loadModule("@liveagent/ui/components/ui/sidebar.tsx");
const renderSidebar = (props) =>
  React.createElement(SidebarProvider, null, React.createElement(ChatHistorySidebar, props));
const items = Array.from({ length: 100 }, (_, index) => ({
  id: String(index),
  title: String(index),
  cwd: "/repo/b",
  createdAt: 1,
  updatedAt: index,
  providerId: "p",
  model: "m",
}));

test("search completion reveals a collapsed virtual list once without saving sidebar preferences", async () => {
  const container = document.createElement("div"),
    root = createRoot(container);
  let props = {
    items,
    currentConversationId: "a",
    busyConversationIds: new Map(),
    runningConversationIds: new Set(),
    listStatus: "ready",
    scopeKey: "cwd:/repo/a",
    totalItems: 100,
    hasMore: false,
    isLoadingMore: false,
    isOpen: true,
    recentCollapsed: true,
    canShareConversations: false,
    renamingId: null,
    renameDraft: "",
    activeProjectId: "a",
    onRecentCollapsedChange: () => assert.fail("search saved sidebar preferences"),
  };
  let completion;
  props.onSelectConversation = (_id, options) => {
    completion = options.afterCommit;
  };
  try {
    await act(async () => root.render(renderSidebar(props)));
    await act(async () => dialogProps.onSelectConversation("99", { source: "search" }));
    assert.equal(scrolls.length, 0);
    props = { ...props, currentConversationId: "99", scopeKey: "cwd:/repo/b", items: [items[99]], listStatus: "syncing" };
    await act(async () => {
      root.render(renderSidebar(props));
      completion();
    });
    assert.deepEqual(scrolls, [], "wait for the target position after the first page arrives");
    props = { ...props, items, listStatus: "ready" };
    await act(async () => root.render(renderSidebar(props)));
    assert.deepEqual(scrolls, [99]);
    const list = container.querySelector(".chat-history-list");
    assert.equal(list.parentElement.getAttribute("aria-hidden"), "false");
    props = { ...props, items: [...items] };
    await act(async () => root.render(renderSidebar(props)));
    assert.deepEqual(
      scrolls,
      [99],
      "background list refresh must not pull the user back to the row",
    );
  } finally {
    await act(async () => root.unmount());
  }
});


test("scroll loading requests one page per boundary, ignores retired observers and retains manual native loading",async()=>{
 const previous=globalThis.IntersectionObserver,observers=[];
 class Observer{constructor(callback,options){this.callback=callback;this.options=options;this.disconnected=false;observers.push(this);}observe(target){this.target=target;}disconnect(){this.disconnected=true;}unobserve(){}takeRecords(){return [];}}
 globalThis.IntersectionObserver=Observer;
 const container=document.body.appendChild(document.createElement("div")),root=createRoot(container);let loads=0;
 let props={items,currentConversationId:"active",busyConversationIds:new Map(),runningConversationIds:new Set(),listStatus:"ready",scopeKey:"lazy:a",totalItems:100,hasMore:true,isLoadingMore:false,isOpen:true,recentCollapsed:false,canShareConversations:false,renamingId:null,renameDraft:"",loadMoreMode:"scroll",onLoadMore:()=>loads++};
 const render=()=>act(async()=>root.render(renderSidebar(props)));
 const current=()=>observers.findLast(observer=>!observer.disconnected&&observer.options?.root?.classList.contains("chat-history-list"));
 try{
   await render();let observer=current();assert.ok(observer);assert.doesNotMatch(container.textContent,/sidebar.continueLoadingHistory/);
   await act(async()=>{observer.callback([{isIntersecting:true}]);observer.callback([{isIntersecting:true}]);});assert.equal(loads,1);
   props={...props,isLoadingMore:true};await render();assert.equal(observer.disconnected,true);
   await act(async()=>observer.callback([{isIntersecting:true}]));assert.equal(loads,1);
   props={...props,isLoadingMore:false,items:[...items]};await render();observer=current();assert.ok(observer);
   await act(async()=>observer.callback([{isIntersecting:true}]));assert.equal(loads,2);
   props={...props,isLoadingMore:true};await render();props={...props,isLoadingMore:false,errorMessage:"offline"};await render();assert.equal(current(),undefined);assert.match(container.textContent,/chat.workspaceHistoryRetry/);
   props={...props,errorMessage:null,loadMoreMode:"manual"};await render();assert.equal(current(),undefined);assert.match(container.textContent,/sidebar.continueLoadingHistory/);
 }finally{await act(async()=>root.unmount());container.remove();if(previous===undefined)delete globalThis.IntersectionObserver;else globalThis.IntersectionObserver=previous;}
});
