export type DeviceUiSurfaceRequest =
  | { action: "history"; conversationId: string; workdir?: string }
  | {
      action: "preview" | "mcp";
      conversationId: string;
      workdir?: string;
      resourceId: string;
    }
  | {
      action: "panel";
      workdir?: string;
      resourceId: string;
      pluginId: string;
      pluginVersion: string;
    };

export type DeviceUiPreview = { id: string; title?: string; toolCallId?: string };

export type DeviceUiHistory = { previews: DeviceUiPreview[]; mcp: string[] };

export type DeviceUiDocument = { html: string; result?: unknown };

export type DeviceUiSurfaceClient = (
  request: DeviceUiSurfaceRequest,
) => Promise<DeviceUiHistory | DeviceUiDocument>;
