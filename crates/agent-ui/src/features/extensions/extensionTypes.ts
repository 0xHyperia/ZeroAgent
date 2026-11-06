export type ExtensionSkill = {
  name: string;
  description: string;
  entry: string;
  display_name?: string;
};
export type ExtensionKind = "plugin" | "skill";
export type ExtensionPackage = {
  id: string;
  kind: ExtensionKind;
  visibility: "public" | "personal";
  owned: boolean;
  name: string;
  description: string;
  publisher: string;
  version: number;
  installed: boolean;
  enabled: boolean;
  builtin: boolean;
  native?: boolean;
  skills: ExtensionSkill[];
  legacy_skills?: { name: string; description: string; version: number }[];
  disabled_skills: string[] | null;
  examples: string[];
  overview?: string;
  unavailable_apps?: { name: string; description: string }[];
  updated_at: string;
};
export type ExtensionRevision = {
  number: number;
  name: string;
  description: string;
  files: Record<string, string>;
  skills: ExtensionSkill[];
  aliases?: Record<string, string>;
  created_at: string;
};
export type ExtensionCatalog = { version: number; packages: ExtensionPackage[] };
export type ExtensionPreparedDraft = {
  kind: ExtensionKind;
  target_id?: string;
  base_revision?: number;
  revision: ExtensionRevision;
};
export type ExtensionMutation = {
  action: "install" | "uninstall" | "enable" | "skill" | "save";
  id?: string;
  kind?: ExtensionKind;
  enabled?: boolean;
  skill?: string;
  revision?: ExtensionRevision;
  base_revision?: number;
  draft_id?: string;
};
/** The host owns storage, authentication and execution. Presentation never writes host configuration. */
export type ExtensionsAdapter = {
  scope: string;
  /** An uncertain write must be reconciled by a successful catalog read before another write. */
  readonly writeUnconfirmed?: boolean;
  list(signal?: AbortSignal): Promise<ExtensionCatalog>;
  read(id: string, signal?: AbortSignal): Promise<{ revision: ExtensionRevision; version: number }>;
  readDraft?(id: string, signal?: AbortSignal): Promise<ExtensionPreparedDraft>;
  mutate(expected: number, input: ExtensionMutation): Promise<ExtensionCatalog>;
  importArchive(expected: number, file: File, kind?: ExtensionKind): Promise<ExtensionCatalog>;
  download(id: string): Promise<Blob>;
};
export function extensionOwned(pkg: ExtensionPackage) {
  return pkg.visibility === "personal" && pkg.owned;
}
export function extensionSkillEnabled(pkg: ExtensionPackage, skill: ExtensionSkill) {
  return pkg.installed && pkg.enabled && !pkg.disabled_skills?.includes(skill.name);
}

export function extensionComposerEntry(pkg: ExtensionPackage) {
  const primary = pkg.skills[0];
  return primary && extensionSkillEnabled(pkg, primary) ? primary : undefined;
}
