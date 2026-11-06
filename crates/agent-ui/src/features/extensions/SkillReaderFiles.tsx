import { type CSSProperties, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, Terminal } from "../../components/IconSet";
import { CopyButton } from "../../components/ui/copy-button";
import { SidebarMenuButton } from "../../components/ui/sidebar";
import { resolveSourceLanguage, sourceLanguages } from "../../lib/sourceLanguages";
import { getSyntaxHighlighter } from "../../lib/syntaxHighlighter";

type FileTree = { folders: Map<string, FileTree>; files: string[] };

const emptyTree = (): FileTree => ({ folders: new Map(), files: [] });
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function SkillFileIcon({ path }: { path: string }) {
  const language = resolveSourceLanguage(path);
  const Icon = language === "plaintext" || language === "markdown" ? FileText : Terminal;
  return <Icon aria-hidden="true" className="size-4 shrink-0" />;
}

export function SkillReaderFileTree({
  entry,
  files,
  selected,
  onSelect,
}: {
  entry: string;
  files: string[];
  selected: string;
  onSelect: (path: string) => void;
}) {
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
    <nav className="za-skill-file-tree" aria-label="技能文件">
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
  const language = resolveSourceLanguage(path, "", text);
  const name = sourceLanguages.find((item) => item.id === language)?.name ?? "纯文本";
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
    <section className="za-skill-source-card" aria-label={`${fileName(path)} 原文`}>
      <header>
        <span>
          <Terminal aria-hidden="true" className="size-4" />
          {name}
        </span>
        <CopyButton
          value={text}
          label="复制文件内容"
          copiedLabel="已复制文件内容"
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
