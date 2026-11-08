import { type ModelPickerOption, modelPickerTypes } from "@liveagent/ui/lib/models/modelPickerOptions";
import { modelListEntries } from "@liveagent/ui/lib/models/modelTypes";
import { toModelValue } from "@liveagent/ui/lib/models/modelValue";
import { ImageModelPreference } from "@liveagent/ui/pages/settings/ModelPreferenceFields";
import { useCallback, useEffect, useRef, useState } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import { type CloudImageSettings, cloudImageSettings } from "@/lib/cloudImageSettings";
import { getRelayProviderModels, listRelayApiKeys } from "@/lib/relay/client";
import { relayProviderId, relayProviderTypeForPlatform } from "@/lib/relay/providers";

export function CloudImageSettingsSection() {
  const [value, setValue] = useState<CloudImageSettings | null>(null);
  const [options, setOptions] = useState<ModelPickerOption[]>([]);
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [blocked, setBlocked] = useState(false);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
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
          const providerType =
            relayProviderTypeForPlatform(key.group?.platform ?? "openai") ?? "codex";
          return modelListEntries(await getRelayProviderModels(key.id, providerType))
            .map(
              (model): ModelPickerOption => ({
                value: toModelValue(relayProviderId(key.id), model.id),
                label: model.id,
                model: model.id,
                modelTypes: model.modelTypes,
                providerId: relayProviderId(key.id),
                providerName: key.group?.name ?? key.name,
                providerType,
              }),
            )
            .filter((option) => modelPickerTypes(option).includes("image"));
        }),
      );
      guard();
      if (controller.signal.aborted) return;
      setValue(preference);
      setBlocked(false);
      setOptions(catalogs.flatMap((result) => (result.status === "fulfilled" ? result.value : [])));
      if (catalogs.some((result) => result.status === "rejected"))
        setError("部分分组暂未载入，请重新读取。");
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "读取失败，请重试。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  async function save(option?: ModelPickerOption) {
    if (!value || saving || blocked) return;
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
      if (!request.current?.signal.aborted) {
        setBlocked(true);
        setError(
          `${cause instanceof Error ? cause.message : "保存结果尚未确认。"} 请先重新读取设置并核对。`,
        );
      }
    } finally {
      if (!request.current?.signal.aborted) setSaving(false);
    }
  }
  return (
    <ImageModelPreference
      options={options}
      value={value?.model ? toModelValue(relayProviderId(value.provider_key_id), value.model) : ""}
      loading={loading}
      saving={saving}
      disabled={blocked || !value}
      error={error}
      notice={notice}
      onRefresh={() => void load()}
      onChange={(id) => {
        const option = options.find((option) => option.value === id);
        if (id && !option) return;
        void save(option);
      }}
    />
  );
}
