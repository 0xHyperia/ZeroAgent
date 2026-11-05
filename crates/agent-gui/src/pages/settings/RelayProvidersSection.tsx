import { CheckCircle2 } from "@liveagent/ui/components/IconSet";
import { ManagedProvidersView } from "@liveagent/ui/pages/settings/ManagedProvidersView";
import { ProviderModal } from "@liveagent/ui/pages/settings/ProviderModal";
import { ProviderSettingsDialog } from "@liveagent/ui/pages/settings/ProvidersSection";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RelayKeyCopyDialog } from "../../components/relay/RelayKeyCopyDialog";
import {
  createRelayApiKeys,
  getRelayCurrentUser,
  listRelayApiKeys,
  listRelayGroups,
  type RelayApiKey,
  type RelayGroup,
  type RelayUser,
  revealRelayApiKey,
} from "../../lib/relay/client";
import { managedModelBinding } from "../../lib/relay/managedCredentials";
import {
  applyRelayProviderModelSettings,
  bindRelayKeysToSettings,
  relayProviderId,
  relayProviderTypeForPlatform,
} from "../../lib/relay/providers";
import type { SettingsSectionProps } from "./types";

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return fallback;
}

function maskKey(value: string) {
  const key = value.trim();
  if (key.length <= 12) return `${key.slice(0, 3)}••••••`;
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}

function platformLabel(platform: string) {
  switch (relayProviderTypeForPlatform(platform)) {
    case "claude_code":
      return "Claude";
    case "codex":
      return "OpenAI / Codex";
    case "gemini":
      return "Gemini";
    default:
      return platform;
  }
}

export function RelayProvidersSection({
  settings,
  setSettings,
  onOpenModelPreferences,
}: SettingsSectionProps & { onOpenModelPreferences?: () => void }) {
  const [user, setUser] = useState<RelayUser | null>(null);
  const [keys, setKeys] = useState<RelayApiKey[]>([]);
  const [groups, setGroups] = useState<RelayGroup[]>([]);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [copyTarget, setCopyTarget] = useState<RelayApiKey | null>(null);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const editingProvider = settings.customProviders.find(
    (provider) => provider.id === editingProviderId,
  );
  const editingBinding = editingProviderId ? managedModelBinding(editingProviderId) : undefined;
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const settingsRef = useRef(settings);
  const setSettingsRef = useRef(setSettings);
  settingsRef.current = settings;
  setSettingsRef.current = setSettings;

  const usableGroups = useMemo(
    () =>
      groups.filter(
        (group) => group.status === "active" && relayProviderTypeForPlatform(group.platform),
      ),
    [groups],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [currentUser, currentKeys, availableGroups] = await Promise.all([
        getRelayCurrentUser(),
        listRelayApiKeys(),
        listRelayGroups(),
      ]);
      setUser(currentUser);
      setKeys(currentKeys);
      setGroups(availableGroups);
      const nextSettings = await bindRelayKeysToSettings(
        settingsRef.current,
        currentKeys,
        availableGroups,
        true,
      );
      setSettingsRef.current(() => nextSettings);
    } catch (cause) {
      setError(errorMessage(cause, "加载 USA-零 账户失败。"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function createKey(groupId: number, keyName: string) {
    if (!keyName.trim()) throw new Error("请输入密钥名称。");
    if (!usableGroups.some((group) => group.id === groupId))
      throw new Error("此分组当前不可用，请刷新后重试。");
    if (
      keys.some((key) => key.status === "active" && (key.group?.id ?? key.group_id) === groupId)
    ) {
      throw new Error("这个分组已连接，请使用已有密钥。");
    }
    setCreating(true);
    setError("");
    setSuccess("");
    try {
      const created = await createRelayApiKeys(keyName.trim(), [groupId], groups);
      const createdIds = new Set(created.map((key) => key.id));
      setKeys((previous) => [...previous.filter((key) => !createdIds.has(key.id)), ...created]);
      try {
        const currentKeys = await listRelayApiKeys();
        setKeys(currentKeys);
        const next = await bindRelayKeysToSettings(settingsRef.current, currentKeys, groups, true);
        setSettingsRef.current(() => next);
        setSuccess("分组已连接，可以配置模型与参数。");
      } catch {
        setError("密钥已创建，模型同步暂未完成。请点击刷新重试，无需再次创建密钥。");
      }
    } catch (cause) {
      setError(errorMessage(cause, "创建密钥失败。"));
      throw cause;
    } finally {
      setCreating(false);
    }
  }

  function groupForKey(key: RelayApiKey) {
    return key.group ?? groups.find((group) => group.id === key.group_id);
  }

  async function copyKeyAfterPassword(password: string) {
    if (!copyTarget || !user?.email) throw new Error("无法读取当前 USA-零 账户。");
    const value = await revealRelayApiKey(copyTarget.id, password);
    await navigator.clipboard.writeText(value);
    setSuccess(`密钥“${copyTarget.name}”已复制到剪贴板。`);
  }

  return (
    <div className="min-h-0 w-full min-w-0 flex-1 space-y-6 overflow-y-auto pr-1">
      <ManagedProvidersView
        keys={keys.map((key) => {
          const group = groupForKey(key);
          const provider = settings.customProviders.find(
            (item) => item.id === relayProviderId(key.id),
          );
          return {
            id: key.id,
            name: key.name,
            maskedKey: maskKey(key.key),
            status: key.status,
            groupId: group?.id ?? key.group_id ?? null,
            groupName: group?.name ?? "未分组",
            protocol: group ? relayProviderTypeForPlatform(group.platform) : null,
            protocolLabel: group ? platformLabel(group.platform) : "不可绑定",
            canEditModels: key.status === "active" && Boolean(provider),
            enabledModels: provider?.activeModels.length ?? 0,
          };
        })}
        groups={usableGroups.flatMap((group) => {
          const protocol = relayProviderTypeForPlatform(group.platform);
          return protocol
            ? [
                {
                  id: group.id,
                  name: group.name,
                  protocol,
                  protocolLabel: platformLabel(group.platform),
                  rateMultiplier: group.rate_multiplier,
                  description: group.description,
                },
              ]
            : [];
        })}
        loading={loading}
        busy={creating}
        onCreate={createKey}
        onCopy={(keyId) => setCopyTarget(keys.find((key) => key.id === keyId) ?? null)}
        onOpenModels={(keyId) => setEditingProviderId(relayProviderId(keyId))}
        onRefresh={() => void loadData()}
        onOpenPreferences={onOpenModelPreferences ?? (() => setPreferencesOpen(true))}
      />
      {preferencesOpen && (
        <ProviderSettingsDialog
          settings={settings}
          setSettings={setSettings}
          providerType={settings.customProviders[0]?.type ?? "codex"}
          onClose={() => setPreferencesOpen(false)}
        />
      )}

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {success}
        </div>
      )}
      {editingProvider && editingBinding && (
        <ProviderModal
          key={editingProvider.id}
          providerType={editingProvider.type}
          initialData={{
            ...editingProvider,
            baseUrl: editingBinding.baseUrl,
            apiKey: editingBinding.apiKey,
          }}
          connectionManaged
          onClose={() => setEditingProviderId(null)}
          onSave={(draft) => {
            try {
              const next = applyRelayProviderModelSettings(
                settingsRef.current,
                editingProvider.id,
                draft,
              );
              setSettings(() => next);
              setEditingProviderId(null);
              setSuccess("模型设置已保存。");
            } catch (cause) {
              setError(errorMessage(cause, "保存模型设置失败。"));
            }
          }}
        />
      )}
      <RelayKeyCopyDialog
        key={copyTarget?.id ?? "closed"}
        keyName={copyTarget?.name ?? null}
        onClose={() => setCopyTarget(null)}
        onConfirm={copyKeyAfterPassword}
      />
    </div>
  );
}
