import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skillDrawerSource = readFileSync(
  new URL(
    "../../../agent-ui/src/pages/skills-hub/InstalledSkillPreviewDrawer.tsx",
    import.meta.url,
  ),
  "utf8",
);
const workspacePreviewSource = readFileSync(
  new URL(
    "../../../agent-ui/src/components/workspace-editor/WorkspaceMarkdownPreview.tsx",
    import.meta.url,
  ),
  "utf8",
);
const documentMarkdownSource = readFileSync(
  new URL("../../../agent-ui/src/components/markdown/DocumentMarkdown.tsx", import.meta.url),
  "utf8",
);
const markdownStyles = readFileSync(
  new URL("../../../agent-ui/src/components/markdown/markdownStyles.ts", import.meta.url),
  "utf8",
);

test("Skill and workspace files share the document Markdown presentation", () => {
  assert.match(skillDrawerSource, /<DocumentMarkdown content=\{shownContent\}/);
  assert.match(workspacePreviewSource, /<DocumentMarkdown/);
  assert.match(documentMarkdownSource, /"document-markdown"/);
});

test("native file skills navigate package references through the shared skill reader", () => {
  assert.match(skillDrawerSource, /<SkillReaderMarkdown\s+file=\{filePath\}\s+content=\{shownContent\}/);
  assert.match(skillDrawerSource, /readSkillText\(\{ path, offset: 0,/);
  for (const id of ["documents", "pdf", "spreadsheet", "presentations"]) {
    const root = new URL(`../../../agent-gateway/internal/account/skills/${id}/`, import.meta.url);
    const source = readFileSync(new URL("SKILL.md", root), "utf8");
    assert.doesNotMatch(source, /original\/|load_workspace_dependencies|mark_artifact_operation_started/);
    for (const [, target] of source.matchAll(/\]\(([^()\s]+)\)/g)) {
      if (/^(?:[\w+.-]+:|#)/.test(target)) continue;
      assert.doesNotThrow(() => readFileSync(new URL(target, root)), `${id}: ${target}`);
    }
  }
});

test("document Markdown keeps its typography separate from chat Markdown", () => {
  assert.match(markdownStyles, /DOCUMENT_MARKDOWN_CLASS/);
  assert.match(markdownStyles, /\[&_p\]:text-sm/);
  assert.match(markdownStyles, /\[&_\[data-streamdown=heading-2\]\]/);
  assert.match(markdownStyles, /\[&_\[data-streamdown=list-item\]>p\]:my-0/);
  assert.match(markdownStyles, /\[&_\[data-streamdown=code-block-body\]\]:rounded-lg/);
  assert.match(markdownStyles, /\[&_\[data-streamdown=heading-1\]\]:text-lg/);
});

test("Skill detail sections use whitespace instead of large divider lines", () => {
  assert.doesNotMatch(skillDrawerSource, /<Separator/);
  assert.doesNotMatch(skillDrawerSource, /SheetHeader[^>]*border-b/);
});
