import { ExternalLink } from "@liveagent/ui/components/IconSet";
import { Button, buttonVariants } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useLocale } from "@liveagent/ui/i18n";
import { type MouseEvent, useEffect, useEffectEvent, useState } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import { CloudChatSourceError, type CloudChatSourcesClient } from "@/lib/cloudChatSources";

type LinkState =
  | { status: "loading" }
  | { status: "failed"; unavailable: boolean }
  | {
      status: "ready";
      link: Awaited<ReturnType<CloudChatSourcesClient["get"]>>;
    };

export function CloudChatSourceLinkDialog({
  client,
  sourceId,
  isCurrent,
  onClose,
  onError,
}: {
  client: CloudChatSourcesClient;
  sourceId: string;
  isCurrent: () => boolean;
  onClose: () => void;
  onError: (cause: unknown) => void;
}) {
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const [state, setState] = useState<LinkState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [guard] = useState(captureAccountRequestGuard);
  const accept = useEffectEvent((next: LinkState, cause?: unknown) => {
    if (!isCurrent()) return;
    setState(next);
    if (cause) onError(cause);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry restarts the same source read.
  useEffect(() => {
    try {
      guard();
    } catch {
      return;
    }
    const controller = new AbortController();
    accept({ status: "loading" });
    void client.get(sourceId, controller.signal).then(
      (link) => {
        if (!controller.signal.aborted) accept({ status: "ready", link });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        const unavailable =
          cause instanceof CloudChatSourceError && [403, 404, 410].includes(cause.status);
        accept({ status: "failed", unavailable }, cause);
      },
    );
    return () => controller.abort();
  }, [client, sourceId, guard, retry]);

  function checkLink(event: MouseEvent<HTMLAnchorElement>) {
    try {
      if (state.status !== "ready" || !isCurrent()) event.preventDefault();
      else guard();
    } catch {
      event.preventDefault();
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton closeLabel={copy("关闭", "Close")}>
        <DialogHeader>
          <DialogTitle>{copy("来源链接", "Source link")}</DialogTitle>
          <DialogDescription>
            {copy("原网页将在新标签页打开。", "The original page opens in a new tab.")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {state.status === "loading" ? (
            <p role="status" className="text-sm text-muted-foreground">
              {copy("正在读取来源链接…", "Loading the source link…")}
            </p>
          ) : state.status === "failed" ? (
            <p role="alert" className="text-sm text-muted-foreground">
              {state.unavailable
                ? copy("此来源已移除或无权访问。", "This source was removed or is inaccessible.")
                : copy("暂时无法读取来源链接。", "The source link couldn't be loaded.")}
            </p>
          ) : (
            <div className="min-w-0 space-y-1 wrap-anywhere">
              <p className="text-sm font-medium">{state.link.title || state.link.host}</p>
              {state.link.title ? (
                <p className="text-sm text-muted-foreground">{state.link.host}</p>
              ) : null}
            </div>
          )}
        </DialogBody>
        {state.status === "ready" ? (
          <DialogFooter>
            <a
              href={state.link.href}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ className: "min-h-11" })}
              onClick={checkLink}
              onAuxClick={checkLink}
              onContextMenu={checkLink}
            >
              {copy("打开原网页", "Open original page")}
              <ExternalLink className="size-4" />
            </a>
          </DialogFooter>
        ) : state.status === "failed" && !state.unavailable ? (
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setRetry((old) => old + 1)}
            >
              {copy("重试", "Retry")}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
