import { ChevronDown, ImageIcon, RefreshCw } from "@liveagent/ui/components/IconSet";
import { ModelPickerContent } from "@liveagent/ui/components/models/ModelPickerContent";
import { ProviderBrandIcon } from "@liveagent/ui/components/ProviderBrandIcon";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import type { ModelPickerOption } from "@liveagent/ui/lib/models/modelPickerOptions";
import { toModelValue } from "@liveagent/ui/lib/models/modelValue";
import { useEffect, useRef, useState } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import { cloudImageSettings, type CloudImageSettings } from "@/lib/cloudImageSettings";
import { getRelayProviderModels, listRelayApiKeys } from "@/lib/relay/client";
import { relayProviderId, relayProviderTypeForPlatform } from "@/lib/relay/providers";

export function CloudImageSettingsSection() {
  const [value, setValue] = useState<CloudImageSettings | null>(null);
  const [options, setOptions] = useState<ModelPickerOption[]>([]);
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const request = useRef<AbortController | null>(null);
  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const guard = captureAccountRequestGuard();
    setLoading(true);
    setError("");
    try {
      const [preference, keys] = await Promise.all([
        cloudImageSettings(undefined, controller.signal),
        listRelayApiKeys(),
      ]);
      const usable = keys.filter((key) => key.status === "active" && key.key_configured !== false);
      const catalogs = await Promise.allSettled(
        usable.map(async (key) => {
          const raw = (await getRelayProviderModels(
            key.id,
            relayProviderTypeForPlatform(key.group?.platform ?? "openai") ?? "codex",
          )) as { data?: { id: string }[] };
          return (raw.data ?? [])
            .filter((model) => typeof model.id === "string")
            .map(
              (model): ModelPickerOption => ({
                value: toModelValue(relayProviderId(key.id), model.id),
                label: model.id,
                model: model.id,
                providerId: relayProviderId(key.id),
                providerName: key.group?.name ?? key.name,
                providerType:
                  relayProviderTypeForPlatform(key.group?.platform ?? "openai") ?? "codex",
              }),
            );
        }),
      );
      guard();
      if (controller.signal.aborted) return;
      setValue(preference);
      setOptions(catalogs.flatMap((result) => (result.status === "fulfilled" ? result.value : [])));
      if (catalogs.some((result) => result.status === "rejected"))
        setError("部分分组暂未载入，刷新后可重新读取。");
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "读取失败，请重试。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, []);
  const selected = options.find(
    (option) =>
      value && option.value === toModelValue(relayProviderId(value.provider_key_id), value.model),
  );
  async function save(option?: ModelPickerOption) {
    if (!value || saving) return;
    setOpen(false);
    setSaving(true);
    setError("");
    setNotice("");
    const guard = captureAccountRequestGuard();
    try {
      const result = await cloudImageSettings(
        {
          expected_version: value.version,
          provider_key_id: option ? Number(option.providerId?.replace("relay-key-", "")) : 0,
          model: option?.model ?? "",
        },
        request.current?.signal,
      );
      guard();
      if (request.current?.signal.aborted) return;
      setValue(result);
      setNotice("已保存");
    } catch (cause) {
      if (!request.current?.signal.aborted)
        setError(cause instanceof Error ? cause.message : "保存失败，请刷新后重试。");
    } finally {
      if (!request.current?.signal.aborted) setSaving(false);
    }
  }
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <p className="text-sm leading-6 text-muted-foreground">
        在对话中生成图片，或使用已有图片继续创作。
      </p>
      <section className="space-y-3">
        <h3 className="text-sm font-medium">默认生图模型</h3>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-muted/50 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ImageIcon className="size-4" />
              ImageGen
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              选择支持图像生成的模型，供 ImageGen 与 Product Design 使用。
            </p>
          </div>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  disabled={loading || saving || !value}
                  className="max-w-full rounded-xl bg-background"
                />
              }
            >
              {selected ? (
                <ProviderBrandIcon
                  type={selected.providerType}
                  model={selected.model}
                  className="size-4"
                />
              ) : null}
              <span className="max-w-64 truncate">
                {loading ? "正在读取…" : saving ? "正在保存…" : value?.model || "选择生图模型"}
              </span>
              <ChevronDown className="size-3.5" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(420px,calc(100vw-32px))] p-1.5">
              <ModelPickerContent
                options={options}
                value={selected?.value}
                revealSelected
                refreshing={loading}
                onRefresh={load}
                onSelect={(id) => void save(options.find((option) => option.value === id))}
              />
            </PopoverContent>
          </Popover>
        </div>
        {selected ? (
          <p className="px-1 text-xs text-muted-foreground">
            {selected.providerName} · {selected.label}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={loading || saving}
            onClick={() => void load()}
          >
            <RefreshCw className="size-3.5" />
            刷新模型
          </Button>
          {value?.model ? (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save()}>
              清除默认模型
            </Button>
          ) : null}
          <span role="status" className="ml-auto text-xs text-muted-foreground">
            {notice}
          </span>
        </div>
        {error ? (
          <div role="alert" className="rounded-xl bg-muted/50 px-4 py-3 text-sm">
            {error}
          </div>
        ) : null}
      </section>
      <p className="text-sm leading-6 text-muted-foreground">
        未设置时，ZeroAgent
        会在需要生图时引导你配置。生成的图片保存在你的资料空间，修改会保留原图并创建新版本。
      </p>
    </div>
  );
}
