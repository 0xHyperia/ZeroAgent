import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("desktop keeps a paged search hit pending until its scroll frame can run", async () => {
  const frames = new Map();
  const jumps = [];
  let settleLayout;
  let nextFrame = 0;
  const noOp = () => {};
  const empty = () => null;
  const handle = { breakFollow: noOp };
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/chat/ChatFileLinkContextMenu": { ChatFileLinkContextMenuHost: empty },
      "@liveagent/ui/components/chat/TranscriptFindBar": { TranscriptFindBar: empty },
      "@liveagent/ui/components/ui/context-menu": { ContextMenuItem: empty, ContextMenuPopup: empty },
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
      "@liveagent/ui/lib/chat-scroll/useScrollFollow": {
        useScrollFollow: () => ({ handle, following: true }),
      },
      "@liveagent/ui/lib/transcript-find/useTranscriptFind": { useTranscriptFind: noOp },
      "@liveagent/ui/pages/chat/transcript/FloorNavRail": { FloorNavRail: empty },
      "@liveagent/ui/pages/chat/transcript/TranscriptWidthControls": { TranscriptWidthControls: empty },
      "./TranscriptList": {
        TranscriptList({ navRef, onFirstLayoutSettled }) {
          env.React.useLayoutEffect(() => {
            settleLayout = onFirstLayoutSettled;
            navRef.current = { scrollToRowKey: (key) => jumps.push(key) };
            return () => {
              navRef.current = null;
            };
          }, [navRef, onFirstLayoutSettled]);
          return null;
        },
      },
    },
  });
  const { React, act, createRoot, loadModule } = env;
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const { ChatTranscript } = loadModule("src/pages/chat/transcript/ChatTranscript.tsx");
  const { getSearchJumpTargetSnapshot, setSearchJumpTarget } = loadModule(
    "@liveagent/ui/lib/chat/searchJumpTarget.ts",
  );
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const tail = Array.from({ length: 120 }, (_, i) => ({ kind: "summary", key: `summary-${i}` }));
  const hit = { kind: "user", key: "earlier-row", messageRef: { messageId: "earlier" } };
  const target = { conversationId: "conversation", messageId: "earlier" };
  let pageReads = 0;
  const props = {
    conversationId: target.conversationId,
    followRef: { current: null },
    hasModels: true,
    onLoadEarlierHistory: async () => {
      pageReads += 1;
    },
  };
  const render = (historyItems, hasMoreHistory) =>
    act(async () =>
      root.render(React.createElement(ChatTranscript, { ...props, historyItems, hasMoreHistory })),
    );
  try {
    await render(tail, true);
    await act(async () => setSearchJumpTarget(target));
    assert.equal(pageReads, 0);
    await act(async () => settleLayout());
    assert.equal(pageReads, 1);

    const expanded = [hit, ...tail];
    await render(expanded, false);
    assert.equal(getSearchJumpTargetSnapshot(), target);
    // A newer projection arrives before paint and cancels the first frame.
    await render([...expanded], false);
    await act(async () => {
      for (const [id, run] of [...frames]) {
        frames.delete(id);
        run(0);
      }
    });
    assert.deepEqual(jumps, ["earlier-row"]);
    assert.equal(getSearchJumpTargetSnapshot(), null);
  } finally {
    await act(async () => root.unmount());
    setSearchJumpTarget(null);
    env.cleanup();
  }
});
