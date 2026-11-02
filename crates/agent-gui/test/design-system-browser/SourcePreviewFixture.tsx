import { FileText } from "@liveagent/ui/components/IconSet";
import { PreviewToolbarMount } from "@liveagent/ui/components/resource-preview/PreviewChrome";
import {
  ResourcePreview,
  ResourcePreviewReadingSession,
} from "@liveagent/ui/components/resource-preview/ResourcePreview";
import { ResourceTitleMenu } from "@liveagent/ui/components/resource-preview/ResourceReaderDetails";
import { Button } from "@liveagent/ui/components/ui/button";
import { TooltipProvider } from "@liveagent/ui/components/ui/tooltip";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import "./source-preview-fixture.css";

const samples = {
  json: {
    name: "验收数据.json",
    mime: "application/json",
    text:
      '{\n  "说明": "此处为合成验收数据，不包含用户资料",\n  "messages": [\n' +
      Array.from(
        { length: 1500 },
        (_, i) =>
          `    {"id": ${i + 1}, "text": "中文原文、标点与缩进保持不变", "createdAt": "2026-11-02T08:00:00Z", "details": "${"long line ".repeat(12)}"}${i < 1499 ? "," : ""}`,
      ).join("\n") +
      "\n  ]\n}\n",
  },
  python: {
    name: "处理示例.py",
    mime: "application/octet-stream",
    text: '# coding: utf-8\n"""源码阅读验收：不会执行。"""\nfrom pathlib import Path\n\n# Unicode 与缩进\ndef summarize(items):\n    total = sum(item["value"] for item in items)\n    return {"count": len(items), "total": total}\n\nprint("预览不会运行这段代码")\n',
  },
  typescript: {
    name: "preview.ts",
    mime: "text/plain",
    text: "type Resource = { name: string; size: number };\n\nexport function describe(resource: Resource): string {\n  // 仅展示，不执行\n  return `${resource.name}: ${resource.size} bytes`;\n}\n",
  },
  vue: {
    name: "Counter.vue",
    mime: "application/octet-stream",
    text: '<script setup lang="ts">\nimport { ref } from "vue";\nconst count = ref<number>(0);\n</script>\n\n<template>\n  <button class="counter" @click="count++">{{ count }}</button>\n</template>\n\n<style scoped>\n.counter { color: #2563eb; padding: 12px; }\n</style>\n',
  },
  rust: {
    name: "hello.rs",
    mime: "text/plain",
    text: '/// 仅验证多语言高亮，不执行。\n#[derive(Debug)]\nstruct Resource { name: String, bytes: usize }\n\nfn main() {\n    let resource = Resource { name: "示例".into(), bytes: 42 };\n    println!("{:?}", resource);\n}\n',
  },
  zig: {
    name: "hello.zig",
    mime: "application/octet-stream",
    text: 'const std = @import("std");\n\npub fn main() void {\n    // 仅预览，不运行\n    std.debug.print("Hello, {s}!\\n", .{"ZeroAgent"});\n}\n',
  },
  markdown: {
    name: "阅读验收.md",
    mime: "text/markdown",
    text:
      '# 原文与正文\n\n保留 **强调** 与 `inline code`。\n\n```json\n{"source": true, "message": "原文不改写"}\n```\n\n' +
      Array.from(
        { length: 100 },
        (_, i) => `## 第 ${i + 1} 节\n\n切换视图应保留各自阅读位置。\n`,
      ).join("\n"),
  },
  invalid: {
    name: "无效编码.json",
    mime: "application/json",
    text: "",
    bytes: new Uint8Array([255, 255, 0]),
  },
};

export function SourcePreviewFixture() {
  const [kind, setKind] = useState<keyof typeof samples>("json");
  const [dark, setDark] = useState(false);
  const [sha, setSha] = useState("");
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [leadingTarget, setLeadingTarget] = useState<HTMLElement | null>(null);
  const [fileMenu, setFileMenu] = useState<ReactNode>(null);
  const sample = samples[kind];
  const bytes = useMemo(
    () => ("bytes" in sample ? sample.bytes : new TextEncoder().encode(sample.text)),
    [sample],
  );
  useEffect(() => {
    let alive = true;
    setSha("");
    void crypto.subtle.digest("SHA-256", bytes).then((d) => {
      if (alive)
        setSha([...new Uint8Array(d)].map((n) => n.toString(16).padStart(2, "0")).join(""));
    });
    return () => {
      alive = false;
    };
  }, [bytes]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    return () => document.documentElement.classList.remove("dark");
  }, [dark]);
  const mount = useMemo(
    () => ({ target, leadingTarget, fileMenu, setFileMenu }),
    [target, leadingTarget, fileMenu],
  );
  return (
    <TooltipProvider>
      <ResourcePreviewReadingSession scope="synthetic-source">
        <main className="source-proof">
          <aside>
            <strong>原文共享组件验收</strong>
            {Object.entries(samples).map(([key, value]) => (
              <Button key={key} onClick={() => setKind(key as keyof typeof samples)}>
                {value.name}
              </Button>
            ))}
            <Button onClick={() => setDark(!dark)}>{dark ? "浅色模式" : "深色模式"}</Button>
            <textarea
              aria-label="验收草稿"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </aside>
          <PreviewToolbarMount.Provider value={mount}>
            <section className="source-proof-reader">
              <header>
                <ResourceTitleMenu name={sample.name}>
                  <span>合成文件</span>
                </ResourceTitleMenu>
                <div ref={setLeadingTarget} />
                <div ref={setTarget} />
                <Button aria-label="下载原件" variant="ghost">
                  <FileText />
                </Button>
              </header>
              {sha ? (
                <ResourcePreview
                  key={kind}
                  resource={{
                    identity: kind,
                    name: sample.name,
                    mime: sample.mime,
                    size: bytes.length,
                    sha256: sha,
                  }}
                  load={async (signal) => ({
                    blob: new Blob([bytes]),
                    assertCurrent: () => signal.throwIfAborted(),
                  })}
                />
              ) : null}
            </section>
          </PreviewToolbarMount.Provider>
        </main>
      </ResourcePreviewReadingSession>
    </TooltipProvider>
  );
}
