import { Button } from "@liveagent/ui/components/ui/button";
import { StatusNotice } from "@liveagent/ui/components/ui/status-notice";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useRef, useState } from "react";
import type { GatewaySavedDeviceDraftState } from "./gatewayDeviceDraftRecovery";

type Props = {
  unavailable: boolean;
  connectionLost: boolean;
  agentOnline?: boolean;
  statusReadFailed: boolean;
  draftEditable?: boolean;
  onReconnect: () => Promise<unknown>;
};

export function GatewayDeviceConnectionNotice({
  unavailable,
  connectionLost,
  agentOnline,
  statusReadFailed,
  draftEditable = false,
  onReconnect,
}: Props) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const reconnectingRef = useRef(false);
  const [reconnecting, setReconnecting] = useState(false);
  if (!unavailable || (!connectionLost && agentOnline === undefined && !statusReadFailed))
    return null;

  const checking = !connectionLost && agentOnline === true && !statusReadFailed;
  const busy = reconnecting || checking;
  let message = zh ? "暂时无法连接设备" : "Couldn't reach the device";
  if (reconnecting) message = zh ? "正在重新连接…" : "Reconnecting…";
  else if (checking) message = zh ? "正在检查设备连接…" : "Checking the device connection…";
  else if (connectionLost) message = zh ? "连接已中断" : "Connection interrupted";
  else if (agentOnline === false && !statusReadFailed) message = zh ? "设备离线" : "Device offline";

  const reconnect = async () => {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    setReconnecting(true);
    try {
      await onReconnect();
    } catch {
      // The transport publishes its current status independently. Keep the
      // current conversation and leave the action available for another try.
    } finally {
      reconnectingRef.current = false;
      setReconnecting(false);
    }
  };

  return (
    <StatusNotice
      compact
      busy={busy}
      tone={busy ? "info" : "warning"}
      message={message}
      description={
        draftEditable
          ? zh
            ? "可继续编辑草稿。连接恢复后可以发送和添加文件。"
            : "Keep editing your draft. Send or add files once connected."
          : zh
            ? "草稿已保留。连接恢复后即可发送。"
            : "Your draft is kept. You can send once connected."
      }
      actions={
        !checking || reconnecting ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-disabled={reconnecting}
            onClick={reconnect}
          >
            {zh ? "重新连接" : "Reconnect"}
          </Button>
        ) : undefined
      }
      className="mx-5 mt-3 shrink-0 max-sm:mx-3"
    />
  );
}

export function GatewaySavedDeviceDraftNotice({
  state,
  path,
  onRetry,
}: {
  state: GatewaySavedDeviceDraftState;
  path?: string;
  onRetry: () => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const hints = {
    saved: zh
      ? "可在空白对话中恢复正文和附件。"
      : "Restore the text and attachments in an empty conversation.",
    workspace: zh
      ? "原工作区暂不可用。工作区恢复后可以重试。"
      : "The original workspace is unavailable. Try again once it returns.",
    "work-mode": zh
      ? "切回工作模式后即可恢复正文和附件。"
      : "Switch back to Work to restore the text and attachments.",
    "current-draft": zh
      ? "当前草稿已保留在侧栏。请打开空白的设备对话后重试。"
      : "Your current draft is in the sidebar. Open an empty device conversation to try again.",
  };
  return (
    <StatusNotice
      compact
      tone={state === "workspace" ? "warning" : "info"}
      message={zh ? "有一份设备草稿待恢复" : "An unsent device draft is saved in this tab"}
      description={
        <>
          {hints[state]}
          {path ? <span className="block break-all">{path}</span> : null}
        </>
      }
      actions={
        <Button type="button" size="sm" variant="ghost" onClick={onRetry}>
          {zh ? "重试恢复" : "Retry restoring draft"}
        </Button>
      }
      className="mx-5 mt-3 shrink-0 max-sm:mx-3"
    />
  );
}
