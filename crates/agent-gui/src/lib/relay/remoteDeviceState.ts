export function remoteProjectStorageKey(deviceId: string) {
  return `zeroagent.remote-project:${deviceId}`;
}

export function remoteConversationStorageKey(deviceId: string, projectId: string | null) {
  return `zeroagent.remote-conversation:${deviceId}:${projectId || "plain-chat"}`;
}
