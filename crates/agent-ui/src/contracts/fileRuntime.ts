export type FileRuntimePhase =
  | "unavailable"
  | "missing"
  | "ready"
  | "downloading"
  | "verifying"
  | "pending_restart"
  | "pending_enable"
  | "pending_disable"
  | "pending_removal"
  | "disabled"
  | "failed";

export type FileRuntimeSummary = {
  ready: boolean;
  phase?: FileRuntimePhase;
};

export type FileRuntimeStatus = FileRuntimeSummary & {
  phase: FileRuntimePhase;
  version?: string;
  download_bytes?: number;
  downloaded_bytes?: number;
  can_download: boolean;
  can_import: boolean;
  enabled: boolean;
  can_manage: boolean;
  can_remove: boolean;
  external: boolean;
  error?: string;
};

export type FileRuntimeSource = "download" | "offline";
export type FileRuntimeManagementAction = "enable" | "disable" | "remove";

/** Available only on the local Windows desktop. */
export type FileRuntimeControls = {
  status: () => Promise<FileRuntimeStatus>;
  diagnose: () => Promise<FileRuntimeStatus>;
  prepare: (source: FileRuntimeSource) => Promise<FileRuntimeStatus>;
  manage: (action: FileRuntimeManagementAction) => Promise<FileRuntimeStatus>;
  restart?: () => Promise<boolean>;
};
