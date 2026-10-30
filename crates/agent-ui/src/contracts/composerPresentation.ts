/** Geometry, independent of execution target or native capabilities. */
export type ComposerPresentation = "pane" | "column";

export type ComposerCapabilities = Readonly<{
  executionControls: boolean;
  gitControls: boolean;
  workspaceFolders: boolean;
}>;

export const DEVICE_COMPOSER_CAPABILITIES: ComposerCapabilities = Object.freeze({
  executionControls: true,
  gitControls: true,
  workspaceFolders: true,
});

export const CLOUD_COMPOSER_CAPABILITIES: ComposerCapabilities = Object.freeze({
  executionControls: false,
  gitControls: false,
  workspaceFolders: false,
});

/** Preserve upstream callers while product hosts explicitly bind presentation. */
export function resolveComposerPresentation({
  presentation,
  surface,
}: {
  presentation?: ComposerPresentation;
  surface?: "desktop" | "web";
}): ComposerPresentation {
  return presentation ?? (surface === "desktop" ? "pane" : "column");
}

/** Host visibility can restrict supported controls; it cannot add execution capabilities. */
export function resolveComposerControls(
  capabilities: ComposerCapabilities = DEVICE_COMPOSER_CAPABILITIES,
  requested: { executionControls?: boolean; gitControls?: boolean } = {},
) {
  return {
    executionControls: capabilities.executionControls && (requested.executionControls ?? true),
    gitControls: capabilities.gitControls && (requested.gitControls ?? true),
  };
}
