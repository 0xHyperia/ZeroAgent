import { desktopRemoteFetch } from "./desktopRemoteHost";

export const ACCOUNT_OWNER_HEADER = "X-ZeroAgent-Account-ID";
export const ACCOUNT_CHANGED_EVENT = "zeroagent:account-changed";
export const ACCOUNT_SESSION_STORAGE_KEY = "zeroagent.account.cookie-revision";
let owner: number | null = null;
let revision = 0;
let notifiedRevision = -1;

export function bindAccountRequests(userId: number | null) {
  if (userId !== null && (!Number.isSafeInteger(userId) || userId <= 0))
    throw new Error("Invalid verified account identity");
  if (owner !== userId) {
    owner = userId;
    revision++;
  }
}

export function invalidateAccountRequests() {
  revision++;
}

export function accountOwnerHeaders(): Record<string, string> {
  return owner === null ? {} : { [ACCOUNT_OWNER_HEADER]: String(owner) };
}

export async function accountFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/api/")) return desktopRemoteFetch(path, init);
  const started = revision;
  // Only same-origin account APIs receive this consistency assertion. Cookie authentication
  // remains authoritative; this header cannot grant access or replace a device lease.
  let request = init;
  if (owner !== null) {
    const headers = new Headers(init.headers);
    if (!headers.has(ACCOUNT_OWNER_HEADER)) headers.set(ACCOUNT_OWNER_HEADER, String(owner));
    request = { ...init, headers };
  }
  const response = await desktopRemoteFetch(path, request);
  if (started !== revision) throw new Error("Account changed while the request was pending");
  if (response.status === 409 && response.headers.get("X-ZeroAgent-Account-Mismatch") === "1") {
    if (notifiedRevision !== revision) {
      notifiedRevision = revision;
      window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
    }
    throw new Error("Account changed in another page; reload to continue");
  }
  return response;
}
