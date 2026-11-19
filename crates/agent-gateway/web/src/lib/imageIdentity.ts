import { ImageClientError } from "@liveagent/ui/lib/imaging/errors";
import { useCallback, useEffect, useState } from "react";
import type { TrustedGatewayImageIdentity } from "../agent-ui-adapters/imageStudio";
import { desktopRemoteFetch, gatewayOrigin } from "./desktopRemoteHost";
import { decodeSelectionCredential } from "./executionTargets";

export async function fetchSingleUserImageIdentity(
  origin: string,
  token: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = desktopRemoteFetch,
): Promise<TrustedGatewayImageIdentity> {
  if (!token.trim()) throw new ImageClientError("IMAGE_AUTH_REQUIRED");
  const response = await fetcher(`${origin}/api/image/identity`, {
    signal,
    headers: { Authorization: `Bearer ${token}` },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok)
    throw new ImageClientError(
      response.status === 401 ? "IMAGE_AUTH_REQUIRED" : "IMAGE_IDENTITY_UNAVAILABLE",
      response.status,
    );
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new ImageClientError("IMAGE_PROTOCOL_ERROR");
  const v = value as Record<string, unknown>;
  if (
    v.mode !== "single_user" ||
    v.ownerId !== "local" ||
    typeof v.backendId !== "string" ||
    !v.backendId.trim()
  )
    throw new ImageClientError("IMAGE_PROTOCOL_ERROR");
  return { ownerId: "local", backendId: v.backendId, gatewayOrigin: origin, accessToken: token };
}

export async function fetchDeviceImageIdentity(
  origin: string,
  token: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = desktopRemoteFetch,
): Promise<TrustedGatewayImageIdentity> {
  const selection = decodeSelectionCredential(token);
  const selectedBackend = selection?.agentId || selection?.deviceId;
  if (selection?.runtimeKind !== "device_agent" || !selectedBackend) {
    throw new ImageClientError("IMAGE_AUTH_REQUIRED");
  }
  const response = await fetcher(`${origin}/api/image/identity`, {
    signal,
    headers: { Authorization: `Bearer ${token}` },
    credentials: "include",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    const code =
      response.status === 401
        ? "IMAGE_AUTH_REQUIRED"
        : response.status === 403
          ? "IMAGE_FORBIDDEN"
          : response.status === 503
            ? "IMAGE_REMOTE_UPGRADE_REQUIRED"
            : "IMAGE_BACKEND_UNAVAILABLE";
    throw new ImageClientError(code, response.status);
  }
  const value = await response.json();
  if (
    value?.mode !== "device" ||
    value.backendId !== selectedBackend ||
    typeof value.ownerId !== "string" ||
    !/^[1-9]\d*$/.test(value.ownerId)
  ) {
    throw new ImageClientError("IMAGE_PROTOCOL_ERROR");
  }
  return {
    mode: "device",
    ownerId: value.ownerId,
    backendId: selectedBackend,
    gatewayOrigin: origin,
    accessToken: token,
  };
}

export function useGatewayImageIdentity(token: string, supplied?: TrustedGatewayImageIdentity) {
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState<{
    token: string;
    attempt: number;
    identity?: TrustedGatewayImageIdentity;
    error?: unknown;
  }>();
  useEffect(() => {
    if (supplied || !token.trim()) return;
    const controller = new AbortController();
    const fetch = token.startsWith("selection.")
      ? fetchDeviceImageIdentity
      : fetchSingleUserImageIdentity;
    void fetch(gatewayOrigin(), token, controller.signal)
      .then((identity) => {
        if (!controller.signal.aborted) setActive({ token, attempt, identity });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setActive({ token, attempt, error });
      });
    return () => controller.abort();
  }, [token, attempt, supplied]);
  const current = active?.token === token && active.attempt === attempt ? active : undefined;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    identity: supplied ?? current?.identity,
    error: supplied ? undefined : current?.error,
    pending: Boolean(!supplied && token && !current),
    retry,
  };
}
