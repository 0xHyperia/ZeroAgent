import { ToolApprovalBar } from "@liveagent/ui/components/chat/ToolApprovalBar";
import { useCallback, useSyncExternalStore } from "react";
import {
  answerToolApproval,
  getPendingToolApprovalsSnapshot,
  type PendingToolApprovalSummary,
  subscribeToolApprovalsForConversation,
} from "../../../lib/tools/toolApproval";

type PendingToolApprovalBarProps = {
  conversationId: string;
  approvals?: PendingToolApprovalSummary[];
};

function SubscribedPendingToolApprovalBar({ conversationId }: { conversationId: string }) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToolApprovalsForConversation(conversationId, listener),
    [conversationId],
  );
  const getSnapshot = useCallback(
    () => getPendingToolApprovalsSnapshot(conversationId),
    [conversationId],
  );
  const pending = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return <PendingToolApprovalBarContent conversationId={conversationId} pending={pending} />;
}

function PendingToolApprovalBarContent(props: {
  conversationId: string;
  pending: PendingToolApprovalSummary[];
}) {
  const { conversationId, pending } = props;
  if (pending.length === 0) return null;

  return (
    <ToolApprovalBar
      key={conversationId}
      pending={pending}
      onDecide={(toolCallId, decision, options) =>
        Promise.resolve(answerToolApproval(toolCallId, decision, { conversationId, ...options }))
      }
    />
  );
}

export function PendingToolApprovalBar(props: PendingToolApprovalBarProps) {
  const { conversationId, approvals } = props;
  if (approvals) {
    return <PendingToolApprovalBarContent conversationId={conversationId} pending={approvals} />;
  }
  return <SubscribedPendingToolApprovalBar conversationId={conversationId} />;
}
