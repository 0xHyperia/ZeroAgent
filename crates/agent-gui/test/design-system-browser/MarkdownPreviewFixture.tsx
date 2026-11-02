import { ComposerAttachmentCard } from "@liveagent/ui/components/chat/ComposerAttachmentCard";
import { FileText } from "@liveagent/ui/components/IconSet";
import {
  ResourcePreview,
  ResourceThumbnail,
} from "@liveagent/ui/components/resource-preview/ResourcePreview";
import { Button } from "@liveagent/ui/components/ui/button";
import { TooltipProvider } from "@liveagent/ui/components/ui/tooltip";
import { useEffect, useState } from "react";
import "./markdown-preview-fixture.css";

// Synthetic local bytes only; no account, upload, model or native bridge.
const text = `# Markdown 阅读验收

真实封面与正文共用渲染器。支持 **重点**、*强调*、~~删除线~~ 和 \`inline code\`。

## 代码与自动换行

\`\`\`javascript
const message = "中文与长代码共同验证自动换行：" + "a long line that should stay inside this code block and never expand the reading pane";
console.log(message);
\`\`\`

## 表格与列表

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 正文封面 | 已完成 | 显示实际开头内容 |
| 手机布局 | 待验收 | 代码和表格独立滚动 |

1. 阅读文件。
2. 复制代码和表格。
   - 嵌套列表。

- [x] 已完成的项目
- [ ] 尚未完成的项目

> 引用保留层次，不使用斜体或纸张装饰。

[安全链接](https://example.com/very/long/path/that/should/wrap/within/the/reading/column)

![外链不会自动加载](https://example.invalid/tracking.png)
`;
const bytes = new TextEncoder().encode(text);

export function MarkdownPreviewFixture() {
  const [sha256, setSHA256] = useState("");
  const [dark, setDark] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    let active = true;
    void crypto.subtle.digest("SHA-256", bytes).then((digest) => {
      if (active)
        setSHA256(
          [...new Uint8Array(digest)]
            .map((part) => part.toString(16).padStart(2, "0"))
            .join(""),
        );
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    return () => document.documentElement.classList.remove("dark");
  }, [dark]);
  const resource = {
    identity: "markdown-proof",
    name: "Markdown 阅读验收.md",
    mime: "text/markdown",
    size: bytes.length,
    sha256,
  };
  const load = async (signal: AbortSignal) => ({
    blob: new Blob([bytes]),
    assertCurrent: () => signal.throwIfAborted(),
  });
  return (
    <TooltipProvider>
      <main className="markdown-proof">
        <header>
          <strong>Markdown 共享组件验收</strong>
          <Button onClick={() => setDark(!dark)}>{dark ? "浅色模式" : "深色模式"}</Button>
        </header>
        <section className="markdown-proof-draft">
          {sha256 ? (
            <ComposerAttachmentCard
              fileName={resource.name}
              pathTitle={resource.name}
              disabled
              removeLabel="移除"
              onRemove={() => {}}
              fallbackIcon={<FileText />}
              previewContent={<ResourceThumbnail resource={resource} load={load} />}
            />
          ) : null}
          <textarea
            aria-label="验收草稿"
            placeholder="输入内容后切换主题，草稿应保留"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </section>
        <section className="markdown-proof-reader">
          {sha256 ? <ResourcePreview resource={resource} load={load} /> : null}
        </section>
      </main>
    </TooltipProvider>
  );
}
