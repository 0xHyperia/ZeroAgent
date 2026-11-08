import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImageStudioClient, ImageTarget } from "../../lib/imaging/types";
import { updateCustomSettings } from "../../lib/settings";
import { ImageModelPreference } from "./ModelPreferenceFields";

export function DeviceImageModelPreferences({
  settings,
  setSettings,
  client,
}: SettingsSectionProps & { client?: ImageStudioClient }) {
  const [targets, setTargets] = useState<ImageTarget[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const load = useCallback(async () => {
    if (!client) return;
    const request = ++epoch.current;
    setLoading(true);
    setError("");
    try {
      // This endpoint includes provider-derived models as well as manual targets.
      const available = await client.listTargets();
      if (epoch.current === request) setTargets(available);
    } catch (cause) {
      if (epoch.current === request)
        setError(cause instanceof Error ? cause.message : "生图模型暂时无法读取。");
    } finally {
      if (epoch.current === request) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    setTargets(null);
    const unsubscribe = client?.subscribeSettingsSaved?.(() => void load());
    return () => {
      epoch.current++;
      unsubscribe?.();
    };
  }, [client, load]);
  // Ordinary provider changes can add or retire derived image models.
  useEffect(() => {
    void settings.customProviders;
    void load();
  }, [settings.customProviders, load]);
  const options = useMemo(
    () =>
      (targets ?? [])
        .filter((target) => target.enabled && target.capabilities.operations.includes("generate"))
        .map((target) => {
          const provider = settings.customProviders.find((item) => item.id === target.providerId);
          const model = target.modelId || target.remoteId;
          const configured = provider?.models.find((item) => item.id === model);
          // Target labels can include the provider name. Split presentation
          // only; execution always keeps the server-issued target identity.
          const separator = target.name.lastIndexOf(" · ");
          const label = separator >= 0 ? target.name.slice(separator + 3) : target.name;
          return {
            value: target.id,
            label: configured?.displayName || label || model,
            model,
            modelTypes: ["image"] as const,
            providerId: provider?.id ?? target.providerId ?? target.connectionId,
            providerName:
              provider?.name ?? (separator >= 0 ? target.name.slice(0, separator) : "图像模型"),
            providerType: provider?.type,
          };
        }),
    [targets, settings.customProviders],
  );
  return (
    <ImageModelPreference
      options={options}
      value={settings.customSettings.imageGenerationTargetId ?? ""}
      loading={loading}
      disabled={!client || targets === null}
      error={!client ? "连接设备的图像服务后可配置。" : error}
      onRefresh={client ? () => void load() : undefined}
      onChange={(id) => {
        if (id && !options.some((option) => option.value === id)) return;
        setSettings((previous) =>
          updateCustomSettings(previous, { imageGenerationTargetId: id || undefined }),
        );
      }}
    />
  );
}
