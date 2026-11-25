import { ConversationExecutionLocation } from "@liveagent/ui/components/chat/ConversationExecutionLocation";
import { useLocale } from "@liveagent/ui/i18n";
import type {
  ExecutionEnvironment,
  ExecutionSelection,
  ExecutionWorkspace,
} from "@/lib/executionTargets";

export function ExecutionEnvironmentSwitcher({
  environments,
  selection,
  disabled,
  retryDirectory,
  onManageDevices,
  compact,
  mobileSheet,
  open,
  onOpenChange,
  onSwitch,
}: {
  environments: ExecutionEnvironment[];
  selection: ExecutionSelection | null;
  disabled?: boolean;
  retryDirectory?: () => Promise<unknown>;
  onManageDevices?: () => void;
  compact?: boolean;
  mobileSheet?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSwitch: (environment: ExecutionEnvironment, workspace: ExecutionWorkspace) => Promise<unknown>;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const cloud = { kind: "cloud", name: zh ? "云端" : "Cloud" } as const;
  const selected = environments.find(
    (environment) =>
      environment.runtime_kind === selection?.runtime_kind &&
      (environment.device_id ?? "") === (selection.device_id ?? ""),
  );
  const current =
    selection?.runtime_kind === "device_agent"
      ? { kind: "device" as const, name: selected?.name ?? (zh ? "设备" : "Device") }
      : cloud;
  return (
    <ConversationExecutionLocation
      current={current}
      disabled={disabled}
      retryDirectory={retryDirectory}
      onManageDevices={onManageDevices}
      compact={compact}
      mobileSheet={mobileSheet}
      open={open}
      onOpenChange={onOpenChange}
      choices={environments.map((environment) => ({
        id: environment.device_id ?? "cloud",
        deviceId: environment.device_id,
        retryIdentity: environment.agent_id,
        ...(environment.runtime_kind === "web_chat"
          ? cloud
          : { kind: "device" as const, name: environment.name }),
        selected: environment === selected,
        offline: !environment.online,
        choose:
          environment === selected
            ? undefined
            : () => onSwitch(environment, environment.workspaces[0] ?? { id: "", name: "" }),
      }))}
    />
  );
}
