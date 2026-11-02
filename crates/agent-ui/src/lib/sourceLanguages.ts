import { type BundledLanguage, bundledLanguagesInfo } from "shiki/langs";

/** Versioned, complete Shiki catalog; grammar modules remain lazy imports. */
export const sourceLanguages = bundledLanguagesInfo.map(({ id, name, aliases }) => ({
  id: id as BundledLanguage,
  name,
  aliases: (aliases ?? []) as BundledLanguage[],
}));
const byAlias = new Map<string, BundledLanguage>();
for (const language of sourceLanguages)
  for (const alias of [language.id, language.name, ...language.aliases])
    byAlias.set(alias.toLowerCase(), language.id);

export function normalizeSourceLanguage(value: string) {
  const key = value.trim().toLowerCase();
  if (["text", "txt", "plain", "plaintext"].includes(key)) return "plaintext";
  return byAlias.get(key);
}

// Extensions that differ from grammar IDs/aliases, or whose generic aliases are ambiguous.
const extensions: Record<string, string> = {
  pyi: "python",
  pyw: "python",
  ipynb: "json",
  cc: "cpp",
  cxx: "cpp",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  mm: "objective-cpp",
  m: "matlab",
  ex: "elixir",
  exs: "elixir",
  eex: "elixir",
  heex: "html",
  erl: "erlang",
  hrl: "erlang",
  hs: "haskell",
  lhs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  fsx: "fsharp",
  fsi: "fsharp",
  vbnet: "vb",
  r: "r",
  rmd: "markdown",
  raku: "raku",
  pm: "perl",
  pl: "perl",
  pm6: "raku",
  t: "perl",
  psd1: "powershell",
  psm1: "powershell",
  ps1: "powershell",
  bashrc: "shellscript",
  zshrc: "shellscript",
  zshenv: "shellscript",
  ksh: "shellscript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  bat: "bat",
  cmd: "bat",
  sc: "scala",
  cljc: "clojure",
  cljs: "clojure",
  clj: "clojure",
  edn: "clojure",
  cshtml: "razor",
  razor: "razor",
  jsp: "html",
  cts: "typescript",
  mts: "typescript",
  "blade.php": "blade",
  "html.erb": "erb",
  "d.ts": "typescript",
  tf: "terraform",
  tfvars: "terraform",
  tfstate: "json",
  mk: "makefile",
  mak: "makefile",
  cmake: "cmake",
  nix: "nix",
  yml: "yaml",
  cjs: "javascript",
  mjs: "javascript",
  graphqls: "graphql",
  gql: "graphql",
  lock: "plaintext",
  conf: "ini",
  cfg: "ini",
  config: "xml",
  txt: "plaintext",
  text: "plaintext",
  log: "log",
  gitignore: "gitignore",
  editorconfig: "ini",
  npmrc: "ini",
  yarnrc: "yaml",
  service: "systemd",
  socket: "systemd",
  timer: "systemd",
  target: "systemd",
  desktop: "desktop",
  gradle: "groovy",
  ino: "cpp",
  pde: "java",
  hhvm: "hack",
  gd: "gdscript",
  tscn: "gdresource",
  tres: "gdresource",
  comp: "glsl",
  frag: "glsl",
  vert: "glsl",
  geom: "glsl",
  tesc: "glsl",
  tese: "glsl",
  v: "verilog",
  sv: "system-verilog",
  svh: "system-verilog",
  vhd: "vhdl",
  vhdl: "vhdl",
  wat: "wasm",
  s: "asm",
  asm: "asm",
  rst: "rst",
  tex: "latex",
  sty: "latex",
  cls: "latex",
  bib: "bibtex",
  scss: "scss",
  sass: "sass",
  pot: "po",
  gqls: "graphql",
  prisma: "prisma",
  sql: "sql",
  htm: "html",
  xsd: "xml",
  xsl: "xsl",
  xslt: "xsl",
  svg: "xml",
  pom: "xml",
  csproj: "xml",
  fsproj: "xml",
  md: "markdown",
  markdown: "markdown",
  qmd: "markdown",
  adoc: "asciidoc",
};
const filenames: Record<string, string> = {
  makefile: "makefile",
  gnumakefile: "makefile",
  "cmakelists.txt": "cmake",
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  gemfile: "ruby",
  rakefile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  jenkinsfile: "groovy",
  justfile: "just",
  "cargo.lock": "toml",
  "package-lock.json": "json",
  "yarn.lock": "yaml",
  ".gitignore": "plaintext",
  ".gitattributes": "plaintext",
  ".dockerignore": "plaintext",
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zshrc": "shellscript",
  ".zprofile": "shellscript",
  ".profile": "shellscript",
  ".vimrc": "viml",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".prettierrc": "json",
  ".eslintrc": "json",
  "nginx.conf": "nginx",
  "httpd.conf": "apache",
  ".htaccess": "apache",
  ssh_config: "ssh-config",
  sshd_config: "ssh-config",
  codeowners: "codeowners",
};

function knownLanguage(id: string | undefined) {
  return id === "plaintext" ? id : id ? normalizeSourceLanguage(id) : undefined;
}

export function sourceLanguageForName(path: string) {
  const name = path.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
  const exact = knownLanguage(Object.hasOwn(filenames, name) ? filenames[name] : undefined);
  if (exact) return exact;
  if (/^\.env(?:\.|$)/.test(name)) return "dotenv";
  if (/^(?:dockerfile|containerfile)\./.test(name)) return "dockerfile";
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const extension = parts.slice(i).join(".");
    // .wasm is binary, whereas WebAssembly text uses .wat.
    if (extension === "wasm") return undefined;
    const id =
      knownLanguage(Object.hasOwn(extensions, extension) ? extensions[extension] : undefined) ??
      normalizeSourceLanguage(extension);
    if (id) return id;
  }
  return undefined;
}

export function resolveSourceLanguage(name: string, mime = "", text = "") {
  const byName = sourceLanguageForName(name);
  if (byName) return byName;
  const type = mime.toLowerCase().split(";")[0].trim();
  if (/(?:\+|\/)json$/.test(type)) return "json";
  if (/(?:\+|\/)xml$/.test(type)) return "xml";
  const byMime = normalizeSourceLanguage(type.replace(/^(?:text|application)\/(?:x-)?/, ""));
  if (byMime && byMime !== "plaintext") return byMime;
  const first = text.slice(0, 256).split(/\r?\n/, 1)[0];
  if (first.startsWith("#!")) {
    const match = first.match(/\b(python[\d.]*|node|deno|ruby|perl|raku|bash|zsh|fish|sh|pwsh)\b/);
    const interpreter = match?.[1].replace(/^python[\d.]*$/, "python");
    if (interpreter === "node" || interpreter === "deno") return "javascript";
    if (interpreter === "pwsh") return "powershell";
    if (interpreter) return normalizeSourceLanguage(interpreter) ?? "plaintext";
  }
  return "plaintext";
}
