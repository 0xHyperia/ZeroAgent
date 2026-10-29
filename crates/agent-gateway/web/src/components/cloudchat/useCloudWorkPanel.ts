import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudAccountGuard } from "@/lib/cloudChatProjects";

export function useCloudWorkPanel(captureGuard: CloudAccountGuard, scope?: string | null) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const pending = useRef<number | null>(null);
  const operation = useRef(0);
  const generation = useRef(0);
  const currentScope = useRef(scope);
  if (currentScope.current !== scope) {
    currentScope.current = scope;
    generation.current++;
    pending.current = null;
  }
  useEffect(() => {
    setBusy(false);
    setError("");
  }, [scope]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      pending.current = null;
    };
  }, []);
  const capture = useCallback(() => {
    const requireAccount = captureGuard();
    const start = generation.current;
    return () => {
      requireAccount();
      if (!mounted.current || start !== generation.current)
        throw new Error("Account changed while the request was pending");
    };
  }, [captureGuard]);
  const run = useCallback(
    async (action: (guard: () => void) => Promise<void>) => {
      if (pending.current !== null) return;
      const guard = capture();
      const token = ++operation.current;
      pending.current = token;
      setBusy(true);
      setError("");
      try {
        await action(guard);
        guard();
      } catch (cause) {
        try {
          guard();
          setError(cause instanceof Error ? cause.message : "云端操作失败，请稍后重试。");
        } catch {
          /* Retired account results cannot update this panel. */
        }
      } finally {
        if (pending.current === token) pending.current = null;
        try {
          guard();
          setBusy(false);
        } catch {
          /* The parent owns account replacement. */
        }
      }
    },
    [capture],
  );
  return { busy, error, setError, capture, run };
}
