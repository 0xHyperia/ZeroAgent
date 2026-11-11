import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, Terminal } from "../../components/IconSet";
import { Markdown } from "../../components/Markdown";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { SidebarMenuButton } from "../../components/ui/sidebar";
import { useLocale } from "../../i18n";
import { resolveSourceLanguage, sourceLanguages } from "../../lib/sourceLanguages";
import { getSyntaxHighlighter } from "../../lib/syntaxHighlighter";

type FileTree = { folders: Map<string, FileTree>; files: string[] };

const emptyTree = (): FileTree => ({ folders: new Map(), files: [] });
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function resolveSkillReaderFile(current: string, reference: string, readable?: ReadonlySet<string>) {
  const path = reference.trim().split("#", 1)[0];
  if (!path || /^(?:\/|[\w+.-]+:)|[\\?]/.test(path)) return;
  const parts: string[] = [];
  try {
    for (const part of path.split("/")) {
      const decoded = decodeURIComponent(part);
      if (!decoded || /[/\\:\p{Cc}]/u.test(decoded)) return;
      parts.push(decoded);
    }
  } catch {
    return;
  }
  const folder = current.split("/").slice(0, -1);
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (!folder.length) return;
      folder.pop();
    } else {
      folder.push(part);
    }
  }
  const relative = folder.join("/");
  if (!readable) {
    return relative !== current && /\.(?:md|txt|py|mjs|js|json|ya?ml)$/i.test(relative)
      ? relative
      : undefined;
  }
  if (relative !== current && readable.has(relative)) return relative;
  // Built-in workflows also refer to shared files by their package paths.
  const packagePath = parts.join("/");
  if (packagePath !== current && readable.has(packagePath)) return packagePath;
}

export function skillReaderFileLinks(viewport: HTMLElement | null, path: string) {
  return Array.from(
    viewport?.querySelectorAll<HTMLButtonElement>("[data-skill-file-reference]") ?? [],
  ).filter((link) => link.dataset.skillFileReference === path);
}

export function SkillReaderMarkdown({
  file,
  content,
  readableFiles,
  onFollow,
}: {
  file: string;
  content: string;
  readableFiles?: ReadonlySet<string>;
  onFollow: (path: string, opener: HTMLButtonElement) => void;
}) {
  const overrides = useMemo<
    NonNullable<Parameters<typeof Markdown>[0]["componentOverrides"]>
  >(() => {
    const fileReference = (path: string, children: ReactNode) => (
      <button
        type="button"
        className="za-skill-inline-reference text-sky-600 dark:text-sky-400"
        data-skill-file-reference={path}
        title={path}
        onClick={(event) => onFollow(path, event.currentTarget)}
      >
        <FileText className="size-3.5" aria-hidden="true" />
        {children}
      </button>
    );
    return {
      a: (props) => {
        const path = resolveSkillReaderFile(file, props.href ?? "", readableFiles);
        if (path) return fileReference(path, props.children);
        return <span title={props.title || props.href}>{props.children}</span>;
      },
      code: ({ node: _node, children, className, ...props }) => {
        const path =
          !className && typeof children === "string" && !children.includes("\n")
            ? resolveSkillReaderFile(file, children, readableFiles)
            : undefined;
        if (path) return fileReference(path, children);
        return (
          <code {...props} className={className}>
            {children}
          </code>
        );
      },
    };
  }, [file, onFollow, readableFiles]);
  return (
    <Markdown content={content} readOnly preserveRelativeUrls componentOverrides={overrides} />
  );
}

export function SkillFileIcon({ path }: { path: string }) {
  const language = resolveSourceLanguage(path);
  const Icon = language === "plaintext" || language === "markdown" ? FileText : Terminal;
  return <Icon aria-hidden="true" className="size-4 shrink-0" />;
}

type SkillReaderFilesProps = {
  entry: string;
  files: string[];
  selected: string;
  onSelect: (path: string) => void;
};

export function SkillReaderFileMenu({ entry, files, selected, onSelect }: SkillReaderFilesProps) {
  const { locale } = useLocale();
  const english = locale === "en-US";
  const instructions = english ? "Skill instructions" : "技能正文";
  return (
    <div className="za-skill-mobile-files">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={english ? "Browse skill files" : "浏览技能文件"}
            />
          }
        >
          <FileText className="size-4" aria-hidden="true" />
          <span>{english ? "Files" : "文件"}</span>
          <ChevronDown className="size-3" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="za-skill-file-menu max-h-[60dvh] w-72 max-w-[calc(100vw-32px)] overflow-y-auto"
        >
          <DropdownMenuRadioGroup value={selected} onValueChange={onSelect}>
            {[entry, ...files].map((path) => {
              const isEntry = path === entry;
              const name = fileName(path);
              const directory = path.slice(0, path.lastIndexOf("/") + 1);
              return (
                <DropdownMenuRadioItem
                  key={path}
                  value={path}
                  closeOnClick
                  aria-label={isEntry ? instructions : path}
                  className="min-h-11 gap-2"
                >
                  <SkillFileIcon path={path} />
                  <span className="min-w-0 flex-1 wrap-anywhere">
                    <span className="block">{isEntry ? instructions : name}</span>
                    {isEntry || directory ? (
                      <span className="block text-xs text-muted-foreground">
                        {isEntry ? name : directory}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function SkillReaderFileTree({ entry, files, selected, onSelect }: SkillReaderFilesProps) {
  const { locale } = useLocale();
  const root = emptyTree();
  for (const path of files) {
    const parts = path.split("/");
    let tree = root;
    for (const part of parts.slice(0, -1)) {
      let folder = tree.folders.get(part);
      if (!folder) {
        folder = emptyTree();
        tree.folders.set(part, folder);
      }
      tree = folder;
    }
    tree.files.push(path);
  }
  return (
    <nav
      className="za-skill-file-tree"
      aria-label={locale === "en-US" ? "Skill files" : "技能文件"}
    >
      <ul className="za-skill-file-tree-list">
        <SkillFileRow path={entry} selected={selected} onSelect={onSelect} />
        <FileTreeRows tree={root} prefix="" depth={0} selected={selected} onSelect={onSelect} />
      </ul>
    </nav>
  );
}

type TreeRowsProps = {
  tree: FileTree;
  prefix: string;
  depth: number;
  selected: string;
  onSelect: (path: string) => void;
};

function FileTreeRows({ tree, prefix, depth, selected, onSelect }: TreeRowsProps) {
  return (
    <>
      {[...tree.folders].map(([name, folder]) => (
        <SkillFolder
          key={name}
          name={name}
          tree={folder}
          prefix={`${prefix}${name}/`}
          depth={depth}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
      {tree.files.map((path) => (
        <SkillFileRow key={path} path={path} selected={selected} onSelect={onSelect} />
      ))}
    </>
  );
}

function SkillFolder({ name, ...rows }: TreeRowsProps & { name: string }) {
  const [expanded, setExpanded] = useState(rows.depth === 0);
  const { selected, prefix } = rows;
  useEffect(() => {
    if (selected.startsWith(prefix)) setExpanded(true);
  }, [prefix, selected]);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <li>
      <SidebarMenuButton
        type="button"
        className="za-skill-tree-row"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Chevron className="size-3.5 shrink-0" aria-hidden="true" />
        <Folder className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate" title={name}>
          {name}
        </span>
      </SidebarMenuButton>
      {expanded && (
        <ul className="za-skill-file-tree-list">
          <FileTreeRows {...rows} depth={rows.depth + 1} />
        </ul>
      )}
    </li>
  );
}

function SkillFileRow({
  path,
  selected,
  onSelect,
}: {
  path: string;
  selected: string;
  onSelect: (path: string) => void;
}) {
  return (
    <li>
      <SidebarMenuButton
        type="button"
        className="za-skill-tree-row"
        isActive={path === selected}
        aria-current={path === selected ? "true" : undefined}
        onClick={() => onSelect(path)}
      >
        <SkillFileIcon path={path} />
        <span className="truncate" title={path}>
          {fileName(path)}
        </span>
      </SidebarMenuButton>
    </li>
  );
}

export function SkillSourceCard({ path, text }: { path: string; text: string }) {
  const { locale } = useLocale();
  const language = resolveSourceLanguage(path, "", text);
  const name =
    language === "plaintext"
      ? locale === "en-US"
        ? "Plain text"
        : "纯文本"
      : (sourceLanguages.find((item) => item.id === language)?.name ?? language);
  const [tokens, setTokens] = useState<{
    text: string;
    lines: { content: string; htmlStyle?: Record<string, string> }[][];
  }>();
  useEffect(() => {
    if (language === "plaintext" || !text || text.length > 64_000 || /[^\n\r]{2001}/.test(text))
      return;
    let active = true;
    void getSyntaxHighlighter()
      .then(async (highlighter) => {
        await highlighter.loadLanguage(language);
        const lines = highlighter.codeToTokens(text, {
          lang: language,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
        }).tokens;
        if (active) setTokens({ text, lines });
      })
      .catch(() => {
        // The complete plain text remains available when a grammar cannot load.
      });
    return () => {
      active = false;
    };
  }, [language, text]);
  return (
    <section
      className="za-skill-source-card"
      aria-label={locale === "en-US" ? `Source for ${fileName(path)}` : `${fileName(path)} 原文`}
    >
      <header>
        <span>
          <Terminal aria-hidden="true" className="size-4" />
          {name}
        </span>
        <CopyButton
          value={text}
          label={locale === "en-US" ? "Copy file contents" : "复制文件内容"}
          copiedLabel={locale === "en-US" ? "Copied file contents" : "已复制文件内容"}
          className="za-skill-copy"
        />
      </header>
      <pre>
        <code>
          {tokens?.text === text
            ? tokens.lines.map((line, index) => (
                // A source card is keyed by file and its token sequence has no interactive children.
                // biome-ignore lint/suspicious/noArrayIndexKey: immutable source line position
                <span key={index}>
                  {line.map((token, tokenIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: immutable token position
                    <span key={tokenIndex} style={token.htmlStyle as CSSProperties}>
                      {token.content}
                    </span>
                  ))}
                  {index < tokens.lines.length - 1 ? "\n" : ""}
                </span>
              ))
            : text}
        </code>
      </pre>
    </section>
  );
}
