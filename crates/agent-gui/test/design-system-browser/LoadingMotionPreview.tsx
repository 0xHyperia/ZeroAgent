import { ComposerAttachmentCard } from "@liveagent/ui/components/chat/ComposerAttachmentCard";
import { File, X } from "@liveagent/ui/components/IconSet";
import { PreviewLoading } from "@liveagent/ui/components/resource-preview/PreviewFeedback";
import { ResourcePreview } from "@liveagent/ui/components/resource-preview/ResourcePreview";
import { Button } from "@liveagent/ui/components/ui/button";
import { TooltipProvider } from "@liveagent/ui/components/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import "./loading-motion-preview.css";

// Deliberately held local bytes let visual QA inspect real read/cancel/complete transitions.
// This entry is excluded from the product bundles and never opens an account client.
export function LoadingMotionPreview() {
  const [done, setDone] = useState(false);
  const [dark, setDark] = useState(false);
  const complete = useRef<(() => void) | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    return () => document.documentElement.classList.remove("dark");
  }, [dark]);
  return (
    <TooltipProvider>
      <main className={`loading-proof ${dark ? "dark" : ""}`}>
        <section className="loading-proof-chat">
          <header>
            <strong>加载动效验收</strong>
            <Button variant="ghost" onClick={() => setDark(!dark)}>
              浅色 / 深色
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                complete.current?.();
                setDone(true);
              }}
            >
              完成读取
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDone(false);
                setAttempt(attempt + 1);
              }}
            >
              重新加载
            </Button>
          </header>
          <p>共享组件的真实等待状态，不访问账户或上传文件。</p>
          <div className="loading-proof-composer">
            <ComposerAttachmentCard
              fileName="Implement Full Screen Map.md"
              pathTitle="Implement Full Screen Map.md"
              fallbackIcon={<File />}
              disabled
              removeLabel="移除"
              onRemove={() => {}}
              previewContent={
                done ? (
                  <div className="za-thumbnail-fallback">
                    <File />
                  </div>
                ) : (
                  <PreviewLoading variant="thumbnail" message="正在上传附件" />
                )
              }
            />
            <textarea
              aria-label="验收草稿"
              placeholder="使用 ZeroAgent 工作"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <footer>
              ＋<span>GPT-6.1 Sol　标准　↗</span>
            </footer>
          </div>
        </section>
        <section className="loading-proof-reader">
          <header>
            <span>
              Implement Full Screen Map <small>⌄</small>
            </span>
            <span>
              100%　⌄　　↓　　
              <X />
            </span>
          </header>
          <ResourcePreview
            key={attempt}
            resource={{
              identity: `loading-proof:${attempt}`,
              name: "Implement Full Screen Map.md",
              mime: "text/markdown",
              size: 5,
              sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            }}
            load={async (signal) => {
              await new Promise<void>((resolve) => {
                complete.current = resolve;
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
              signal.throwIfAborted();
              return {
                blob: new Blob(["hello"]),
                assertCurrent: () => signal.throwIfAborted(),
              };
            }}
          />
        </section>
      </main>
    </TooltipProvider>
  );
}
