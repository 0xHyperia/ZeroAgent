import type { Highlighter } from "shiki";
import { EncodedTokenMetadata, INITIAL } from "shiki/textmate";
import type * as Monaco from "./monacoEditor";
import { normalizeSourceLanguage, resolveSourceLanguage } from "./sourceLanguages";
import { getSyntaxHighlighter, SOURCE_DARK_THEME, SOURCE_LIGHT_THEME } from "./syntaxHighlighter";

export const SOURCE_LANGUAGE_PREFIX = "zeroagent-source-";
const themes = [SOURCE_LIGHT_THEME, SOURCE_DARK_THEME] as const;
const pending = new Map<string, Promise<string>>();
const installedThemes = new WeakMap<object, string[]>();
const workspaceSyntax = new WeakSet<object>();
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

/** Only namespaced source styles are added to the Monaco themes. */
function installColors(engine: Highlighter, monaco: typeof Monaco) {
  const installed = installedThemes.get(monaco);
  if (installed) return installed;
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
  const tokenTypes = rules.map((rule) => rule.token);
  installedThemes.set(monaco, tokenTypes);
  return tokenTypes;
}

function sourceTheme() {
  return document.documentElement.classList.contains("dark")
    ? SOURCE_DARK_THEME
    : SOURCE_LIGHT_THEME;
}

function tokenizeSourceLine(
  engine: Highlighter,
  language: string,
  line: string,
  state: SourceState,
) {
  // Keep long or minified lines readable without expensive tokenization.
  if (line.length > 20_000) return { endState: state, tokens: [{ startIndex: 0, scopes: "" }] };
  const { colorMap } = engine.setTheme(sourceTheme());
  const result = engine.getLanguage(language).tokenizeLine2(line, state.stack, 100);
  const tokens = [];
  for (let index = 0; index < result.tokens.length; index += 2) {
    const metadata = result.tokens[index + 1];
    const color = colorMap[EncodedTokenMetadata.getForeground(metadata)];
    tokens.push({
      startIndex: result.tokens[index],
      scopes: color ? scope(color, EncodedTokenMetadata.getFontStyle(metadata)) : "",
    });
  }
  return { endState: new SourceState(result.ruleStack), tokens };
}

export function enableWorkspaceSourceSyntax(monaco: typeof Monaco) {
  if (workspaceSyntax.has(monaco)) return;
  workspaceSyntax.add(monaco);
  void getSyntaxHighlighter()
    .then((engine) => {
      const tokenTypes = installColors(engine, monaco);
      const tokenIds = new Map(tokenTypes.map((name, index) => [name, index]));
      // Color the actual file grammar without changing the model ID used by Monaco's workers.
      monaco.languages.registerDocumentSemanticTokensProvider(
        { scheme: "liveagent-editor" },
        {
          getLegend: () => ({ tokenTypes, tokenModifiers: [] }),
          async provideDocumentSemanticTokens(model, _lastResultId, signal) {
            const lineCount = model.getLineCount();
            if (lineCount > 10_000 || model.getValueLength() > 512 * 1024) return null;
            const language = resolveSourceLanguage(model.uri.path, "", model.getLineContent(1));
            if (language === "plaintext") return null;

            const version = model.getVersionId();
            const theme = sourceTheme();
            const stale = () =>
              signal.isCancellationRequested ||
              model.isDisposed() ||
              model.getVersionId() !== version ||
              sourceTheme() !== theme;
            try {
              await engine.loadLanguage(language as Parameters<Highlighter["loadLanguage"]>[0]);
            } catch {
              return null;
            }
            if (stale()) return null;

            const data: number[] = [];
            let state = new SourceState();
            let previousLine = 0;
            let previousStart = 0;
            let yieldAt = performance.now() + 12;
            for (let line = 0; line < lineCount; line += 1) {
              if (performance.now() >= yieldAt) {
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                if (stale()) return null;
                yieldAt = performance.now() + 12;
              }
              const text = model.getLineContent(line + 1);
              const { tokens, endState } = tokenizeSourceLine(engine, language, text, state);
              state = endState;
              for (const [index, token] of tokens.entries()) {
                const id = tokenIds.get(token.scopes);
                const start = token.startIndex;
                const length = (tokens[index + 1]?.startIndex ?? text.length) - start;
                if (id === undefined || length <= 0) continue;
                data.push(
                  line - previousLine,
                  line === previousLine ? start - previousStart : start,
                  length,
                  id,
                  0,
                );
                previousLine = line;
                previousStart = start;
              }
            }
            return stale() ? null : { data: Uint32Array.from(data) };
          },
          releaseDocumentSemanticTokens() {},
        },
      );
    })
    .catch(() => {
      // Keep the native tokenizer and allow a later editor to retry initialization.
      workspaceSyntax.delete(monaco);
    });
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
      tokenize: (line, state) => tokenizeSourceLine(engine, id, line, state as SourceState),
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
