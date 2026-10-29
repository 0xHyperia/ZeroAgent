import { ImageIcon } from "@liveagent/ui/components/IconSet";
import { useEffect, useRef, useState } from "react";
import {
  type CloudChatArtifactsClient,
  cloudArtifactImageDimensions,
} from "@/lib/cloudChatArtifacts";
import type { CloudChatFilesClient } from "@/lib/cloudChatFiles";
import type { CloudSpaceItem } from "@/lib/cloudSpace";

// Thumbnails reuse authenticated, bounded downloads. No public object URL or
// third-party preview service; only visible small originals are fetched.
let active = 0;
const queue: (() => void)[] = [];
async function acquire(signal: AbortSignal) {
  if (active >= 2) await new Promise<void>((resolve) => queue.push(resolve));
  else active++;
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
  if (signal.aborted) {
    release();
    throw new Error("Thumbnail cancelled");
  }
  return release;
}
export function CloudSpaceImage({
  item,
  files,
  artifacts,
  captureGuard,
}: {
  item: CloudSpaceItem;
  files: CloudChatFilesClient;
  artifacts: CloudChatArtifactsClient;
  captureGuard: () => () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null),
    [url, setURL] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let objectURL = "",
      started = false;
    const load = async () => {
      if (
        started ||
        item.size > 2 * 1024 * 1024 ||
        item.size <= 0 ||
        !["ready", "vision_ready"].includes(item.state)
      )
        return;
      if (item.kind === "artifact" && !["image/png", "image/jpeg"].includes(item.mime)) return;
      started = true;
      const guard = captureGuard();
      let release: (() => void) | undefined;
      try {
        release = await acquire(controller.signal);
        guard();
        let blob: Blob;
        if (item.kind === "file") {
          if (!["image/png", "image/jpeg"].includes(item.mime)) return;
          const file = await files.get(item.target_id, controller.signal);
          guard();
          const result = await files.download(file, controller.signal);
          result.guard();
          cloudArtifactImageDimensions(new Uint8Array(await result.blob.arrayBuffer()), file.mime);
          blob = new Blob([result.blob], { type: file.mime });
        } else {
          const version = await artifacts.get(item.target_id, controller.signal);
          guard();
          const result = await artifacts.image(version, controller.signal);
          result.guard();
          blob = result.blob;
        }
        guard();
        if (controller.signal.aborted) return;
        objectURL = URL.createObjectURL(blob);
        setURL(objectURL);
      } catch {
        /* A thumbnail failure never makes the saved original unavailable. */
      } finally {
        release?.();
      }
    };
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                observer?.disconnect();
                void load();
              }
            },
            { rootMargin: "100px" },
          )
        : null;
    if (observer && ref.current) observer.observe(ref.current);
    else void load();
    return () => {
      controller.abort();
      observer?.disconnect();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [item.target_id, item.kind, item.mime, item.size, item.state, files, artifacts, captureGuard]);
  return (
    <span ref={ref} className="cloud-space-image-preview">
      {url ? (
        <img src={url} alt="" loading="lazy" onError={() => setURL("")} />
      ) : (
        <ImageIcon className="size-7" />
      )}
    </span>
  );
}
