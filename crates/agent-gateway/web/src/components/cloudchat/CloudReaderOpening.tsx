import { FileText, Globe } from "@liveagent/ui/components/IconSet";
import { PreviewLoading } from "@liveagent/ui/components/resource-preview/PreviewFeedback";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n";
import { type Ref, useRef } from "react";

export type CloudReaderOpeningFailure = "unavailable" | "temporary";

export function cloudReaderOpeningFailure(status?: number): CloudReaderOpeningFailure {
  return status === 403 || status === 404 || status === 410 ? "unavailable" : "temporary";
}

export function CloudReaderOpening(props: {
  kind: "file" | "artifact" | "site";
  failure: CloudReaderOpeningFailure | null;
  busy: boolean;
  retryRef: Ref<HTMLElement>;
  onRetry: () => Promise<void>;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const labels = {
    file: zh
      ? ["正在打开文件…", "文件不可用", "暂时无法打开文件", "请重试打开此文件。"]
      : [
          "Opening file…",
          "File unavailable",
          "Couldn't open the file",
          "Try again to reopen this file.",
        ],
    artifact: zh
      ? ["正在打开成果版本…", "成果版本不可用", "暂时无法打开成果版本", "请重试打开此版本。"]
      : [
          "Opening version…",
          "Version unavailable",
          "Couldn't open this version",
          "Try again to reopen this version.",
        ],
    site: zh
      ? ["正在打开站点版本…", "站点版本不可用", "暂时无法打开站点版本", "请重试打开此站点版本。"]
      : [
          "Opening site version…",
          "Site version unavailable",
          "Couldn't open this site version",
          "Try again to reopen this site version.",
        ],
  }[props.kind];
  const [opening, unavailable, temporary, retryHint] = labels;
  const retrying = useRef(false);
  const Icon = props.kind === "site" ? Globe : FileText;
  return (
    <div className="cloud-reader-opening">
      {props.failure ? (
        <div className="cloud-resource-empty-state flex-1">
          <Icon className="size-7 text-muted-foreground" aria-hidden="true" />
          <div role="status">
            <h2 className="text-base font-medium">
              {props.failure === "unavailable" ? unavailable : temporary}
            </h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {props.failure === "unavailable"
                ? zh
                  ? "内容可能已移除，或当前账户无权查看。"
                  : "It may have been removed or you may no longer have access."
                : retryHint}
            </p>
          </div>
          <Button
            ref={props.retryRef}
            variant="outline"
            size="sm"
            aria-disabled={props.busy}
            className="min-h-11 aria-disabled:opacity-50"
            onClick={async () => {
              if (props.busy || retrying.current) return;
              retrying.current = true;
              try {
                await props.onRetry();
              } finally {
                retrying.current = false;
              }
            }}
          >
            {props.busy ? opening : zh ? "重试" : "Try again"}
          </Button>
        </div>
      ) : (
        <PreviewLoading message={opening} />
      )}
    </div>
  );
}
