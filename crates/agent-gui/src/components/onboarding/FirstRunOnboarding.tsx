import { Check, Key, Loader2, Sparkles } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createRelayApiKeys,
  listRelayApiKeys,
  listRelayGroups,
  type RelayGroup,
} from "../../lib/relay/client";
import { relayProviderTypeForPlatform } from "../../lib/relay/providers";
import { GroupMultiSelect } from "../relay/GroupMultiSelect";

const ONBOARDING_VERSION = "v1";

type RelayApiKey = Awaited<ReturnType<typeof listRelayApiKeys>>[number];

type FirstRunOnboardingProps = {
  userId: number;
  onSyncKeys: (keys: RelayApiKey[], groups: RelayGroup[]) => Promise<void>;
};

function storageKey(userId: number) {
  return `zeroagent.onboarding.${ONBOARDING_VERSION}.${userId}`;
}

function hasCompleted(userId: number) {
  try {
    return localStorage.getItem(storageKey(userId)) === "complete";
  } catch {
    return false;
  }
}

function errorText(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : "设置失败，请稍后重试。";
}

export function FirstRunOnboarding({ userId, onSyncKeys }: FirstRunOnboardingProps) {
  const [open, setOpen] = useState(() => !hasCompleted(userId));
  const [step, setStep] = useState<"welcome" | "key" | "ready">("welcome");
  const [groups, setGroups] = useState<RelayGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [keyName, setKeyName] = useState("ZeroAgent");
  const [loading, setLoading] = useState(open);
  const [creating, setCreating] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);
  const [error, setError] = useState("");
  const onSyncKeysRef = useRef(onSyncKeys);
  onSyncKeysRef.current = onSyncKeys;

  const usableGroups = useMemo(
    () =>
      groups.filter(
        (group) => group.status === "active" && relayProviderTypeForPlatform(group.platform),
      ),
    [groups],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([listRelayApiKeys(), listRelayGroups()])
      .then(([keys, availableGroups]) => {
        if (cancelled) return;
        const activeKeys = keys.filter(
          (key) => key.status === "active" && key.group_id != null && key.key.trim(),
        );
        setGroups(availableGroups);
        setNeedsKey(activeKeys.length === 0);
        const first = availableGroups.find(
          (group) => group.status === "active" && relayProviderTypeForPlatform(group.platform),
        );
        setSelectedGroupIds(first ? [first.id] : []);
        if (activeKeys.length > 0) {
          void onSyncKeysRef.current(activeKeys, availableGroups).catch((cause) => {
            if (!cancelled) setError(errorText(cause));
          });
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function complete() {
    try {
      localStorage.setItem(storageKey(userId), "complete");
    } catch {
      // The guide still closes when storage is unavailable.
    }
    setOpen(false);
  }

  async function createKeys() {
    if (!keyName.trim() || selectedGroupIds.length === 0) return;
    setCreating(true);
    setError("");
    try {
      await createRelayApiKeys(keyName.trim(), selectedGroupIds, groups);
      const keys = await listRelayApiKeys();
      await onSyncKeysRef.current(keys, groups);
      setNeedsKey(false);
      setStep("ready");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && complete()}>
      <DialogContent
        className="flex max-h-[min(680px,calc(100vh-2rem))] max-w-xl flex-col overflow-hidden p-0"
        closeLabel="跳过引导"
        showCloseButton
      >
        <div className="min-h-0 overflow-y-auto px-6 py-7 sm:px-8">
          {step === "welcome" ? (
            <div className="space-y-7">
              <div>
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Sparkles className="h-5 w-5" />
                </div>
                <DialogTitle className="text-2xl leading-normal">开始使用 ZeroAgent</DialogTitle>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  完成一次基础设置后，就可以在网页端、桌面端和已连接设备之间继续工作。
                </p>
              </div>

              <div className="divide-y divide-border border-y border-border">
                <div className="flex gap-3 py-4">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <p className="text-sm font-medium">账户已连接</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      配置会跟随当前账户和设备保存。
                    </p>
                  </div>
                </div>
                <div className="flex gap-3 py-4">
                  <Key className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <p className="text-sm font-medium">模型分组</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      每个分组密钥提供对应分组可用的模型。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : step === "key" ? (
            <div className="space-y-6">
              <div>
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Key className="h-5 w-5" />
                </div>
                <DialogTitle className="text-xl leading-normal">创建第一个分组密钥</DialogTitle>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  选择需要使用的模型分组。创建完成后，模型会自动加入模型选择器。
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="onboarding-key-name">密钥名称</Label>
                <Input
                  id="onboarding-key-name"
                  value={keyName}
                  maxLength={80}
                  onChange={(event) => setKeyName(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="onboarding-key-groups">模型分组</Label>
                <GroupMultiSelect
                  id="onboarding-key-groups"
                  groups={usableGroups}
                  selectedIds={selectedGroupIds}
                  onChange={setSelectedGroupIds}
                  disabled={creating}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-6 py-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-600">
                <Check className="h-6 w-6" />
              </div>
              <div>
                <DialogTitle className="text-xl leading-normal">设置完成</DialogTitle>
                <p className="mt-2 text-sm text-muted-foreground">
                  分组模型已经可以在模型选择器中使用。
                </p>
              </div>
            </div>
          )}
          {error ? (
            <p className="mt-5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-6 py-4 sm:px-8">
          <Button variant="ghost" onClick={complete}>
            跳过
          </Button>
          {step === "welcome" ? (
            <Button disabled={loading} onClick={() => setStep(needsKey ? "key" : "ready")}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {loading ? "检查配置" : "继续"}
            </Button>
          ) : step === "key" ? (
            <Button
              disabled={creating || selectedGroupIds.length === 0 || !keyName.trim()}
              onClick={() => void createKeys()}
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Key className="h-4 w-4" />
              )}
              {creating ? "创建中" : "创建并同步"}
            </Button>
          ) : (
            <Button onClick={complete}>进入 ZeroAgent</Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
