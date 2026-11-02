import { sourceLanguageForName } from "../../lib/sourceLanguages";

/** Catalog detection never bypasses byte/encoding checks. */
export function isSourceFileName(name: string) {
  return sourceLanguageForName(name) !== undefined;
}
