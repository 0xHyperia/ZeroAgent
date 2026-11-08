export function accountStorageScope(origin: string, userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error("Invalid verified USA-Zero account");
  const url = new URL(origin);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid USA-Zero origin");
  return `${url.origin}|user:${userId}`;
}

export async function resolveBackendProfileScope(options: {
  origin: string;
  hasSession: () => boolean;
  getCurrentUser: () => Promise<{ id: number }>;
}): Promise<string | null> {
  if (!options.hasSession()) return null;
  // A network/authentication failure must not expose the offline profile as a fallback.
  const user = await options.getCurrentUser();
  return accountStorageScope(options.origin, user.id);
}

let bootScope: string | null | undefined;
export function setBootProfileScope(scope: string | null): void {
  bootScope = scope;
}
export function getBootProfileScope(): string | null | undefined {
  return bootScope;
}
export function nativeProfileOriginMatches(scope: string | null, origin: string): boolean {
  return scope === null || scope.startsWith(`${new URL(origin).origin}|user:`);
}
export function backendProfileMatchesAccount(origin: string, userId: number): boolean {
  // Explicit browser backends enforce their own identity; only native managed profiles use this gate.
  return bootScope === undefined || bootScope === accountStorageScope(origin, userId);
}
/** Transitional native proof input; the native server response determines the account scope. */
export type NativeProfileCredential = Readonly<{
  sessionHandle: string;
}>;
