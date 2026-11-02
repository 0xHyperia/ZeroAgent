import { ComposerAttachmentCard } from "@liveagent/ui/components/chat/ComposerAttachmentCard";
import { ComposerAttachmentList } from "@liveagent/ui/components/chat/ComposerAttachmentList";
import { getResourceFileIcon } from "@liveagent/ui/components/resource-preview/ResourceFileIcon";
import {
  ResourcePreview,
  ResourceThumbnail,
} from "@liveagent/ui/components/resource-preview/ResourcePreview";
import { TooltipProvider } from "@liveagent/ui/components/ui/tooltip";
import { useState } from "react";
import type { ResourcePreviewDescriptor } from "@liveagent/ui/components/resource-preview/previewPolicy";

const load = (file: File) => async (signal: AbortSignal) => ({
  blob: file,
  assertCurrent: () => signal.throwIfAborted(),
});
type Sample = { resource: ResourcePreviewDescriptor; file: File; load: ReturnType<typeof load> };

/** Local File bytes only: this fixture never uploads files or accesses an account. */
export function AttachmentCoversFixture() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [selected, setSelected] = useState<Sample>();
  const [width, setWidth] = useState(768);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const manifest = new URLSearchParams(location.search).get("samples");
  async function accept(files: File[]) {
    const next = await Promise.all(
      files.slice(0, 16).map(async (file) => {
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
        );
        return {
          file,
          resource: {
            identity: `${file.name}:${file.lastModified}`,
            name: file.name,
            mime: file.type,
            size: file.size,
            sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
          },
          load: load(file),
        };
      }),
    );
    setSamples(next);
    setSelected(next[0]);
  }
  async function localSamples() {
    setBusy(true);
    setError("");
    try {
      const localURL = (path: string) => {
        const url = new URL(path, location.href);
        if (url.origin !== location.origin) throw new Error("样本必须由本地验收服务器提供。");
        return url;
      };
      const response = await fetch(localURL(manifest!), { credentials: "omit" });
      if (!response.ok) throw new Error("无法读取本地样本清单。");
      const entries: { name: string; mime: string; url: string }[] = await response.json();
      await accept(
        await Promise.all(
          entries.slice(0, 16).map(async (entry) => {
            const content = await fetch(localURL(entry.url), { credentials: "omit" });
            if (!content.ok) throw new Error(`无法读取样本 ${entry.name}`);
            return new File([await content.blob()], entry.name, { type: entry.mime });
          }),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取样本。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <TooltipProvider>
      <main
        style={{
          width: `min(100%, ${width}px)`,
          margin: "16px auto",
          padding: 8,
          boxSizing: "border-box",
        }}
      >
        <header style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <label>
            本地封面验收{" "}
            <input
              type="file"
              multiple
              aria-label="本地封面样本"
              onChange={(event) => void accept([...(event.currentTarget.files ?? [])])}
            />
          </label>
          {manifest ? (
            <button type="button" disabled={busy} onClick={() => void localSamples()}>
              载入本地合成样本
            </button>
          ) : null}
          {[320, 390, 768].map((value) => (
            <button type="button" key={value} onClick={() => setWidth(value)}>
              {value}px 画布
            </button>
          ))}
          {error ? <p role="alert">{error}</p> : null}
        </header>
        <section
          style={{
            border: "1px solid var(--za-border)",
            borderRadius: 24,
            overflow: "hidden",
            background: "var(--za-surface)",
          }}
        >
          <ComposerAttachmentList>
            {samples.map((sample) => {
              const Icon = getResourceFileIcon(sample.resource.name);
              return (
                <ComposerAttachmentCard
                  key={sample.resource.identity}
                  fileName={sample.resource.name}
                  pathTitle={sample.resource.name}
                  disabled={false}
                  removeLabel="移除"
                  fallbackIcon={<Icon />}
                  onRemove={() => setSamples((items) => items.filter((item) => item !== sample))}
                  onOpen={() => setSelected(sample)}
                  previewContent={
                    <ResourceThumbnail resource={sample.resource} load={sample.load} />
                  }
                />
              );
            })}
          </ComposerAttachmentList>
          <textarea
            aria-label="验收草稿"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="输入不会因封面变化丢失"
            style={{
              width: "100%",
              minHeight: 80,
              padding: 16,
              boxSizing: "border-box",
              resize: "vertical",
              background: "transparent",
            }}
          />
        </section>
        {selected ? (
          <section
            className="za-reader-stage"
            style={{
              height: 520,
              marginTop: 24,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              borderRadius: 18,
            }}
          >
            <ResourcePreview resource={selected.resource} load={selected.load} />
          </section>
        ) : null}
      </main>
    </TooltipProvider>
  );
}
