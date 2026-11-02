import type { Highlighter } from "shiki";
import { EncodedTokenMetadata, INITIAL } from "shiki/textmate";
import type * as Monaco from "./monacoEditor";
import { normalizeSourceLanguage } from "./sourceLanguages";
import { getSyntaxHighlighter } from "./syntaxHighlighter";

export const SOURCE_LANGUAGE_PREFIX = "zeroagent-source-";
const themes = ["github-light", "github-dark"] as const;
const pending = new Map<string, Promise<string>>();
const installedThemes = new WeakSet<object>();
const providers = new Map<
  string,
  { provider: Monaco.languages.TokensProvider; dispose: Monaco.IDisposable }
>();

export function refreshSourceSyntax(monaco: typeof Monaco) {
  for (const [id, entry] of providers) {
    entry.dispose.dispose();
    entry.dispose = monaco.languages.setTokensProvider(id, entry.provider);
  }
}

class SourceState implements Monaco.languages.IState {
  constructor(readonly stack = INITIAL) {}
  clone() {
    return new SourceState(this.stack);
  }
  equals(other: Monaco.languages.IState) {
    return other instanceof SourceState && this.stack.equals(other.stack);
  }
}

function fontStyle(bits: number) {
  return [
    bits & 1 ? "italic" : "",
    bits & 2 ? "bold" : "",
    bits & 4 ? "underline" : "",
    bits & 8 ? "strikethrough" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
function hexColor(color: string) {
  const hex = color.replace("#", "").toLowerCase();
  return hex.length === 3 || hex.length === 4
    ? [...hex].map((value) => value + value).join("")
    : hex;
}
function scope(color: string, style: number) {
  return `za-source-${hexColor(color)}-${style & 15}`;
}

/** Only namespaced source tokens are added. Built-in editor themes and services keep their rules. */
function installColors(engine: Highlighter, monaco: typeof Monaco) {
  if (installedThemes.has(monaco)) return;
  const colors = new Set(
    themes.flatMap((theme) => engine.setTheme(theme).colorMap).filter(Boolean),
  );
  const rules = [...colors].flatMap((color) =>
    Array.from({ length: 16 }, (_, style) => ({
      token: scope(color, style),
      foreground: hexColor(color),
      fontStyle: fontStyle(style),
    })),
  );
  monaco.editor.defineTheme("vs", { base: "vs", inherit: true, rules, colors: {} });
  monaco.editor.defineTheme("vs-dark", { base: "vs-dark", inherit: true, rules, colors: {} });
  installedThemes.add(monaco);
}

export async function prepareSourceSyntax(language: string, monaco: typeof Monaco) {
  const id = normalizeSourceLanguage(language);
  if (!id || id === "plaintext") return "plaintext";
  const cached = pending.get(id);
  if (cached) return cached;
  const task = (async () => {
    const engine = await getSyntaxHighlighter();
    await engine.loadLanguage(id as Parameters<Highlighter["loadLanguage"]>[0]);
    installColors(engine, monaco);
    const modelLanguage = SOURCE_LANGUAGE_PREFIX + id;
    if (!monaco.languages.getLanguages().some((language) => language.id === modelLanguage))
      monaco.languages.register({ id: modelLanguage });
    const provider: Monaco.languages.TokensProvider = {
      getInitialState: () => new SourceState(),
      tokenize(line, state) {
        // Bound expensive single-line grammar work while keeping every character readable.
        if (line.length > 20_000)
          return { endState: state, tokens: [{ startIndex: 0, scopes: "" }] };
        const { colorMap } = engine.setTheme(
          document.documentElement.classList.contains("dark") ? themes[1] : themes[0],
        );
        const result = engine
          .getLanguage(id)
          .tokenizeLine2(line, (state as SourceState).stack, 100);
        const tokens = [];
        for (let i = 0; i < result.tokens.length; i += 2) {
          const metadata = result.tokens[i + 1];
          const color = colorMap[EncodedTokenMetadata.getForeground(metadata)];
          tokens.push({
            startIndex: result.tokens[i],
            scopes: color ? scope(color, EncodedTokenMetadata.getFontStyle(metadata)) : "",
          });
        }
        return { endState: new SourceState(result.ruleStack), tokens };
      },
    };
    providers.set(modelLanguage, {
      provider,
      dispose: monaco.languages.setTokensProvider(modelLanguage, provider),
    });
    return modelLanguage;
  })().catch((error) => {
    pending.delete(id);
    // Grammar initialization only: never log original text or resource paths.
    console.warn("[ZeroAgent] Syntax grammar initialization failed", error);
    throw error;
  });
  pending.set(id, task);
  return task;
}
