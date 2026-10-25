import { prepareUpstreamProxyRequest } from "@liveagent/ui/lib/providers/proxy";
import { isTauriHost } from "../host";

/** Account/control-plane requests use the host's resource proxy; model runs belong to K-brain. */
export async function prepareAccountRequest(baseUrl: string, headers: Record<string, string>) {
  if (isTauriHost()) throw new Error("Native account requests must use the account session API");
  const request = await prepareUpstreamProxyRequest(baseUrl.replace(/\/+$/, ""));
  return { baseUrl: request.url, headers: { ...headers, ...request.headers } };
}
