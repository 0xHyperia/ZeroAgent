import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  LoaderCircle,
  Lock,
  RefreshCw,
  Share2,
  X,
} from "@liveagent/ui/components/IconSet";
import { buttonVariants } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useCallback, useEffect, useRef, useState } from "react";
import { ACCOUNT_CHANGED_EVENT } from "@/lib/accountRequest";
import type { CloudChatArtifactVersion } from "@/lib/cloudChatArtifacts";
import {
  type CloudChatSitesClient,
  type CloudSiteGrant,
  type CloudSiteRelease,
  CloudSiteWriteUnconfirmedError,
} from "@/lib/cloudChatSites";
import { CloudChatFeedback } from "./CloudChatFeedback";
import "../../cloud-site.css";
import type { DocumentRevisionComment } from "@liveagent/ui/components/resource-preview/ResourceDocumentComments";
import { CloudSiteWorkspace } from "./CloudSiteWorkspace";

/** The owner host supplies authentication and the current immutable artifact. */
export function CloudChatSiteView(props: {
  client: CloudChatSitesClient;
  artifact: CloudChatArtifactVersion;
  isCurrent: () => boolean;
  openOnMount?: boolean;
  onPreviewChange?: (open: boolean) => void;
  workspace?: {
    onClose: () => void;
    onContinue?: () => void;
    onRequestRevision?: (comments: readonly DocumentRevisionComment[]) => Promise<boolean>;
    versions: CloudChatArtifactVersion[];
    onVersion: (id: string) => void;
    displayName?: string;
    onRename?: (name: string) => Promise<void>;
    initialAction?: "share" | "settings";
  };
}) {
  const [enabled, setEnabled] = useState(false),
    [availabilityChecked, setAvailabilityChecked] = useState(false),
    [release, setRelease] = useState<CloudSiteRelease | null>(null),
    [preview, setPreview] = useState<CloudSiteGrant | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [sharing, setSharing] = useState(false),
    [shares, setShares] = useState<CloudSiteGrant[]>([]),
    [days, setDays] = useState(7),
    [copied, setCopied] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const pendingShare = useRef<{ id: string; days: number } | null>(null);
  const pendingRevoke = useRef<CloudSiteGrant | null>(null);
  const privateRequest = useRef<string | null>(null);
  const lifetime = useRef<AbortController | null>(null),
    live = useRef(false),
    mutation = useRef(false),
    scope = useRef<(() => void) | null>(null),
    current = useRef(props);
  current.current = props;
  const valid = useCallback(() => {
    scope.current?.();
    if (
      !live.current ||
      current.current.artifact.id !== props.artifact.id ||
      current.current.client !== props.client ||
      !current.current.isCurrent()
    )
      throw new DOMException("站点视图已关闭", "AbortError");
  }, [props.artifact.id, props.client]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    live.current = true;
    scope.current = props.client.captureGuard();
    const autoOpen = props.openOnMount === true;
    if (autoOpen) {
      mutation.current = true;
      setBusy(true);
    }
    const check = () => {
      if (controller.signal.aborted || lifetime.current !== controller)
        throw new DOMException("站点视图已关闭", "AbortError");
      valid();
    };
    const retire = () => {
      controller.abort();
      live.current = false;
      setPreview(null);
      current.current.onPreviewChange?.(false);
      setSharing(false);
      setShares([]);
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, retire);
    void props.client
      .enabled(controller.signal)
      .then(async (enabled) => {
        check();
        setEnabled(enabled);
        setAvailabilityChecked(true);
        if (enabled) {
          const r = await props.client.get(props.artifact.id, controller.signal);
          check();
          if (r && r.site_id !== props.artifact.family_id) throw new Error("站点版本范围不一致。");
          setRelease(r);
          if (autoOpen) {
            if (!r) throw new Error("此站点版本已不可用，请刷新资料空间。");
            current.current.onPreviewChange?.(true);
            privateRequest.current ??= crypto.randomUUID();
            const grant = await props.client.preview(
              r.id,
              privateRequest.current,
              controller.signal,
            );
            check();
            if (grant.site_id !== r.site_id) throw new Error("预览授权范围不一致。");
            privateRequest.current = null;
            setPreview(grant);
          }
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted && live.current) {
          setAvailabilityChecked(true);
          if (autoOpen) current.current.onPreviewChange?.(false);
          setError(cause instanceof Error ? cause.message : "无法读取站点状态。");
        }
      })
      .finally(() => {
        if (autoOpen && !controller.signal.aborted && live.current) {
          mutation.current = false;
          setBusy(false);
        }
      });
    return () => {
      live.current = false;
      controller.abort();
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, retire);
    };
  }, [props.client, props.artifact.id, props.artifact.family_id, props.openOnMount, valid]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => {
        setPreview(null);
        current.current.onPreviewChange?.(false);
        setNotice("私人预览已到期，可重新打开。");
      },
      Math.max(0, Date.parse(preview.expires_at) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  async function run(action: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true;
    try {
      valid();
      setBusy(true);
      setError("");
      setNotice("");
      await action();
    } catch (cause) {
      try {
        valid();
        if (cause instanceof CloudSiteWriteUnconfirmedError) setUnconfirmed(true);
        else {
          pendingShare.current = null;
          pendingRevoke.current = null;
          privateRequest.current = null;
          setUnconfirmed(false);
        }
        setError(cause instanceof Error ? cause.message : "站点操作失败。");
      } catch {}
    } finally {
      mutation.current = false;
      if (live.current) setBusy(false);
    }
  }
  function openPreview() {
    void run(async () => {
      const r =
        release ?? (await props.client.register(props.artifact.id, lifetime.current?.signal));
      valid();
      if (r.site_id !== props.artifact.family_id) throw new Error("站点版本范围不一致。");
      setRelease(r);
      privateRequest.current ??= crypto.randomUUID();
      const g = await props.client.preview(r.id, privateRequest.current, lifetime.current?.signal);
      valid();
      if (g.site_id !== r.site_id) throw new Error("预览授权范围不一致。");
      privateRequest.current = null;
      setPreview(g);
      current.current.onPreviewChange?.(true);
    });
  }
  async function loadShares() {
    const list = await props.client.shares(props.artifact.family_id, lifetime.current?.signal);
    valid();
    setShares(list);
    if (pendingShare.current && !list.some((g) => g.id === pendingShare.current?.id)) {
      setUnconfirmed(true);
      setError("分享创建结果仍待确认，可稍后刷新或使用同一次请求重试。");
    } else if (pendingRevoke.current && list.some((g) => g.id === pendingRevoke.current?.id)) {
      setUnconfirmed(true);
      setError("撤销结果仍待确认，可稍后刷新或重试撤销。");
    } else {
      pendingShare.current = null;
      pendingRevoke.current = null;
      setUnconfirmed(false);
    }
    return list;
  }
  function createShare() {
    void run(async () => {
      pendingShare.current ??= { id: crypto.randomUUID(), days };
      const g = await props.client.share(
        props.artifact.id,
        pendingShare.current.id,
        pendingShare.current.days,
        lifetime.current?.signal,
      );
      valid();
      if (g.site_id !== props.artifact.family_id) throw new Error("分享授权范围不一致。");
      pendingShare.current = null;
      await loadShares();
      setNotice("分享链接已创建，可复制或撤销。");
    });
  }
  function revoke(g: CloudSiteGrant) {
    void run(async () => {
      pendingRevoke.current = g;
      await props.client.revoke(g, lifetime.current?.signal);
      valid();
      pendingRevoke.current = null;
      await loadShares();
      setNotice("分享已撤销，链接停止访问。");
    });
  }
  function openShares() {
    setSharing(true);
    void run(async () => {
      await loadShares();
    });
  }
  async function copy(g: CloudSiteGrant) {
    try {
      valid();
      if (!g.url) return;
      await navigator.clipboard.writeText(g.url);
      valid();
      setCopied(g.id);
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : "复制失败。");
    }
  }
  if (!enabled) {
    if (props.workspace)
      return (
        <section className="cloud-site-host">
          <CloudSiteWorkspace
            {...props.workspace}
            artifact={props.artifact}
            release={null}
            preview={null}
            unavailable={availabilityChecked}
            busy={!availabilityChecked}
            isCurrent={props.isCurrent}
            onOpen={openPreview}
            onShare={openShares}
            feedback={
              error || availabilityChecked ? (
                <CloudChatFeedback
                  compact
                  tone="warning"
                  message={error || "站点托管尚未启用，可下载构建包。"}
                />
              ) : null
            }
          />
        </section>
      );
    if (error) return <CloudChatFeedback compact tone="warning" message={error} />;
    if (!props.openOnMount) return null;
    return (
      <CloudChatFeedback
        compact
        busy={!availabilityChecked}
        message={availabilityChecked ? "站点托管尚未启用，可下载构建包。" : "正在打开私人站点…"}
      />
    );
  }
  return (
    <section
      className={props.workspace ? "cloud-site-host" : "cloud-site-view"}
      aria-label="站点版本"
    >
      {props.workspace ? (
        <CloudSiteWorkspace
          {...props.workspace}
          artifact={props.artifact}
          release={release}
          preview={preview}
          busy={busy}
          isCurrent={props.isCurrent}
          onOpen={openPreview}
          onShare={openShares}
          feedback={
            error || notice ? (
              <CloudChatFeedback
                compact
                tone={error ? "warning" : undefined}
                message={error || notice}
                actions={
                  <Button variant="ghost" size="sm" disabled={busy} onClick={openPreview}>
                    重新打开
                  </Button>
                }
              />
            ) : null
          }
        />
      ) : (
        <>
          <div className="cloud-site-toolbar">
            <div className="cloud-site-identity">
              <Globe className="size-4" />
              <span>{release ? `站点 · v${props.artifact.number}` : "站点预览"}</span>
              <span className="cloud-site-private">
                <Lock className="size-3" />
                私人预览
              </span>
            </div>
            <div className="cloud-site-actions">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || Boolean(pendingShare.current) || Boolean(pendingRevoke.current)}
                onClick={openPreview}
              >
                {busy ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : preview ? (
                  <RefreshCw className="size-4" />
                ) : (
                  <Globe className="size-4" />
                )}
                {preview ? "刷新预览" : "预览站点"}
              </Button>
              {release ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={openShares}>
                  <Share2 className="size-4" />
                  分享
                </Button>
              ) : null}
            </div>
          </div>
          {error ? (
            <CloudChatFeedback
              compact
              tone="error"
              message={error}
              actions={
                unconfirmed ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await props.client.get(
                          props.artifact.id,
                          lifetime.current?.signal,
                        );
                        valid();
                        setRelease(r);
                        await loadShares();
                        setNotice("已刷新站点和分享状态。");
                      })
                    }
                  >
                    刷新核对
                  </Button>
                ) : undefined
              }
            />
          ) : null}
          {notice ? <CloudChatFeedback compact message={notice} /> : null}
          {preview?.url ? (
            <div className="cloud-site-preview">
              <div className="cloud-site-preview-top">
                <span>
                  <Lock className="size-3" />
                  此预览未公开
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="关闭站点预览"
                  aria-label="关闭站点预览"
                  onClick={() => {
                    setPreview(null);
                    current.current.onPreviewChange?.(false);
                  }}
                >
                  <X className="size-4" />
                </Button>
              </div>
              <iframe
                title={`${props.artifact.name} · 站点预览`}
                src={preview.url}
                sandbox="allow-scripts allow-same-origin allow-downloads"
                referrerPolicy="no-referrer"
                allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'"
              />
            </div>
          ) : (
            <p className="cloud-site-caption">
              包含 index.html 的 ZIP 可作为静态站点预览。分享由你明确开启。
            </p>
          )}
        </>
      )}
      <Dialog open={sharing} onOpenChange={setSharing}>
        <DialogContent
          showCloseButton
          closeLabel="关闭站点分享"
          className="cloud-site-share-dialog"
        >
          <DialogHeader>
            <DialogTitle>分享站点</DialogTitle>
            <DialogDescription>
              链接固定到选定版本。持有链接的人可访问，之后可随时撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="cloud-site-share-create">
              <label htmlFor={`site-days-${props.artifact.id}`}>
                v{props.artifact.number} · 有效期
              </label>
              <select
                id={`site-days-${props.artifact.id}`}
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
                disabled={busy || unconfirmed}
              >
                <option value={1}>1 天</option>
                <option value={7}>7 天</option>
                <option value={30}>30 天</option>
              </select>
              <Button size="sm" disabled={busy || unconfirmed} onClick={createShare}>
                <Share2 className="size-4" />
                创建分享链接
              </Button>
            </div>
            {error ? <CloudChatFeedback compact tone="error" message={error} /> : null}
            {unconfirmed && pendingShare.current ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={createShare}>
                重试未确认的创建
              </Button>
            ) : null}
            {unconfirmed && pendingRevoke.current ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  const pending = pendingRevoke.current;
                  if (pending) revoke(pending);
                }}
              >
                重试未确认的撤销
              </Button>
            ) : null}
            <div className="cloud-site-share-list" aria-busy={busy}>
              {!shares.length ? (
                <p className="cloud-site-caption">
                  {busy ? "正在读取分享…" : "没有生效中的分享链接。"}
                </p>
              ) : (
                shares.map((g) => (
                  <article key={g.id} className="cloud-site-share-item">
                    <div>
                      <span>
                        {g.release_id === props.artifact.id
                          ? `当前版本 · v${props.artifact.number}`
                          : "其他已保存版本"}
                      </span>
                      <span>{new Date(g.expires_at).toLocaleString()} 到期</span>
                    </div>
                    <Input
                      aria-label="站点分享链接"
                      readOnly
                      value={g.url ?? ""}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <div className="cloud-site-share-controls">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void copy(g)}
                      >
                        {copied === g.id ? (
                          <Check className="size-4" />
                        ) : (
                          <Copy className="size-4" />
                        )}
                        {copied === g.id ? "已复制" : "复制链接"}
                      </Button>
                      <a
                        className={buttonVariants({ variant: "ghost", size: "sm" })}
                        href={g.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="size-4" />
                        打开
                      </a>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || unconfirmed}
                        onClick={() => revoke(g)}
                      >
                        撤销链接
                      </Button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await loadShares();
                })
              }
            >
              <RefreshCw className="size-4" />
              刷新分享状态
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSharing(false)}>
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
