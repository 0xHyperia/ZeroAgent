import { RefreshCw } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Switch } from "@liveagent/ui/components/ui/switch";
import type { ModelPickerOption } from "@liveagent/ui/lib/models/modelPickerOptions";
import { toModelValue } from "@liveagent/ui/lib/models/modelValue";
import {
  GenerationModelsCard,
  ModelPreferenceField,
} from "@liveagent/ui/pages/settings/ModelPreferenceFields";
import { ModelPreferencesContent } from "@liveagent/ui/pages/settings/ProvidersSection";
import { useCallback, useEffect, useRef, useState } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import {
  type CloudGenerationSettings,
  type CloudTitlePreferences,
  cloudGenerationSettings,
} from "@/lib/cloudGenerationSettings";
import { getRelayProviderModels, listRelayApiKeys } from "@/lib/relay/client";
import { relayProviderId, relayProviderTypeForPlatform } from "@/lib/relay/providers";
import { CloudImageSettingsSection } from "./CloudImageSettingsSection";
import type { SettingsSectionProps } from "./types";

export function CloudModelPreferencesSection(props: SettingsSectionProps & { ownerId: number }) {
  const [baseline, setBaseline] = useState<CloudGenerationSettings | null>(null);
  const [title, setTitle] = useState<CloudTitlePreferences | null>(null);
  const [options, setOptions] = useState<ModelPickerOption[]>([]);
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const request = useRef<AbortController | null>(null);
  const draftKey = `zeroagent.cloud-title-draft:v1:${props.ownerId}`;
  const restoreDraft = useRef(true);
  const dirty = !!baseline && !!title && JSON.stringify(title) !== JSON.stringify(baseline.title);
  const load = useCallback(
    async (preserveDraft = false) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const guard = captureAccountRequestGuard();
      setLoading(true);
      setError("");
      setNotice("");
      try {
        const [value, keys] = await Promise.all([
          cloudGenerationSettings(undefined, controller.signal),
          listRelayApiKeys(),
        ]);
        const catalogs = await Promise.allSettled(
          keys
            .filter((key) => key.status === "active" && key.key_configured !== false)
            .map(async (key) => {
              const providerType =
                relayProviderTypeForPlatform(key.group?.platform ?? "openai") ?? "codex";
              const raw = (await getRelayProviderModels(key.id, providerType)) as {
                data?: { id: string }[];
              };
              return (raw.data ?? [])
                .filter((model) => typeof model.id === "string")
                .map(
                  (model): ModelPickerOption => ({
                    value: toModelValue(relayProviderId(key.id), model.id),
                    label: model.id,
                    model: model.id,
                    providerId: relayProviderId(key.id),
                    providerName: key.group?.name ?? key.name,
                    providerType,
                  }),
                );
            }),
        );
        guard();
        if (controller.signal.aborted) return;
        let restored: { title: CloudTitlePreferences; version: number } | null = null;
        if (restoreDraft.current) {
          restoreDraft.current = false;
          try {
            const raw = window.sessionStorage.getItem(draftKey);
            const draft = raw && raw.length < 10000 ? JSON.parse(raw) : null;
            const candidate = draft?.title;
            if (
              draft?.owner === props.ownerId &&
              Number.isSafeInteger(draft.version) &&
              candidate &&
              typeof candidate.enabled === "boolean" &&
              Number.isSafeInteger(candidate.provider_key_id) &&
              candidate.provider_key_id >= 0 &&
              typeof candidate.model === "string" &&
              candidate.model.length <= 200 &&
              typeof candidate.reasoning_effort === "string" &&
              candidate.reasoning_effort.length <= 20 &&
              Number.isSafeInteger(candidate.max_output_tokens) &&
              (candidate.max_output_tokens === 0 ||
                (candidate.max_output_tokens >= 256 && candidate.max_output_tokens <= 8192)) &&
              typeof candidate.prompt === "string" &&
              candidate.prompt.length <= 1000
            )
              restored = draft;
          } catch {
            /* An unreadable browser draft cannot change the account setting. */
          }
        }
        setBaseline(
          restored && restored.version !== value.version
            ? { ...value, version: restored.version }
            : value,
        );
        setTitle((previous) =>
          preserveDraft && previous ? previous : (restored?.title ?? value.title),
        );
        setOptions(
          catalogs.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
        );
        setBlocked(!!restored && restored.version !== value.version);
        if (restored)
          setNotice(
            restored.version === value.version
              ? "已恢复未保存的标题设置。"
              : "已恢复编辑草稿；账户设置已更新，请重新读取并核对。",
          );
        if (preserveDraft) setNotice("已读取最新设置，保留了当前编辑。请核对后保存。");
        if (catalogs.some((result) => result.status === "rejected"))
          setError("部分分组暂未载入，可刷新重试。");
      } catch (cause) {
        try {
          guard();
        } catch {
          return;
        }
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取失败。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [draftKey, props.ownerId],
  );
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  useEffect(() => {
    if (loading || !baseline || !title) return;
    try {
      if (dirty)
        window.sessionStorage.setItem(
          draftKey,
          JSON.stringify({ owner: props.ownerId, version: baseline.version, title }),
        );
      else window.sessionStorage.removeItem(draftKey);
    } catch {
      /* Editing and explicit saving remain available without browser storage. */
    }
  }, [baseline, dirty, draftKey, loading, props.ownerId, title]);
  function change(patch: Partial<CloudTitlePreferences>) {
    setTitle((previous) => (previous ? { ...previous, ...patch } : previous));
    setNotice("");
  }
  async function save() {
    if (!baseline || !title || loading || saving || blocked) return;
    const controller = request.current,
      guard = captureAccountRequestGuard();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const value = await cloudGenerationSettings(
        { expected_version: baseline.version, title },
        controller?.signal,
      );
      guard();
      if (controller?.signal.aborted) return;
      setBaseline(value);
      setTitle(value.title);
      setNotice("标题设置已保存");
    } catch (cause) {
      try {
        guard();
      } catch {
        return;
      }
      if (!controller?.signal.aborted) {
        setBlocked(true);
        setError(
          `${cause instanceof Error ? cause.message : "保存结果尚未确认。"} 请先重新读取并核对，当前编辑已保留。`,
        );
      }
    } finally {
      if (!controller?.signal.aborted) setSaving(false);
    }
  }
  const selectedValue = title?.model
    ? toModelValue(relayProviderId(title.provider_key_id), title.model)
    : "";
  const unavailable =
    !!selectedValue && !loading && !options.some((option) => option.value === selectedValue);
  return (
    <ModelPreferencesContent
      {...props}
      providerType="codex"
      showRequestPreferences={false}
      generationModels={
        <GenerationModelsCard>
          <ModelPreferenceField
            label="标题生成模型"
            hint="生成对话标题使用的模型，未选择时跟随当前对话模型。"
            options={options}
            value={selectedValue}
            onChange={(value) => {
              const option = options.find((item) => item.value === value);
              if (value && !option) return;
              change({
                model: option?.model ?? "",
                provider_key_id: option ? Number(option.providerId?.replace("relay-key-", "")) : 0,
              });
            }}
            disabled={!title || loading || saving || blocked}
            placeholder={unavailable ? `${title?.model}（暂不可用）` : "使用当前对话模型"}
            noneLabel="使用当前对话模型"
          />
          <div className="flex items-start justify-between gap-3 border-t border-border/50 pt-3">
            <div className="space-y-1">
              <div className="text-sm font-medium">自动生成标题</div>
              <p className="text-xs leading-5 text-muted-foreground">
                新对话首次回复后生成标题，会产生一次模型调用。失败时保留原标题。
              </p>
            </div>
            <Switch
              aria-label="自动生成标题"
              checked={title?.enabled ?? false}
              disabled={!title || loading || saving || blocked}
              onCheckedChange={(value) => change({ enabled: value === true })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!dirty || loading || saving || blocked || (title?.enabled && unavailable)}
              onClick={() => void save()}
            >
              {saving ? "正在保存…" : "保存标题设置"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={loading || saving}
              onClick={() => void load(dirty || blocked)}
            >
              <RefreshCw className="size-3.5" />
              {blocked ? "重新读取并核对" : "刷新"}
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              {loading ? "正在读取…" : notice || (dirty ? "有未保存的修改" : "")}
            </span>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </GenerationModelsCard>
      }
      media={<CloudImageSettingsSection />}
      clarifyControls={null}
    />
  );
}
