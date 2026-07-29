import { useCallback, useEffect, useState } from "react";

import {
  canReuseDeviceSelection,
  type ExecutionEnvironment,
  type ExecutionSelection,
  type ExecutionWorkspace,
  encodeSelectionCredential,
  getExecutionEnvironments,
  selectExecutionTarget,
  validateExecutionSelection,
} from "@/lib/executionTargets";
import { GATEWAY_SELECTION_INVALID_EVENT, resetGatewayWebSocketClient } from "@/lib/gatewaySocket";
import {
  getRelayCurrentUser,
  loginRelay,
  loginRelay2FA,
  logoutRelay,
  type RelayUser,
  registerRelay,
} from "@/lib/relay/client";
import { createUuid } from "@/lib/shared/id";
import { setEphemeralCredential } from "@/lib/storage";

const EXECUTION_SELECTION_HISTORY_KEY = "zeroagentExecutionSelection";

function readHistorySelection(): ExecutionSelection | null {
  const value = window.history.state?.[EXECUTION_SELECTION_HISTORY_KEY] as
    | Partial<ExecutionSelection>
    | undefined;
  if (
    value?.runtime_kind !== "device_agent" ||
    !value.selection_lease?.trim() ||
    !value.device_id?.trim()
  ) {
    return null;
  }
  if (value.expires_at && Date.parse(value.expires_at) <= Date.now()) return null;
  return value as ExecutionSelection;
}

function persistHistorySelection(selection: ExecutionSelection | null) {
  const state = { ...(window.history.state ?? {}) };
  if (selection?.runtime_kind === "device_agent") {
    state[EXECUTION_SELECTION_HISTORY_KEY] = selection;
  } else {
    delete state[EXECUTION_SELECTION_HISTORY_KEY];
  }
  window.history.replaceState(state, "", window.location.href);
}

export function useGatewaySession(historyShareToken: string | null) {
  const [accountUser, setAccountUser] = useState<RelayUser | null>(null);
  const [environments, setEnvironments] = useState<ExecutionEnvironment[]>([]);
  const [selection, setSelection] = useState<ExecutionSelection | null>(null);
  const [token, setToken] = useState("");
  const [authInitializing, setAuthInitializing] = useState(!historyShareToken);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [twoFactorToken, setTwoFactorToken] = useState("");

  const applyToken = useCallback((next: string) => {
    // Child effects can issue Gateway requests before parent effects run.
    // Publish the credential before the state update makes those children mount.
    setEphemeralCredential(next);
    setToken(next);
  }, []);

  const loadEnvironments = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    const desktopEmbedded = params.get("controller_surface") === "desktop_embed";
    const localDeviceId = params.get("local_device_id")?.trim() ?? "";
    const items = await getExecutionEnvironments(
      desktopEmbedded ? "desktop" : "web",
      localDeviceId,
    );
    setEnvironments(items);
    const handoffLease = params.get("selection_lease")?.trim() ?? "";
    const handoffRuntime = params.get("runtime_kind")?.trim() ?? "";
    const handoffWorkspace = params.get("workspace_id")?.trim() ?? "";
    if (handoffLease && handoffRuntime === "device_agent") {
      const next: ExecutionSelection = {
        selection_lease: handoffLease,
        runtime_kind: "device_agent",
        device_id: params.get("device_id")?.trim() ?? "",
        agent_id: params.get("agent_id")?.trim() || params.get("device_id")?.trim() || "",
        workspace_id: handoffWorkspace,
        scope: handoffWorkspace ? "workspace" : "device",
        target_fingerprint: [
          handoffRuntime,
          params.get("device_id")?.trim() ?? "",
          handoffWorkspace,
        ].join(":"),
        conversation_id: params.get("conversation_id")?.trim() || createUuid(),
        expires_at: "",
      };
      const cleanURL = new URL(window.location.href);
      for (const key of [
        "selection_lease",
        "runtime_kind",
        "device_id",
        "agent_id",
        "workspace_id",
        "conversation_id",
      ]) {
        cleanURL.searchParams.delete(key);
      }
      window.history.replaceState(
        { ...(window.history.state ?? {}) },
        "",
        `${cleanURL.pathname}${cleanURL.search}`,
      );
      if (await validateExecutionSelection(next)) {
        setSelection(next);
        applyToken(encodeSelectionCredential(next));
        persistHistorySelection(next);
        return items;
      }
      persistHistorySelection(null);
    }
    const restored = readHistorySelection();
    if (restored) {
      const environment = items.find(
        (item) => item.runtime_kind === "device_agent" && item.device_id === restored.device_id,
      );
      const workspaceIsValid =
        !restored.workspace_id ||
        environment?.workspaces.some((workspace) => workspace.id === restored.workspace_id);
      if (environment && workspaceIsValid && (await validateExecutionSelection(restored))) {
        setSelection(restored);
        applyToken(encodeSelectionCredential(restored));
        return items;
      }
      persistHistorySelection(null);
    }
    setSelection((current) => {
      if (current) return current;
      const web = items.find((item) => item.runtime_kind === "web_chat");
      const workspace = web?.workspaces[0];
      return web && workspace
        ? {
            selection_lease: "",
            runtime_kind: "web_chat",
            workspace_id: workspace.id,
            target_fingerprint: web.target_fingerprint ?? "web_chat::cloud",
            conversation_id: createUuid(),
            expires_at: "",
          }
        : null;
    });
    return items;
  }, [applyToken]);

  useEffect(() => {
    if (historyShareToken) {
      setAuthInitializing(false);
      return;
    }
    let cancelled = false;
    void getRelayCurrentUser()
      .then(async (user) => {
        if (cancelled) return;
        setAccountUser(user);
        await loadEnvironments();
      })
      .catch(() => {
        if (!cancelled) setAccountUser(null);
      })
      .finally(() => {
        if (!cancelled) setAuthInitializing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [historyShareToken, loadEnvironments]);

  useEffect(() => {
    if (!accountUser || historyShareToken) return;
    const timer = window.setInterval(() => {
      void loadEnvironments().catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [accountUser, historyShareToken, loadEnvironments]);

  useEffect(() => {
    const handleInvalidSelection = () => {
      resetGatewayWebSocketClient();
      persistHistorySelection(null);
      setSelection(null);
      applyToken("");
      void loadEnvironments().catch((error) => {
        setAuthError(error instanceof Error ? error.message : "执行环境加载失败");
      });
    };
    window.addEventListener(GATEWAY_SELECTION_INVALID_EVENT, handleInvalidSelection);
    return () =>
      window.removeEventListener(GATEWAY_SELECTION_INVALID_EVENT, handleInvalidSelection);
  }, [applyToken, loadEnvironments]);

  const login = useCallback(
    async (email: string, password: string) => {
      setAuthSubmitting(true);
      setAuthError(null);
      try {
        const response = await loginRelay(email, password);
        if ("requires_2fa" in response && response.requires_2fa) {
          setTwoFactorToken(response.temp_token);
          return "two-factor" as const;
        }
        if (!("user" in response)) return "failed" as const;
        setAccountUser(response.user);
        await loadEnvironments();
        return "authenticated" as const;
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "登录失败");
        return "failed" as const;
      } finally {
        setAuthSubmitting(false);
      }
    },
    [loadEnvironments],
  );

  const verifyTwoFactor = useCallback(
    async (code: string) => {
      setAuthSubmitting(true);
      setAuthError(null);
      try {
        const response = await loginRelay2FA(twoFactorToken, code);
        setAccountUser(response.user);
        setTwoFactorToken("");
        await loadEnvironments();
        return true;
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "两步验证码校验失败");
        return false;
      } finally {
        setAuthSubmitting(false);
      }
    },
    [loadEnvironments, twoFactorToken],
  );

  const register = useCallback(
    async (input: {
      email: string;
      password: string;
      verifyCode?: string;
      invitationCode?: string;
    }) => {
      setAuthSubmitting(true);
      setAuthError(null);
      try {
        const response = await registerRelay(input);
        setAccountUser(response.user);
        await loadEnvironments();
        return true;
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "注册失败");
        return false;
      } finally {
        setAuthSubmitting(false);
      }
    },
    [loadEnvironments],
  );

  const switchExecutionTarget = useCallback(
    async (environment: ExecutionEnvironment, workspace: ExecutionWorkspace) => {
      if (canReuseDeviceSelection(selection, environment)) {
        return selection;
      }
      const next = await selectExecutionTarget(environment, workspace);
      resetGatewayWebSocketClient();
      setSelection(next);
      applyToken(next.runtime_kind === "device_agent" ? encodeSelectionCredential(next) : "");
      persistHistorySelection(next.runtime_kind === "device_agent" ? next : null);
      return next;
    },
    [applyToken, selection],
  );

  const clearSession = useCallback(() => {
    void logoutRelay();
    resetGatewayWebSocketClient();
    setAccountUser(null);
    setEnvironments([]);
    setSelection(null);
    applyToken("");
    persistHistorySelection(null);
    setTwoFactorToken("");
    setAuthError(null);
  }, [applyToken]);

  return {
    token,
    accountUser,
    environments,
    selection,
    authInitializing,
    authSubmitting,
    authError,
    twoFactorRequired: Boolean(twoFactorToken),
    setAuthError,
    login,
    register,
    verifyTwoFactor,
    switchExecutionTarget,
    reloadEnvironments: loadEnvironments,
    clearSession,
  };
}
