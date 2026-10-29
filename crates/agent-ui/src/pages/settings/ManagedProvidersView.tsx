import type { ProviderId } from "@liveagent/app/lib/settings";
import { useRef, useState } from "react";
import { Copy, Loader2, Plus, RefreshCw, Settings } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ProviderBrandIcon } from "./ProviderPresentation";

export type ManagedProviderGroup = {
  id: number;
  name: string;
  protocol: ProviderId;
  protocolLabel: string;
  rateMultiplier?: number;
  description?: string | null;
};

export type ManagedProviderKey = {
  id: number;
  name: string;
  maskedKey: string;
  status: string;
  groupId: number | null;
  groupName: string;
  protocol: ProviderId | null;
  protocolLabel: string;
  canEditModels: boolean;
  enabledModels: number;
};

export function ManagedProvidersView(props: {
  keys: ManagedProviderKey[];
  groups: ManagedProviderGroup[];
  loading: boolean;
  busy: boolean;
  onCreate: (groupId: number, name: string) => Promise<void>;
  onCopy: (keyId: number) => void;
  onOpenModels: (keyId: number) => void;
  onRefresh: () => void;
  onOpenPreferences?: () => void;
}) {
  const [connecting, setConnecting] = useState<ManagedProviderGroup | null>(null);
  const [keyName, setKeyName] = useState("ZeroAgent");
  const [createError, setCreateError] = useState("");
  const creationInFlight = useRef(false);
  const connectedIds = new Set(
    props.keys.filter((key) => key.status === "active").map((key) => key.groupId),
  );
  const available = props.groups.filter((group) => !connectedIds.has(group.id));
  const configured = new Map<string, ManagedProviderKey[]>();
  for (const key of props.keys) {
    const id = key.groupId === null ? `key-${key.id}` : String(key.groupId);
    configured.set(id, [...(configured.get(id) ?? []), key]);
  }

  async function connect() {
    if (!connecting || !keyName.trim() || props.busy || creationInFlight.current) return;
    creationInFlight.current = true;
    setCreateError("");
    try {
      await props.onCreate(connecting.id, keyName.trim());
      setConnecting(null);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "连接分组失败，请重试。");
    } finally {
      creationInFlight.current = false;
    }
  }

  return (
    <div className="space-y-8" data-managed-providers>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          使用 USA-零 的模型分组。模型和参数可独立配置。
        </p>
        <div className="flex items-center gap-2">
          {props.onOpenPreferences ? (
            <Button variant="outline" size="sm" onClick={props.onOpenPreferences}>
              <Settings className="size-4" />
              高级设置
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={props.loading || props.busy}
            onClick={props.onRefresh}
          >
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </div>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">
          已配置分组{" "}
          <span className="ml-1 font-normal text-muted-foreground">{configured.size}</span>
        </h3>
        {props.loading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : configured.size === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            还没有连接的分组，请在下方选择。
          </p>
        ) : (
          <div className="space-y-4">
            {Array.from(configured, ([id, keys]) => (
              <div key={id} className="overflow-hidden rounded-xl border border-border/60">
                <div className="flex items-center gap-3 bg-settings-tile px-4 py-3">
                  {keys[0].protocol && <ProviderBrandIcon type={keys[0].protocol} />}
                  <div className="min-w-0 flex-1">
                    <h4 className="truncate text-sm font-medium">{keys[0].groupName}</h4>
                    <p className="mt-0.5 text-xs text-muted-foreground">{keys[0].protocolLabel}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">{keys.length} 个密钥</span>
                </div>
                <div className="divide-y divide-border/60">
                  {keys.map((key) => (
                    <div key={key.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{key.name}</span>
                          {key.status !== "active" && (
                            <span className="text-xs text-muted-foreground">{key.status}</span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="font-mono">{key.maskedKey}</span>
                          {key.canEditModels && <span>已启用 {key.enabledModels} 个模型</span>}
                        </div>
                      </div>
                      {key.canEditModels && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={props.busy}
                          onClick={() => props.onOpenModels(key.id)}
                        >
                          模型与参数
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="验证密码后复制密钥"
                        aria-label={`复制密钥 ${key.name}`}
                        onClick={() => props.onCopy(key.id)}
                      >
                        <Copy className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          密钥默认隐藏，复制时需要验证 USA-零 账户密码。
        </p>
      </section>

      {!props.loading && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">可连接分组</h3>
          {available.length === 0 ? (
            <p className="text-sm text-muted-foreground">所有可用分组均已连接。</p>
          ) : (
            <div className="divide-y divide-border/60 rounded-xl border border-border/60">
              {available.map((group) => (
                <div key={group.id} className="flex items-center gap-3 px-4 py-3">
                  <ProviderBrandIcon type={group.protocol} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{group.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {group.protocolLabel}
                      {typeof group.rateMultiplier === "number" && <> · {group.rateMultiplier}×</>}
                    </p>
                    {group.description && (
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {group.description}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={props.busy}
                    onClick={() => {
                      setConnecting(group);
                      setKeyName("ZeroAgent");
                      setCreateError("");
                    }}
                  >
                    <Plus className="size-4" />
                    连接
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <Dialog
        open={connecting !== null}
        onOpenChange={(open) => {
          if (!open && !props.busy) setConnecting(null);
        }}
      >
        <DialogContent className="max-w-md" showCloseButton={!props.busy}>
          <DialogHeader>
            <DialogTitle>连接分组</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div>
              <p className="text-sm font-medium">{connecting?.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {connecting?.protocolLabel}
                {typeof connecting?.rateMultiplier === "number" && (
                  <> · {connecting.rateMultiplier}×</>
                )}
              </p>
              {connecting?.description && (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {connecting.description}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="managed-key-name">密钥名称</Label>
              <Input
                id="managed-key-name"
                value={keyName}
                maxLength={80}
                disabled={props.busy}
                onChange={(event) => setKeyName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void connect();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                为这个分组创建一个专用密钥并连接到 ZeroAgent。
              </p>
            </div>
            {createError && (
              <p role="alert" className="text-sm text-destructive">
                {createError}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={props.busy} onClick={() => setConnecting(null)}>
              取消
            </Button>
            <Button disabled={props.busy || !keyName.trim()} onClick={() => void connect()}>
              {props.busy && <Loader2 className="size-4 animate-spin" />}连接
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
