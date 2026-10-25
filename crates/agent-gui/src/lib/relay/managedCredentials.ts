import { invoke } from "@tauri-apps/api/core";
import { isTauriHost } from "../host";
import { getBootProfileScope } from "../kbrain/profile";
import { requireNativeSession } from "./nativeSession";

export type ManagedModelBinding = { providerId: string; baseUrl: string; apiKey: string };
const bindings = new Map<string, ManagedModelBinding>();

export function managedModelBinding(providerId: string): ManagedModelBinding | undefined {
  return bindings.get(providerId);
}

export async function replaceManagedModelCredentials(
  _origin: string,
  credentials: { providerId: string }[],
): Promise<Map<string, ManagedModelBinding>> {
  const accountScope = getBootProfileScope();
  if (!isTauriHost() || !accountScope) {
    throw new Error("托管模型需要已验证账号的桌面后端。");
  }
  const session = await requireNativeSession();
  if (session.accountScope !== accountScope) throw new Error("USA-Zero account changed");
  const result = await invoke<ManagedModelBinding[]>("kbrain_managed_credentials_replace", {
    sessionHandle: session.sessionHandle,
    providerIds: credentials.map((credential) => credential.providerId),
  });
  bindings.clear();
  for (const binding of result) bindings.set(binding.providerId, binding);
  return new Map(bindings);
}
