import { createUuid } from "@liveagent/ui/lib/shared/id";
import { useCallback, useEffect, useRef, useState } from "react";
import { bindAccountRequests } from "@/lib/accountRequest";
import {
  type DesktopRemoteHost,
  getDesktopRemoteHost,
  requireCurrentDesktopRemoteHost,
} from "@/lib/desktopRemoteHost";
import {
  canReuseDeviceSelection,
  type ExecutionEnvironment,
  type ExecutionPresence,
  type ExecutionSelection,
  type ExecutionWorkspace,
  encodeSelectionCredential,
  getExecutionEnvironments,
  mergeExecutionPresence,
  publishExecutionPresence,
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
import { setEphemeralCredential } from "@/lib/storage";

const EXECUTION_SELECTION_HISTORY_KEY = "zeroagentExecutionSelection";
const EXECUTION_PRESENCE_FALLBACK_INTERVAL_MS = 5_000;

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

function useBrowserGatewaySession(historyShareToken: string | null, enabled: boolean) {
  const [accountUser, setAccountUser] = useState<RelayUser | null>(null);
  const [environments, setEnvironments] = useState<ExecutionEnvironment[]>([]);
  const [selection, setSelection] = useState<ExecutionSelection | null>(null);
  const [token, setToken] = useState("");
  const [authInitializing, setAuthInitializing] = useState(enabled && !historyShareToken);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [twoFactorToken, setTwoFactorToken] = useState("");
  const executionPresenceRef = useRef<readonly ExecutionPresence[]>([]);
  const sessionEpochRef = useRef(0);

  const applyToken = useCallback((next: string) => {
    // Child effects can issue Gateway requests before parent effects run.
    // Publish the credential before the state update makes those children mount.
    setEphemeralCredential(next);
    setToken(next);
  }, []);

  const loadEnvironments = useCallback(async () => {
    const epoch = sessionEpochRef.current;
    const params = new URLSearchParams(window.location.search);
    const desktopEmbedded = params.get("controller_surface") === "desktop_embed";
    const localDeviceId = params.get("local_device_id")?.trim() ?? "";
    const items = await getExecutionEnvironments(
      desktopEmbedded ? "desktop" : "web",
      localDeviceId,
    );
    if (epoch !== sessionEpochRef.current) return [];
    setEnvironments(mergeExecutionPresence(items, executionPresenceRef.current));
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
      const valid = await validateExecutionSelection(next);
      if (epoch !== sessionEpochRef.current) return [];
      if (valid) {
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
      const valid = environment && workspaceIsValid && (await validateExecutionSelection(restored));
      if (epoch !== sessionEpochRef.current) return [];
      if (valid) {
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

  const applyExecutionPresence = useCallback((presence: readonly ExecutionPresence[]) => {
    executionPresenceRef.current = [...presence];
    setEnvironments((current) => mergeExecutionPresence(current, presence));
    publishExecutionPresence(presence);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (historyShareToken) {
      setAuthInitializing(false);
      return;
    }
    let cancelled = false;
    const epoch = sessionEpochRef.current;
    void getRelayCurrentUser()
      .then(async (user) => {
        if (cancelled || epoch !== sessionEpochRef.current) return;
        setAccountUser(user);
        bindAccountRequests(user.id);
        await loadEnvironments();
      })
      .catch(() => {
        if (!cancelled && epoch === sessionEpochRef.current) setAccountUser(null);
      })
      .finally(() => {
        if (!cancelled && epoch === sessionEpochRef.current) setAuthInitializing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, historyShareToken, loadEnvironments]);

  useEffect(() => {
    if (!enabled || !accountUser || historyShareToken) return;
    const timer = window.setInterval(() => {
      void loadEnvironments().catch(() => undefined);
    }, EXECUTION_PRESENCE_FALLBACK_INTERVAL_MS);
    const refreshVisible = () => {
      if (document.visibilityState === "visible") {
        void loadEnvironments().catch(() => undefined);
      }
    };
    window.addEventListener("online", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [enabled, accountUser, historyShareToken, loadEnvironments]);

  useEffect(() => {
    if (!enabled) return;
    const handleInvalidSelection = () => {
      const epoch = ++sessionEpochRef.current;
      resetGatewayWebSocketClient();
      persistHistorySelection(null);
      setSelection(null);
      applyToken("");
      void loadEnvironments().catch((error) => {
        if (epoch === sessionEpochRef.current)
          setAuthError(error instanceof Error ? error.message : "执行环境加载失败");
      });
    };
    window.addEventListener(GATEWAY_SELECTION_INVALID_EVENT, handleInvalidSelection);
    return () =>
      window.removeEventListener(GATEWAY_SELECTION_INVALID_EVENT, handleInvalidSelection);
  }, [enabled, applyToken, loadEnvironments]);

  const login = useCallback(
    async (email: string, password: string) => {
      const epoch = ++sessionEpochRef.current;
      setAuthInitializing(false);
      setAuthSubmitting(true);
      setAuthError(null);
      try {
        const response = await loginRelay(email, password);
        if (epoch !== sessionEpochRef.current) return "failed" as const;
        if ("requires_2fa" in response && response.requires_2fa) {
          setTwoFactorToken(response.temp_token);
          return "two-factor" as const;
        }
        if (!("user" in response)) return "failed" as const;
        setAccountUser(response.user);
        bindAccountRequests(response.user.id);
        await loadEnvironments();
        if (epoch !== sessionEpochRef.current) return "failed" as const;
        return "authenticated" as const;
      } catch (error) {
        if (epoch === sessionEpochRef.current)
          setAuthError(error instanceof Error ? error.message : "登录失败");
        return "failed" as const;
      } finally {
        if (epoch === sessionEpochRef.current) setAuthSubmitting(false);
      }
    },
    [loadEnvironments],
  );

  const verifyTwoFactor = useCallback(
    async (code: string) => {
      const epoch = ++sessionEpochRef.current;
      setAuthInitializing(false);
      setAuthSubmitting(true);
      setAuthError(null);
      try {
        const response = await loginRelay2FA(twoFactorToken, code);
        if (epoch !== sessionEpochRef.current) return false;
        setAccountUser(response.user);
        bindAccountRequests(response.user.id);
        setTwoFactorToken("");
        await loadEnvironments();
        if (epoch !== sessionEpochRef.current) return false;
        return true;
      } catch (error) {
        if (epoch === sessionEpochRef.current)
          setAuthError(error instanceof Error ? error.message : "两步验证码校验失败");
        return false;
      } finally {
        if (epoch === sessionEpochRef.current) setAuthSubmitting(false);
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
      const epoch = ++sessionEpochRef.current;
      setAuthInitializing(false);
      setAuthSubmitting(true);
      setAuthError(null);
      try {
        const response = await registerRelay(input);
        if (epoch !== sessionEpochRef.current) return false;
        setAccountUser(response.user);
        bindAccountRequests(response.user.id);
        await loadEnvironments();
        if (epoch !== sessionEpochRef.current) return false;
        return true;
      } catch (error) {
        if (epoch === sessionEpochRef.current)
          setAuthError(error instanceof Error ? error.message : "注册失败");
        return false;
      } finally {
        if (epoch === sessionEpochRef.current) setAuthSubmitting(false);
      }
    },
    [loadEnvironments],
  );

  const switchExecutionTarget = useCallback(
    async (environment: ExecutionEnvironment, workspace: ExecutionWorkspace) => {
      if (canReuseDeviceSelection(selection, environment)) {
        return selection;
      }
      const epoch = ++sessionEpochRef.current;
      const next = await selectExecutionTarget(environment, workspace);
      if (epoch !== sessionEpochRef.current)
        throw new Error("账号或执行目标已变更，请重新选择设备。");
      resetGatewayWebSocketClient();
      setSelection(next);
      applyToken(next.runtime_kind === "device_agent" ? encodeSelectionCredential(next) : "");
      persistHistorySelection(next.runtime_kind === "device_agent" ? next : null);
      return next;
    },
    [applyToken, selection],
  );

  const clearSession = useCallback(
    (revokeRemotely = true) => {
      sessionEpochRef.current++;
      executionPresenceRef.current = [];
      publishExecutionPresence([]);
      if (revokeRemotely) void logoutRelay().catch(() => undefined);
      bindAccountRequests(null);
      resetGatewayWebSocketClient();
      setAccountUser(null);
      setEnvironments([]);
      setSelection(null);
      applyToken("");
      persistHistorySelection(null);
      setTwoFactorToken("");
      setAuthError(null);
      setAuthSubmitting(false);
      setAuthInitializing(false);
    },
    [applyToken],
  );

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
    applyExecutionPresence,
    clearSession,
  };
}

function useDesktopGatewaySession(host: DesktopRemoteHost | undefined) {
  const [valid, setValid] = useState(Boolean(host));
  const [authError, setAuthError] = useState<string | null>(null);
  const invalidated = useRef(false);
  const invalidate = useCallback(
    (reason: string) => {
      if (!host || invalidated.current) return;
      invalidated.current = true;
      setValid(false);
      setAuthError(reason);
      resetGatewayWebSocketClient();
      setEphemeralCredential(null);
      host.onSelectionInvalid(reason);
    },
    [host],
  );
  const token = host && valid ? encodeSelectionCredential(host.selection) : "";

  useEffect(() => {
    if (!host) return;
    bindAccountRequests(host.accountUser.id);
    setEphemeralCredential(token);
    const expiresAt = Date.parse(host.selection.expires_at);
    const expiry = window.setTimeout(
      () => invalidate("控制权限已过期，请重新选择并授权设备。"),
      Math.max(0, expiresAt - Date.now()),
    );
    const invalidSelection = () => invalidate("设备连接或控制权限已失效，请重新选择设备。");
    window.addEventListener(GATEWAY_SELECTION_INVALID_EVENT, invalidSelection);
    return () => {
      window.clearTimeout(expiry);
      window.removeEventListener(GATEWAY_SELECTION_INVALID_EVENT, invalidSelection);
      resetGatewayWebSocketClient();
      setEphemeralCredential(null);
    };
  }, [host, invalidate, token]);

  const applyExecutionPresence = useCallback(
    (presence: readonly ExecutionPresence[]) => {
      if (!host) return;
      if (presence.some((item) => item.agent_id === host.environment.device_id && !item.online)) {
        invalidate("所选设备已离线，请重新连接此设备。");
      }
    },
    [host, invalidate],
  );
  const unavailableLogin = useCallback(async () => {
    throw new Error("请使用桌面账号入口登录。");
  }, []);
  const switchExecutionTarget = useCallback(
    async (
      environment: ExecutionEnvironment,
      _workspace: ExecutionWorkspace,
    ): Promise<ExecutionSelection> => {
      requireCurrentDesktopRemoteHost();
      if (!host || environment.device_id !== host.environment.device_id) {
        throw new Error("请使用桌面的设备切换入口选择设备。");
      }
      return host.selection;
    },
    [host],
  );
  const reloadEnvironments = useCallback(async () => {
    requireCurrentDesktopRemoteHost();
    return host?.environments ?? [];
  }, [host]);
  const clearSession = useCallback(
    async (revokeRemotely = true) => {
      if (!host) return;
      if (revokeRemotely) {
        requireCurrentDesktopRemoteHost();
        if (!host.logout) throw new Error("桌面退出登录暂不可用。");
        // Native may need to retry a vault failure. Keep this workbench and its
        // target intact until logout has actually succeeded.
        await host.logout();
      }
      invalidate("账号会话已结束，请通过桌面账号入口重新连接。");
    },
    [host, invalidate],
  );
  return {
    token,
    accountUser: host?.accountUser ?? null,
    environments: host?.environments ?? [],
    // An invalid remote mount retains its target; it never becomes Cloud Chat/local.
    selection: host?.selection ?? null,
    authInitializing: false,
    authSubmitting: false,
    authError,
    twoFactorRequired: false,
    setAuthError,
    login: unavailableLogin,
    register: unavailableLogin,
    verifyTwoFactor: unavailableLogin,
    switchExecutionTarget,
    reloadEnvironments,
    applyExecutionPresence,
    clearSession,
  };
}

export function useGatewaySession(historyShareToken: string | null) {
  const host = getDesktopRemoteHost();
  const browser = useBrowserGatewaySession(historyShareToken, !host);
  const desktop = useDesktopGatewaySession(host);
  return host ? desktop : browser;
}
