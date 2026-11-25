import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("conversation search preserves ordering, navigation, draft opening and stale request guards", async () => {
  let env;
  const pending = [];
  env = await createDomTestEnv({ mocks: {
    "../IconSet": new Proxy({}, {get: () => () => null}),
    "@liveagent/ui/components/IconSet": Object.fromEntries(["Clock3", "Loader2", "MessageSquareText", "Pin", "Search", "X"].map(name => [name, () => null])),
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key, locale: "en" }) },
    "@liveagent/ui/lib/chat/conversationSearch": { searchPersistedConversations: args => new Promise((resolve, reject) => pending.push({ args, resolve, reject })) },
  }});
  const { React, act, createRoot } = env;
  HTMLElement.prototype.scrollIntoView = () => {};
  const { ConversationSearchDialog } = env.loadModule("@liveagent/ui/components/chat/ConversationSearchDialog.tsx");
  const { getSearchJumpTargetSnapshot } = env.loadModule("@liveagent/ui/lib/chat/searchJumpTarget.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const events = [];
  const props = { open: true, currentWorkdir: "/project", conversations: [
    { id: "recent", title: "Recent", isPending: true },
    { id: "pinned", title: "Pinned", isPinned: true },
  ], onOpenChange: value => events.push(["open", value]), onSelectConversation: (...args) => events.push(["select", ...args]) };
  const render = changes => act(async () => root.render(React.createElement(ConversationSearchDialog, { ...props, ...changes })));
  const input = () => document.querySelector("input");
  const options = () => [...document.querySelectorAll('[role="option"]')];
  const key = (value, modifiers = {}) => act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: value, ...modifiers, bubbles: true, cancelable: true })));
  const type = value => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const debounce = () => act(async () => new Promise(resolve => setTimeout(resolve, 210)));
  try {
    await render();
    assert.deepEqual(options().map(el => el.textContent), ["Pinned", "Recent"]);
    await key("ArrowUp");
    assert.equal(options()[0].hasAttribute("data-highlighted"), true);
    await key("ArrowDown"); await key("ArrowDown");
    assert.equal(options()[1].hasAttribute("data-highlighted"), true);
    await key("Enter", { isComposing: true });
    assert.deepEqual(events, [], "confirming IME composition must not open a conversation");
    await key("Home");
    assert.equal(options()[1].hasAttribute("data-highlighted"), true);
    await key("Enter");
    assert.deepEqual(events, [["open", false], ["select", "recent", undefined]]);
    events.length = 0;
    await type("first"); await debounce();
    await type("second"); await debounce();
    assert.deepEqual(pending.map(p => p.args), [{ query: "first", currentWorkdir: "/project" }, { query: "second", currentWorkdir: "/project" }]);
    await act(async () => pending[0].resolve([{ id: "stale", title: "Stale" }]));
    assert.equal(options().length, 0);
    await act(async () => pending[1].resolve([{ id: "z", title: "Z", messageId: "matched-message" }, { id: "a", title: "A" }]));
    assert.deepEqual(options().map(el => el.textContent), ["Z", "A"]);
    await key("Enter");
    assert.deepEqual(events[0], ["open", false]);
    assert.deepEqual(events[1].slice(0, 2), ["select", "z"]);
    assert.equal(events[1][2].source, "search");
    assert.equal(getSearchJumpTargetSnapshot(), null);
    events[1][2].afterCommit();
    assert.equal(getSearchJumpTargetSnapshot()?.messageId, "matched-message");
    await type("failure"); await debounce();
    await act(async () => pending[2].reject(new Error("offline")));
    const retry = [...document.querySelectorAll("button")].find(el => el.textContent === "chat.retryConversationSearch");
    assert.ok(retry);
    await act(async () => retry.click());
    assert.equal(pending.length, 4);
    assert.equal(document.activeElement, input());
    await render({ open: false });
    await act(async () => pending[3].resolve([{ id: "late", title: "Late" }]));
    await render();
    assert.equal(input().value, "");
    assert.deepEqual(options().map(el => el.textContent), ["Pinned", "Recent"]);
    events.length = 0;
    await act(async () => options()[0].click());
    assert.deepEqual(events, [["open", false], ["select", "pinned", { source: "search" }]]);
    events.length = 0;
    await key("Escape");
    assert.deepEqual(events, [["open", false]], "Escape closes the search once");

    const pages = [];
    const adapter = {
      search: (query, { cursor }) => new Promise((resolve, reject) => pages.push({ query, cursor, resolve, reject })),
      onSelectResult: (item) => events.push(["result", item.id]),
    };
    await render({ open: false, searchAdapter: adapter });
    await render({ searchAdapter: adapter });
    await type("project"); await debounce();
    await act(async () => pages[0].resolve({ items: [{ id: "first", title: "First" }], hasMore: true, nextCursor: "cursor-1" }));
    const more = [...document.querySelectorAll("button")].find(el => el.textContent === "Load more");
    assert.ok(more);
    more.focus();
    await act(async () => more.click());
    assert.equal(document.activeElement, more);
    assert.equal(more.getAttribute("aria-disabled"), "true");
    await act(async () => more.click());
    assert.equal(pages.length, 2);
    await act(async () => pages[1].reject(new Error("offline")));
    assert.equal(document.activeElement, more);
    assert.equal(more.textContent, "chat.retryConversationSearch");
    assert.equal(options()[0].textContent, "First");
    await act(async () => more.click());
    assert.deepEqual(pages.map(page => [page.query, page.cursor]), [
      ["project", undefined], ["project", "cursor-1"], ["project", "cursor-1"],
    ]);
    await act(async () => pages[2].resolve({ items: [{ id: "last", title: "Last" }] }));
    assert.deepEqual(options().map(el => el.textContent), ["First", "Last"]);
    assert.equal(document.activeElement, input());
    await act(async () => document.querySelector('[aria-label="chat.clearConversationSearch"]').click());
    assert.equal(input().value, "");
    assert.deepEqual(options().map(el => el.textContent), ["Pinned", "Recent"]);
    events.length = 0;
    await act(async () => [...document.querySelectorAll("button")].find(el => el.textContent === "chat.conversationSearchClose").click());
    assert.deepEqual(events, [["open", false]]);
  } finally {
    await act(async () => root.unmount()); host.remove(); env.cleanup();
  }
});

test("palette scopes commands, conversations and file results to the current authorization", async () => {
  const searches = [];
  const listings = [];
  const selected = [];
  const env = await createDomTestEnv({
    mocks: {
      "../IconSet": new Proxy({}, { get: () => () => null }),
      "@liveagent/ui/components/IconSet": Object.fromEntries(
        ["Clock3", "File", "Loader2", "MessageSquareText", "Pin", "Search", "X"].map(
          (name) => [name, () => null],
        ),
      ),
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key, locale: "en" }) },
      "@liveagent/ui/lib/chat/conversationSearch": {
        searchPersistedConversations: async ({ query }) => {
          searches.push(query);
          return [{ id: "conversation", title: "Notes" }];
        },
      },
    },
  });
  const { React, act, createRoot } = env;
  HTMLElement.prototype.scrollIntoView = () => {};
  const { ConversationSearchDialog } = env.loadModule(
    "@liveagent/ui/components/chat/ConversationSearchDialog.tsx",
  );
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const makePalette = (scopeKey, valid = true) => ({
    scopeKey,
    getActions: () => [{ id: "open-settings", group: "suggested", label: "Settings", run: () => selected.push("settings") }],
    files: valid ? {
      scopeKey,
      listFiles: (signal) => new Promise((resolve) => listings.push({ scopeKey, signal, resolve })),
      openFile: (path) => selected.push(`${scopeKey}:${path}`),
    } : undefined,
  });
  const render = (palette) => act(async () => root.render(React.createElement(ConversationSearchDialog, {
    open: true,
    conversations: [],
    onOpenChange: () => {},
    onSelectConversation: (id) => selected.push(id),
    palette,
  })));
  const type = (value) => act(async () => {
    const input = document.querySelector("input");
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const options = () => [...document.querySelectorAll('[role="option"]')];
  const file = (path, hidden = false) => ({ kind: "file", path, hidden });
  try {
    await render(makePalette("account-a/device-a/project-a"));
    await type(">sett");
    assert.deepEqual(options().map((element) => element.textContent), ["Settings"]);
    await act(async () => options()[0].click());
    await type("@report");
    assert.equal(listings.length, 1);
    assert.equal(document.body.textContent.includes("chat.commandPalette.filesLoading"), true);
    let currentDevice = true;
    await render({ ...makePalette("account-a/device-b/project-b"), isCurrent: () => currentDevice });
    assert.equal(listings[0].signal.aborted, true);
    assert.equal(listings.length, 2);
    await act(async () => listings[0].resolve({ entries: [file("report-secret.md")], truncated: false }));
    assert.deepEqual(options(), []);
    await act(async () => listings[1].resolve({
      entries: [file("docs/report.md"), file("../report-escape.md"), file("C:\\report-local.md"), file("report-hidden.md", true)],
      truncated: false,
    }));
    assert.deepEqual(options().map((element) => element.textContent), ["docs/report.md"]);
    await type("@report md");
    assert.equal(listings.length, 2, "typing reuses the file index within the open scope");
    currentDevice = false;
    await act(async () => options()[0].click());
    assert.deepEqual(selected, ["settings"], "a displayed result cannot act after device authority changes");
    currentDevice = true;
    await act(async () => options()[0].click());
    assert.deepEqual(selected, ["settings", "account-a/device-b/project-b:docs/report.md"]);
    assert.deepEqual(searches, []);
    await render(makePalette("account-a/device-b/project-b", false));
    assert.deepEqual(options(), []);
    assert.equal(document.body.textContent.includes("chat.commandPalette.filesUnavailable"), true);
    await type("#notes");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 210)));
    assert.deepEqual(searches, ["notes"]);
    assert.deepEqual(options().map((element) => element.textContent), ["Notes"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});
