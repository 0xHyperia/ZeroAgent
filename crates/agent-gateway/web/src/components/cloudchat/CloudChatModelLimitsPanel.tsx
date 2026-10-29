import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CloudChatModelLimitSetting,
  type CloudChatModelLimitsClient,
  CloudChatModelLimitsError,
  validateCloudChatModelLimitUpdate,
} from "@/lib/cloudChatModelLimits";

export function CloudChatModelLimitsPanel(props: {
  client: CloudChatModelLimitsClient;
  providerKeyId: number;
  model: string;
  localContext?: number;
  localOutput?: number;
  captureGuard: () => () => void;
  onClose: () => void;
}) {
  const [setting, setSetting] = useState<CloudChatModelLimitSetting | null>(null);
  const [mode, setMode] = useState<"platform" | "custom">("custom");
  const [context, setContext] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = ++generation.current,
      guard = props.captureGuard();
    setBusy(true);
    setError("");
    setNotice("");
    setLoaded(false);
    try {
      const value = await props.client.get(props.providerKeyId, props.model, abort.signal);
      guard();
      if (current !== generation.current || abort.signal.aborted) return;
      setSetting(value);
      setMode(value?.mode ?? "custom");
      setContext(String(value?.context_window || props.localContext || ""));
      setOutput(String(value?.max_output_tokens || props.localOutput || ""));
      setLoaded(true);
      setNeedsReload(false);
    } catch (cause) {
      if (current === generation.current && !abort.signal.aborted)
        setError(cause instanceof Error ? cause.message : "模型参数读取失败。");
    } finally {
      if (current === generation.current) {
        controller.current = null;
        setBusy(false);
      }
    }
  }, [
    props.client,
    props.providerKeyId,
    props.model,
    props.captureGuard,
    props.localContext,
    props.localOutput,
  ]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [load]);
  async function save() {
    if (busy || !loaded || needsReload) return;
    const current = generation.current,
      guard = props.captureGuard();
    const abort = new AbortController();
    controller.current = abort;
    let customContext = Number(context),
      customOutput = Number(output);
    let attempted = false;
    try {
      if (mode === "platform") {
        try {
          validateCloudChatModelLimitUpdate({
            expected_version: setting?.version ?? 0,
            mode: "custom",
            context_window: customContext,
            max_output_tokens: customOutput,
          });
        } catch {
          customContext = 0;
          customOutput = 0;
        }
      }
      const update = validateCloudChatModelLimitUpdate({
        expected_version: setting?.version ?? 0,
        mode,
        context_window: customContext,
        max_output_tokens: customOutput,
      });
      setBusy(true);
      setError("");
      setNotice("");
      attempted = true;
      const saved = await props.client.save(props.providerKeyId, props.model, update, abort.signal);
      guard();
      if (current !== generation.current || abort.signal.aborted) return;
      setSetting(saved);
      setNotice("已保存到账户，同一账户的其他设备会在发送新任务时使用此设置。");
    } catch (cause) {
      if (current !== generation.current || abort.signal.aborted) return;
      setError(
        attempted && !(cause instanceof CloudChatModelLimitsError)
          ? "保存结果尚未确认，请重新读取账户设置后再操作。"
          : cause instanceof Error
            ? cause.message
            : "模型参数无效。",
      );
      if (attempted) setNeedsReload(true);
    } finally {
      if (current === generation.current) {
        controller.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="flex max-h-[85dvh] w-full max-w-560px flex-col gap-16px overflow-auto p-20px">
        <DialogTitle>云端模型参数</DialogTitle>
        <DialogDescription>
          {props.model} · 上下文窗口和最大输出保存在当前账户，适用于这个模型分组。当前云端使用 Chat
          Completions。
        </DialogDescription>
        {!setting && loaded ? (
          <p className="text-sm text-muted-foreground">
            尚未保存账户偏好，当前使用此浏览器已有的模型配置。只有点击保存才会改变账户设置。
          </p>
        ) : null}
        <label className="flex gap-8px text-sm">
          <input
            type="radio"
            name="cloud-model-limit-mode"
            value="platform"
            checked={mode === "platform"}
            disabled={busy || !loaded}
            onChange={() => setMode("platform")}
          />
          平台默认（继承平台窗口和输出限制）
        </label>
        <label className="flex gap-8px text-sm">
          <input
            type="radio"
            name="cloud-model-limit-mode"
            value="custom"
            checked={mode === "custom"}
            disabled={busy || !loaded}
            onChange={() => setMode("custom")}
          />
          自定义窗口与最大输出
        </label>
        <label className="flex flex-col gap-8px text-sm">
          上下文窗口
          <input
            aria-label="云端上下文窗口"
            type="number"
            min={1024}
            max={2000000}
            step={1}
            value={context}
            disabled={mode === "platform" || busy || !loaded}
            onChange={(event) => setContext(event.target.value)}
            className="rounded-lg border border-border bg-background p-8px"
          />
        </label>
        <label className="flex flex-col gap-8px text-sm">
          最大输出
          <input
            aria-label="云端最大输出"
            type="number"
            min={128}
            max={1000000}
            step={1}
            value={output}
            disabled={mode === "platform" || busy || !loaded}
            onChange={(event) => setOutput(event.target.value)}
            className="rounded-lg border border-border bg-background p-8px"
          />
        </label>
        {mode === "platform" ? (
          <p className="text-sm text-muted-foreground">
            新任务将省略这两项限制，由平台决定。此选择不会关闭平台缓存，也不会改变设备端模型设置。
          </p>
        ) : null}
        {busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在同步账户设置…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-8px">
          <button
            type="button"
            className="rounded-lg border border-border px-12px py-6px text-sm"
            onClick={props.onClose}
          >
            关闭参数
          </button>
          {error ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void load()}
              className="rounded-lg border border-border px-12px py-6px text-sm"
            >
              重新读取账户设置
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy || !loaded || needsReload}
            onClick={() => void save()}
            className="rounded-lg bg-primary px-12px py-6px text-sm text-primary-foreground disabled:opacity-50"
          >
            保存到账户
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
