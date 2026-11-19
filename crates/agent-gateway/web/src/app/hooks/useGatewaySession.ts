import { createUuid } from "@liveagent/ui/lib/shared/id";
import { useCallback, useEffect, useRef, useState } from "react";
import { bindAccountRequests } from "@/lib/accountRequest";
import { pushWorkbenchLocation, replaceWorkbenchState } from "@/lib/browserMobileBack";
import {
  type CloudChatRoute,
  cloudChatRouteHref,
  DEVICE_CONVERSATION_POP_EVENT,
  deviceWorkbenchRouteTarget,
  readCloudChatRoute,
} from "@/lib/cloudChatRoute";
import {
  type DesktopRemoteHost,
  getDesktopRemoteHost,
  requireCurrentDesktopRemoteHost,
} from "@/lib/desktopRemoteHost";
import {
  canReuseDeviceSelection,
  type DeviceDraftWorkspace,
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
const DEVICE_DRAFT_INTENT_HISTORY_KEY = "zeroagentDeviceDraftIntent";
const CLOUD_RETURN_HISTORY_KEY = "zeroagentCloudReturn";
const EXECUTION_PRESENCE_FALLBACK_INTERVAL_MS = 5_000;

type DeviceDraftIntent = {
  accountId: number;
  deviceId: string;
  workspace: DeviceDraftWorkspace;
};

type SwitchExecutionOptions = {
  prepareDeviceDraft?: (selection: ExecutionSelection) => Promise<DeviceDraftWorkspace>;
  beforeCommit?: () => void;
};

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
  return { ...value, device_draft_workspace: undefined } as ExecutionSelection;
}

function readHistoryDeviceDraftIntent(
  route: CloudChatRoute,
  accountId: number | null,
): DeviceDraftIntent | null {
  if (accountId === null || route.page !== "chat" || route.id || !route.deviceId) return null;
  const value = window.history.state?.[DEVICE_DRAFT_INTENT_HISTORY_KEY] as
    | DeviceDraftIntent
    | undefined;
  return value?.accountId === accountId &&
    value.deviceId === route.deviceId &&
    typeof value.workspace?.id === "string" &&
    value.workspace.id.trim() &&
    typeof value.workspace.path === "string" &&
    value.workspace.path.trim()
    ? value
    : null;
}

function persistHistorySelection(
  selection: ExecutionSelection | null,
  draftIntent: DeviceDraftIntent | null = null,
) {
  const state = { ...(window.history.state ?? {}) };
  if (selection?.runtime_kind === "device_agent") {
    const { device_draft_workspace: _draft, ...lease } = selection;
    state[EXECUTION_SELECTION_HISTORY_KEY] = lease;
  } else {
    delete state[EXECUTION_SELECTION_HISTORY_KEY];
    if (deviceWorkbenchRouteTarget(readCloudChatRoute(new URL(window.location.href))) === undefined)
      delete state[CLOUD_RETURN_HISTORY_KEY];
  }
  if (draftIntent) state[DEVICE_DRAFT_INTENT_HISTORY_KEY] = draftIntent;
  else delete state[DEVICE_DRAFT_INTENT_HISTORY_KEY];
  replaceWorkbenchState(state);
}

function defaultCloudSelection(
  environments: ExecutionEnvironment[],
  fromExplicitNavigation = false,
): ExecutionSelection | null {
  const environment = environments.find((item) => item.runtime_kind === "web_chat");
  const workspace = environment?.workspaces[0];
  return workspace || fromExplicitNavigation
    ? {
        selection_lease: "",
        runtime_kind: "web_chat",
        workspace_id: workspace?.id ?? "cloud",
        target_fingerprint: environment?.target_fingerprint ?? "web_chat::cloud",
        conversation_id: createUuid(),
        expires_at: "",
      }
    : null;
}

function pushGatewayLocation(route: CloudChatRoute) {
  const url = new URL(window.location.href);
  const href = cloudChatRouteHref(route, url);
  if (href !== `${url.pathname}${url.search}${url.hash}`)
    pushWorkbenchLocation({ ...window.history.state }, href);
}

function cloudReturnRoute(accountId: number | null): CloudChatRoute {
  const entry = window.history.state?.[CLOUD_RETURN_HISTORY_KEY];
  if (
    accountId !== null &&
    entry?.accountId === accountId &&
    typeof entry.href === "string" &&
    /^\/(?!\/)[^\\]*$/.test(entry.href)
  ) {
    const url = new URL(entry.href, window.location.href);
    if (url.origin === window.location.origin) {
      const route = readCloudChatRoute(url);
      if (deviceWorkbenchRouteTarget(route) === undefined) return route;
    }
  }
  return { page: "chat", id: "" };
}

function useBrowserGatewaySession(historyShareToken: string | null, enabled: boolean) {
  const [accountUser, setAccountUser] = useState<RelayUser | null>(null);
  const activeAccountId = useRef<number | null>(null);
  const [environments, setEnvironments] = useState<ExecutionEnvironment[]>([]);
  const [environmentDirectoryUnavailable, setEnvironmentDirectoryUnavailable] = useState(false);
  const [selection, setSelection] = useState<ExecutionSelection | null>(null);
  const activeSelection = useRef(selection);
  activeSelection.current = selection;
  const [deviceRouteStatus, setDeviceRouteStatus] = useState<
    "loading" | "unavailable" | "invalid-link" | "unauthorized" | null
  >(null);
  const [token, setToken] = useState("");
  const [authInitializing, setAuthInitializing] = useState(enabled && !historyShareToken);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [twoFactorToken, setTwoFactorToken] = useState("");
  const executionPresenceRef = useRef<readonly ExecutionPresence[]>([]);
  const sessionEpochRef = useRef(0);

  const applyAccount = useCallback((user: RelayUser | null) => {
    bindAccountRequests(user?.id ?? null);
    activeAccountId.current = user?.id ?? null;
    setAccountUser(user);
  }, []);

  const applyToken = useCallback((next: string) => {
    // Child effects can issue Gateway requests before parent effects run.
    // Publish the credential before the state update makes those children mount.
    setEphemeralCredential(next);
    setToken(next);
  }, []);

  const retireDeviceAuthorization = useCallback(
    (draftIntent: DeviceDraftIntent | null) => {
      sessionEpochRef.current++;
      resetGatewayWebSocketClient();
      activeSelection.current = null;
      setSelection(null);
      applyToken("");
      persistHistorySelection(null, draftIntent);
      setDeviceRouteStatus("unauthorized");
    },
    [applyToken],
  );

  const loadEnvironments = useCallback(
    async (refreshOnly = false) => {
      const epoch = sessionEpochRef.current;
      const url = new URL(window.location.href);
      const routeAtStart = readCloudChatRoute(url);
      const target = deviceWorkbenchRouteTarget(routeAtStart);
      if (!refreshOnly && target === "") {
        resetGatewayWebSocketClient();
        setSelection(null);
        applyToken("");
        persistHistorySelection(null);
        setDeviceRouteStatus("invalid-link");
        return [];
      }
      const draftIntent = readHistoryDeviceDraftIntent(routeAtStart, activeAccountId.current);
      if (!refreshOnly && target !== undefined) setDeviceRouteStatus("loading");
      const params = url.searchParams;
      const desktopEmbedded = params.get("controller_surface") === "desktop_embed";
      const localDeviceId = params.get("local_device_id")?.trim() ?? "";
      let items: ExecutionEnvironment[];
      try {
        items = await getExecutionEnvironments(desktopEmbedded ? "desktop" : "web", localDeviceId);
      } catch {
        if (epoch === sessionEpochRef.current) {
          setEnvironmentDirectoryUnavailable(true);
          if (!refreshOnly && target === undefined) {
            setSelection((current) => current ?? defaultCloudSelection([], true));
          } else if (!refreshOnly) {
            resetGatewayWebSocketClient();
            setSelection(null);
            applyToken("");
            persistHistorySelection(null, draftIntent);
            setDeviceRouteStatus("unavailable");
          }
        }
        return [];
      }
      if (epoch !== sessionEpochRef.current) return [];
      setEnvironmentDirectoryUnavailable(false);
      setEnvironments(mergeExecutionPresence(items, executionPresenceRef.current));
      if (refreshOnly) {
        const current = activeSelection.current;
        if (
          target &&
          current?.runtime_kind === "device_agent" &&
          current.device_id === target &&
          !items.some((item) => item.runtime_kind === "device_agent" && item.device_id === target)
        )
          retireDeviceAuthorization(draftIntent);
        return items;
      }
      if (target !== undefined) {
        const environment = items.find(
          (item) =>
            item.runtime_kind === "device_agent" && item.device_id === target && item.online,
        );
        const previous = readHistorySelection();
        let next: ExecutionSelection | null = null;
        if (target && environment) {
          try {
            if (
              previous?.device_id === target &&
              !previous.workspace_id &&
              (await validateExecutionSelection(previous))
            ) {
              next = previous;
            } else if (epoch === sessionEpochRef.current) {
              next = await selectExecutionTarget(environment, { id: "", name: "" });
            }
          } catch {
            // The explicit address remains in place so it can be retried.
          }
        }
        if (epoch !== sessionEpochRef.current) return [];
        resetGatewayWebSocketClient();
        if (
          next?.runtime_kind === "device_agent" &&
          next.device_id === target &&
          !next.workspace_id &&
          next.selection_lease?.trim()
        ) {
          next = { ...next, device_draft_workspace: draftIntent?.workspace };
          setSelection(next);
          applyToken(encodeSelectionCredential(next));
          persistHistorySelection(next, draftIntent);
          setDeviceRouteStatus(null);
        } else {
          setSelection(null);
          applyToken("");
          persistHistorySelection(null, draftIntent);
          setDeviceRouteStatus("unavailable");
        }
        return items;
      }
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
      const route = readCloudChatRoute(new URL(window.location.href));
      const explicitCloudRoute = route.page !== "chat" || !!route.id;
      const previous = readHistorySelection();
      const restored = !explicitCloudRoute ? previous : null;
      if (restored) {
        const environment = items.find(
          (item) => item.runtime_kind === "device_agent" && item.device_id === restored.device_id,
        );
        const workspaceIsValid =
          !restored.workspace_id ||
          environment?.workspaces.some((workspace) => workspace.id === restored.workspace_id);
        const valid =
          environment && workspaceIsValid && (await validateExecutionSelection(restored));
        if (epoch !== sessionEpochRef.current) return [];
        if (valid) {
          setSelection(restored);
          applyToken(encodeSelectionCredential(restored));
          return items;
        }
        persistHistorySelection(null);
      }
      if (explicitCloudRoute) applyToken("");
      setSelection((current) => {
        if (current && !explicitCloudRoute) return current;
        return defaultCloudSelection(items);
      });
      return items;
    },
    [applyToken, retireDeviceAuthorization],
  );

  useEffect(() => {
    if (!enabled || selection?.runtime_kind !== "device_agent") return;
    const expiresAt = Date.parse(selection.expires_at);
    if (!Number.isFinite(expiresAt)) return;
    let timer: number | undefined;
    const checkExpiry = () => {
      window.clearTimeout(timer);
      if (activeSelection.current?.selection_lease !== selection.selection_lease) return;
      const remaining = expiresAt - Date.now();
      if (remaining > 0) {
        timer = window.setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
        return;
      }
      const route = readCloudChatRoute(new URL(window.location.href));
      if (deviceWorkbenchRouteTarget(route) !== selection.device_id) return;
      retireDeviceAuthorization(readHistoryDeviceDraftIntent(route, activeAccountId.current));
    };
    checkExpiry();
    document.addEventListener("visibilitychange", checkExpiry);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", checkExpiry);
    };
  }, [enabled, retireDeviceAuthorization, selection]);

  const retryDeviceConversationRoute = useCallback(() => {
    const epoch = ++sessionEpochRef.current;
    void loadEnvironments().catch(() => {
      if (epoch === sessionEpochRef.current) setDeviceRouteStatus("unavailable");
    });
  }, [loadEnvironments]);

  const returnToCloudConversation = useCallback(
    (route: CloudChatRoute = cloudReturnRoute(activeAccountId.current)) => {
      const cloud = defaultCloudSelection(environments, true);
      sessionEpochRef.current++;
      pushGatewayLocation(route);
      resetGatewayWebSocketClient();
      applyToken("");
      setSelection(cloud);
      persistHistorySelection(cloud);
      setDeviceRouteStatus(null);
    },
    [applyToken, environments],
  );

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
        applyAccount(user);
        await loadEnvironments();
      })
      .catch(() => {
        if (!cancelled && epoch === sessionEpochRef.current) applyAccount(null);
      })
      .finally(() => {
        if (!cancelled && epoch === sessionEpochRef.current) setAuthInitializing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyAccount, enabled, historyShareToken, loadEnvironments]);

  useEffect(() => {
    if (!enabled || !accountUser || historyShareToken) return;
    const restoreRoute = () => {
      const route = readCloudChatRoute(new URL(window.location.href));
      const target = deviceWorkbenchRouteTarget(route);
      const current = activeSelection.current;
      setAuthInitializing(false);
      if (target !== undefined) {
        if (!window.dispatchEvent(new Event(DEVICE_CONVERSATION_POP_EVENT, { cancelable: true })))
          return;
        if (
          current?.runtime_kind === "device_agent" &&
          current.device_id === target &&
          !current.workspace_id &&
          (!current.expires_at || Date.parse(current.expires_at) > Date.now())
        ) {
          sessionEpochRef.current++;
          const draftIntent = readHistoryDeviceDraftIntent(route, activeAccountId.current);
          const next =
            current.device_draft_workspace === draftIntent?.workspace
              ? current
              : { ...current, device_draft_workspace: draftIntent?.workspace };
          if (next !== current) setSelection(next);
          persistHistorySelection(next, draftIntent);
          setDeviceRouteStatus(null);
        } else {
          retryDeviceConversationRoute();
        }
      } else {
        sessionEpochRef.current++;
        if (current?.runtime_kind !== "web_chat") {
          resetGatewayWebSocketClient();
          applyToken("");
          persistHistorySelection(null);
          setSelection(defaultCloudSelection(environments, true));
        }
        setDeviceRouteStatus(null);
      }
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, [
    accountUser,
    applyToken,
    enabled,
    environments,
    historyShareToken,
    retryDeviceConversationRoute,
  ]);

  useEffect(() => {
    if (!enabled || !accountUser || historyShareToken) return;
    const timer = window.setInterval(() => {
      void loadEnvironments(true).catch(() => undefined);
    }, EXECUTION_PRESENCE_FALLBACK_INTERVAL_MS);
    const refreshVisible = () => {
      if (document.visibilityState === "visible") {
        void loadEnvironments(true).catch(() => undefined);
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
      const route = readCloudChatRoute(new URL(window.location.href));
      const draftIntent = readHistoryDeviceDraftIntent(route, activeAccountId.current);
      resetGatewayWebSocketClient();
      persistHistorySelection(null, draftIntent);
      setSelection(null);
      applyToken("");
      const target = deviceWorkbenchRouteTarget(route);
      if (target !== undefined) {
        setDeviceRouteStatus(target ? "unavailable" : "invalid-link");
        return;
      }
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
        applyAccount(response.user);
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
    [applyAccount, loadEnvironments],
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
        applyAccount(response.user);
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
    [applyAccount, loadEnvironments, twoFactorToken],
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
        applyAccount(response.user);
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
    [applyAccount, loadEnvironments],
  );

  const switchExecutionTarget = useCallback(
    async (
      environment: ExecutionEnvironment,
      workspace: ExecutionWorkspace,
      options?: SwitchExecutionOptions,
    ) => {
      if (!options?.prepareDeviceDraft && canReuseDeviceSelection(selection, environment)) {
        return selection;
      }
      const epoch = ++sessionEpochRef.current;
      let next =
        environment.runtime_kind === "web_chat"
          ? defaultCloudSelection([environment], true)
          : await selectExecutionTarget(environment, workspace);
      if (!next) return null;
      if (options?.prepareDeviceDraft && epoch === sessionEpochRef.current) {
        const deviceDraftWorkspace = await options.prepareDeviceDraft(next);
        next = { ...next, device_draft_workspace: deviceDraftWorkspace };
      }
      if (epoch !== sessionEpochRef.current)
        throw new Error("账号或执行目标已变更，请重新选择设备。");
      options?.beforeCommit?.();
      const accountId = activeAccountId.current;
      const draftIntent =
        accountId !== null && next.device_id && next.device_draft_workspace
          ? { accountId, deviceId: next.device_id, workspace: next.device_draft_workspace }
          : null;
      const url = new URL(window.location.href);
      const currentRoute = readCloudChatRoute(url);
      const currentDevice = deviceWorkbenchRouteTarget(currentRoute);
      if (
        next.runtime_kind === "device_agent" &&
        (next.device_draft_workspace || next.device_id !== currentDevice)
      ) {
        pushGatewayLocation({ page: "chat", id: "", deviceId: next.device_id });
        if (accountId !== null && currentDevice === undefined) {
          const state = { ...window.history.state };
          state[CLOUD_RETURN_HISTORY_KEY] = {
            accountId,
            href: cloudChatRouteHref(currentRoute, url),
          };
          window.history.replaceState(state, "", window.location.href);
        }
      } else if (next.runtime_kind === "web_chat" && currentDevice !== undefined) {
        pushGatewayLocation(cloudReturnRoute(accountId));
      }
      resetGatewayWebSocketClient();
      setSelection(next);
      applyToken(next.runtime_kind === "device_agent" ? encodeSelectionCredential(next) : "");
      persistHistorySelection(next, draftIntent);
      return next;
    },
    [applyToken, selection],
  );

  const finishDeviceDraft = useCallback(
    (lease: string) => {
      if (!selection?.device_draft_workspace || selection.selection_lease !== lease) return;
      const next = { ...selection, device_draft_workspace: undefined };
      setSelection(next);
      persistHistorySelection(next);
    },
    [selection],
  );

  const returnToCloudDraft = useCallback(
    (lease: string) => {
      if (!selection?.device_draft_workspace || selection.selection_lease !== lease) return;
      persistHistorySelection(selection);
      returnToCloudConversation();
    },
    [returnToCloudConversation, selection],
  );

  const clearSession = useCallback(
    (revokeRemotely = true) => {
      sessionEpochRef.current++;
      executionPresenceRef.current = [];
      publishExecutionPresence([]);
      if (revokeRemotely) void logoutRelay().catch(() => undefined);
      applyAccount(null);
      resetGatewayWebSocketClient();
      setEnvironments([]);
      setEnvironmentDirectoryUnavailable(false);
      setSelection(null);
      applyToken("");
      persistHistorySelection(null);
      setTwoFactorToken("");
      setAuthError(null);
      setDeviceRouteStatus(null);
      setAuthSubmitting(false);
      setAuthInitializing(false);
    },
    [applyAccount, applyToken],
  );

  return {
    token,
    accountUser,
    environments,
    environmentDirectoryUnavailable,
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
    finishDeviceDraft,
    returnToCloudDraft,
    deviceRouteStatus,
    retryDeviceConversationRoute,
    returnToCloudConversation,
    reloadEnvironments: loadEnvironments,
    applyExecutionPresence,
    clearSession,
  };
}

function useDesktopGatewaySession(host: DesktopRemoteHost | undefined) {
  const [valid, setValid] = useState(Boolean(host));
  const [environments, setEnvironments] = useState(host?.environments ?? []);
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
      if (!host || invalidated.current || !host.isCurrent()) return;
      // Presence can briefly go offline while the selected agent reconnects.
      // Keep the live lease and workbench so the existing transport can recover;
      // only an authorization rejection or its fixed expiry invalidates them.
      setEnvironments((current) => mergeExecutionPresence(current, presence));
    },
    [host],
  );
  const unavailableLogin = useCallback(async () => {
    throw new Error("请使用桌面账号入口登录。");
  }, []);
  const switchExecutionTarget = useCallback(
    async (
      environment: ExecutionEnvironment,
      _workspace: ExecutionWorkspace,
      _options?: SwitchExecutionOptions,
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
    return environments;
  }, [environments]);
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
    environments,
    environmentDirectoryUnavailable: false,
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
    finishDeviceDraft: (_lease: string) => {},
    returnToCloudDraft: (_lease: string) => {},
    deviceRouteStatus: null,
    retryDeviceConversationRoute: () => {},
    returnToCloudConversation: (_route?: CloudChatRoute) => {},
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
