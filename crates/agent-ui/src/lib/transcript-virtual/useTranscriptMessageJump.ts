import { useEffect, useRef, useState } from "react";

export type TranscriptMessageJump = {
  key: string;
  messageId: string;
  onUnavailable: () => void;
};

export function useTranscriptMessageJump({
  target,
  rowKey,
  historyBoundary,
  hasMoreHistory,
  loadEarlier,
  ready,
  jumpToRow,
}: {
  target?: TranscriptMessageJump;
  rowKey?: string;
  historyBoundary: string;
  hasMoreHistory: boolean;
  loadEarlier: () => Promise<void>;
  ready: boolean;
  jumpToRow: (rowKey: string) => void;
}) {
  const latest = useRef({ target, loadEarlier, jumpToRow });
  latest.current = { target, loadEarlier, jumpToRow };
  const handled = useRef<string | undefined>(undefined);
  const page = useRef<{ targetKey: string; boundary: string; pending: boolean } | null>(null);
  const [pageVersion, setPageVersion] = useState(0);
  const targetKey = target?.key;

  useEffect(
    () => () => {
      page.current = null;
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion advances when a page read settles, even when it contained no new rows.
  useEffect(() => {
    if (!targetKey) {
      handled.current = undefined;
      page.current = null;
      return;
    }
    if (!ready || handled.current === targetKey) return;
    if (rowKey) {
      const frame = requestAnimationFrame(() => {
        handled.current = targetKey;
        latest.current.jumpToRow(rowKey);
      });
      return () => cancelAnimationFrame(frame);
    }
    const previous = page.current;
    if (previous?.targetKey === targetKey && previous.pending) return;
    if (
      !hasMoreHistory ||
      (previous?.targetKey === targetKey && previous.boundary === historyBoundary)
    ) {
      handled.current = targetKey;
      latest.current.target?.onUnavailable();
      return;
    }
    const requested = { targetKey, boundary: historyBoundary, pending: true };
    page.current = requested;
    const settle = () => {
      if (page.current !== requested) return;
      requested.pending = false;
      if (latest.current.target?.key === targetKey) {
        setPageVersion((version) => version + 1);
      }
    };
    void latest.current.loadEarlier().then(settle, settle);
  }, [hasMoreHistory, historyBoundary, pageVersion, ready, rowKey, targetKey]);
}
