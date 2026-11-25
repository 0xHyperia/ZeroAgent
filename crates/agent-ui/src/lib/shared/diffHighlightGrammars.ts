// Production builds load the diff engine without its syntax grammars (see
// crates/agent-ui/build/lazyDiffGrammars.ts) and publish a loader under this
// key once the engine module has evaluated. Elsewhere (dev server, node tests)
// the grammars are registered eagerly and there is nothing to wait for.
const LOADER_KEY = Symbol.for("liveagent.diffHighlightGrammars");
declare const __ZEROAGENT_EMBEDDED_DESKTOP__: boolean | undefined;

export function loadDiffHighlightGrammars(): Promise<void> {
  // Each embedded workbench already has local grammars. Never use the host app's
  // loader from an embedded runtime factory.
  if (typeof __ZEROAGENT_EMBEDDED_DESKTOP__ !== "undefined" && __ZEROAGENT_EMBEDDED_DESKTOP__) {
    return Promise.resolve();
  }
  const load = (globalThis as Record<symbol, (() => Promise<void>) | undefined>)[LOADER_KEY];
  return load ? load() : Promise.resolve();
}
