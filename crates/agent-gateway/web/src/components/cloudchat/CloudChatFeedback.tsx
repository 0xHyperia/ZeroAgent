import { StatusNotice, type StatusNoticeProps } from "@liveagent/ui/components/ui/status-notice";

/** CloudChat copy only. The shared component owns all presentation. */
export function CloudChatFeedback(props: StatusNoticeProps) {
  return <StatusNotice dismissLabel="关闭提示" {...props} />;
}
