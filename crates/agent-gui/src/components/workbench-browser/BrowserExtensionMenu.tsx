import { ExternalLink, Plus, Trash2, X } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
} from "@liveagent/ui/components/ui/popover";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useRef, useState } from "react";
import Puzzle from "~icons/lucide/puzzle";
import { invoke } from "../../shims/tauriCore";

type Extension = { id: string; name: string; enabled: boolean; canOpenPopup?: boolean };
type StoreReview = {
  token: string;
  id: string;
  name: string;
  version: string;
  permissions: string[];
  optionalPermissions: string[];
};
type Action =
  | { action: "list" | "install" }
  | { action: "installStore"; token: string }
  | { action: "enable"; extension: string; enabled: boolean }
  | { action: "remove"; extension: string };

export function chromeStoreExtensionId(address: string): string | null {
  try {
    const url = new URL(address);
    if (url.origin !== "https://chromewebstore.google.com" || url.username || url.password)
      return null;
    return url.pathname.match(/^\/detail\/(?:[^/]+\/)?([a-p]{32})$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function ExtensionPopup({
  id,
  extension,
  anchor,
  onClose,
  title,
  error,
  close,
}: {
  id: string;
  extension: Extension;
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose(): void;
  title: string;
  error: string;
  close: string;
}) {
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const element = stage;
    if (!element) return;
    const token = crypto.randomUUID();
    let started = false;
    let disposed = false;
    let frame = 0;
    let previous = "";
    const send = (request: Record<string, unknown>) =>
      invoke("workbench_browser_extensions", { id, request });
    function sync() {
      const rect = element!.getBoundingClientRect();
      const scale = window.devicePixelRatio;
      const x = Math.round(Math.max(0, rect.left) * scale);
      const y = Math.round(Math.max(0, rect.top) * scale);
      const width = Math.round(Math.min(rect.right, window.innerWidth) * scale) - x;
      const height = Math.round(Math.min(rect.bottom, window.innerHeight) * scale) - y;
      if (width <= 0 || height <= 0) return;
      const bounds = { x, y, width, height };
      const key = JSON.stringify(bounds);
      if (key === previous) return;
      previous = key;
      if (started) {
        void send({ action: "resizePopup", token, bounds }).catch(() => undefined);
      } else {
        started = true;
        void send({ action: "openPopup", token, extension: extension.id, bounds }).then(
          () => {
            if (!disposed) setState("ready");
          },
          () => {
            if (!disposed) setState("failed");
            void send({ action: "closePopup", token }).catch(() => undefined);
          },
        );
      }
    }
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sync);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
      if (started) void send({ action: "closePopup", token }).catch(() => undefined);
    };
  }, [id, extension.id, stage]);

  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverContent
        anchor={anchor}
        align="end"
        className="za-workspace-browser-extension-popup p-0"
        aria-label={extension.name}
      >
        <div className="flex min-h-9 items-center justify-between gap-2 border-b border-border px-3">
          <PopoverTitle className="min-w-0 truncate">{extension.name}</PopoverTitle>
          <PopoverClose
            render={<Button size="icon-sm" variant="ghost" title={close} aria-label={close} />}
          >
            <X className="size-4" />
          </PopoverClose>
        </div>
        <div ref={setStage} className="za-workspace-browser-extension-stage bg-background">
          {state !== "ready" && (
            <div
              role={state === "failed" ? "alert" : "status"}
              className="p-3 text-sm text-muted-foreground"
            >
              {state === "failed" ? error : title}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function BrowserExtensionMenu({
  id,
  active = true,
  pageUrl = "",
  onVisitStore,
}: {
  id: string;
  active?: boolean;
  pageUrl?: string;
  onVisitStore(): void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Extension[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [review, setReview] = useState<StoreReview | null>(null);
  const [reviewIntent, setReviewIntent] = useState(false);
  const [popup, setPopup] = useState<Extension | null>(null);
  const puzzle = useRef<HTMLButtonElement>(null);
  const version = useRef(0);
  const currentReview = useRef<StoreReview | null>(null);
  const storeExtension = chromeStoreExtensionId(pageUrl);
  const labels = zh
    ? {
        title: "浏览器扩展",
        description: "扩展在当前账户的内置浏览器中运行。",
        add: "加载已解包的扩展",
        store: "浏览 Chrome 网上应用店",
        storeAdd: "从 Chrome 网上应用店添加扩展",
        storeButton: "从商店安装",
        review: "审阅扩展权限",
        reviewDescription: "请确认此扩展申请的权限。",
        permissions: "安装后可使用",
        optionalPermissions: "可在运行时申请",
        noPermissions: "没有声明额外权限",
        install: "添加扩展",
        cancel: "取消",
        verifying: "正在下载并验证扩展…",
        openPopup: "打开扩展",
        loadingPopup: "正在打开扩展…",
        popupError: "此扩展的弹窗无法在内置浏览器中打开。",
        close: "关闭",
        empty: "没有已安装的扩展",
        loading: "正在读取扩展…",
        failed: "无法完成扩展操作。",
        retry: "重试",
        remove: "移除",
      }
    : {
        title: "Browser extensions",
        description: "Extensions run in this account’s in-app browser.",
        add: "Load unpacked extension",
        store: "Browse Chrome Web Store",
        storeAdd: "Add from Chrome Web Store",
        storeButton: "Install from store",
        review: "Review extension permissions",
        reviewDescription: "Confirm the permissions requested by this extension.",
        permissions: "Available after installation",
        optionalPermissions: "May ask while running",
        noPermissions: "No additional permissions declared",
        install: "Add extension",
        cancel: "Cancel",
        verifying: "Downloading and verifying extension…",
        openPopup: "Open extension",
        loadingPopup: "Opening extension…",
        popupError: "This extension’s popup could not open in the embedded browser.",
        close: "Close",
        empty: "No extensions installed",
        loading: "Loading extensions…",
        failed: "Could not complete the extension action.",
        retry: "Retry",
        remove: "Remove",
      };

  async function update(request: Action) {
    const current = ++version.current;
    setReviewIntent(false);
    setBusy(true);
    setError(false);
    try {
      if (request.action !== "list") await invoke("workbench_browser_extensions", { id, request });
      const installed = await invoke<Extension[]>("workbench_browser_extensions", {
        id,
        request: { action: "list" },
      });
      if (version.current === current) setRows(installed);
    } catch {
      if (version.current === current) setError(true);
    } finally {
      if (version.current === current) setBusy(false);
    }
  }

  function clearReview() {
    const pending = currentReview.current;
    currentReview.current = null;
    setReview(null);
    if (pending)
      void invoke("workbench_browser_extensions", {
        id,
        request: { action: "cancelStore", token: pending.token },
      }).catch(() => undefined);
  }

  async function prepareStore() {
    const current = ++version.current;
    setOpen(true);
    setReviewIntent(true);
    setBusy(true);
    setError(false);
    try {
      const ready = await invoke<StoreReview>("workbench_browser_prepare_store_extension", { id });
      if (version.current === current) {
        currentReview.current = ready;
        setReview(ready);
      } else {
        void invoke("workbench_browser_extensions", {
          id,
          request: { action: "cancelStore", token: ready.token },
        }).catch(() => undefined);
      }
    } catch {
      if (version.current === current) setError(true);
    } finally {
      if (version.current === current) setBusy(false);
    }
  }

  useEffect(() => {
    setOpen(false);
    setBusy(false);
    setPopup(null);
    setReview(null);
    return () => {
      version.current += 1;
      const pending = currentReview.current;
      currentReview.current = null;
      if (pending)
        void invoke("workbench_browser_extensions", {
          id,
          request: { action: "cancelStore", token: pending.token },
        }).catch(() => undefined);
    };
  }, [active, id, pageUrl]);

  return (
    <>
      {active && storeExtension && (
        <button
          type="button"
          className="za-workspace-browser-store-install"
          title={labels.storeAdd}
          aria-label={labels.storeAdd}
          onClick={() => void prepareStore()}
        >
          <Plus />
          <span aria-hidden>{labels.storeButton}</span>
        </button>
      )}
      <button
        ref={puzzle}
        type="button"
        title={labels.title}
        aria-label={labels.title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setPopup(null);
          setOpen(true);
          void update({ action: "list" });
        }}
      >
        <Puzzle />
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            version.current += 1;
            clearReview();
          }
          setOpen(next);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{review ? labels.review : labels.title}</DialogTitle>
            <DialogDescription>
              {review ? labels.reviewDescription : labels.description}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {review ? (
              <>
                <div className="flex items-baseline gap-2">
                  <strong className="min-w-0 break-words text-sm">{review.name}</strong>
                  <span className="shrink-0 text-xs text-muted-foreground">{review.version}</span>
                </div>
                <div className="max-h-64 space-y-2 overflow-y-auto text-sm">
                  {(
                    [
                      [labels.permissions, review.permissions],
                      [labels.optionalPermissions, review.optionalPermissions],
                    ] as const
                  ).map(
                    ([label, values]) =>
                      values.length > 0 && (
                        <div key={label}>
                          <h3 className="font-medium">{label}</h3>
                          <ul className="list-disc space-y-1 break-words pl-5 text-muted-foreground">
                            {values.map((value) => (
                              <li key={value}>{value}</li>
                            ))}
                          </ul>
                        </div>
                      ),
                  )}
                  {review.permissions.length === 0 &&
                    review.optionalPermissions.length === 0 &&
                    labels.noPermissions}
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={clearReview}>
                    {labels.cancel}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      currentReview.current = null;
                      setReview(null);
                      void update({ action: "installStore", token: review.token });
                    }}
                  >
                    {labels.install}
                  </Button>
                </div>
              </>
            ) : (
              <>
                {busy && (reviewIntent || rows.length === 0) && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {reviewIntent ? labels.verifying : labels.loading}
                  </p>
                )}
                {!busy && !error && rows.length === 0 && (
                  <p className="text-sm text-muted-foreground">{labels.empty}</p>
                )}
                {error && (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-2 text-sm text-destructive"
                  >
                    <span>{labels.failed}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void (reviewIntent ? prepareStore() : update({ action: "list" }))
                      }
                    >
                      {labels.retry}
                    </Button>
                  </div>
                )}
                {rows.length > 0 && (
                  <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                    {rows.map((extension) => (
                      <li key={extension.id} className="flex min-h-10 items-center gap-2 px-2">
                        {extension.canOpenPopup ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="min-w-0 flex-1 justify-start px-1"
                            disabled={busy}
                            aria-label={`${labels.openPopup} ${extension.name}`}
                            onClick={() => {
                              setOpen(false);
                              setPopup(extension);
                            }}
                          >
                            <span className="truncate">{extension.name}</span>
                          </Button>
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-sm" title={extension.name}>
                            {extension.name}
                          </span>
                        )}
                        <Switch
                          checked={extension.enabled}
                          disabled={busy}
                          aria-label={extension.name}
                          onCheckedChange={(enabled) =>
                            void update({ action: "enable", extension: extension.id, enabled })
                          }
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8"
                          title={labels.remove}
                          aria-label={`${labels.remove} ${extension.name}`}
                          disabled={busy}
                          onClick={() => void update({ action: "remove", extension: extension.id })}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void update({ action: "install" })}
                  >
                    <Plus className="size-4" /> {labels.add}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      version.current += 1;
                      setOpen(false);
                      onVisitStore();
                    }}
                  >
                    <ExternalLink className="size-4" /> {labels.store}
                  </Button>
                </div>
              </>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
      {active && popup && (
        <ExtensionPopup
          id={id}
          extension={popup}
          anchor={puzzle}
          onClose={() => setPopup(null)}
          title={labels.loadingPopup}
          error={labels.popupError}
          close={labels.close}
        />
      )}
    </>
  );
}
