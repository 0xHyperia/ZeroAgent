import type {
  ExtensionCatalog,
  ExtensionPackage,
} from "@liveagent/ui/features/extensions/extensionTypes";
import documents from "../../../internal/account/skills/documents/plugin.json";
import imagegen from "../../../internal/account/skills/imagegen/plugin.json";
import pdf from "../../../internal/account/skills/pdf/plugin.json";
import pluginCreator from "../../../internal/account/skills/plugin-creator/plugin.json";
import presentations from "../../../internal/account/skills/presentations/plugin.json";
import productDesign from "../../../internal/account/skills/product-design/plugin.json";
import skillCreator from "../../../internal/account/skills/skill-creator/plugin.json";
import spreadsheet from "../../../internal/account/skills/spreadsheet/plugin.json";

const manifests = [
  productDesign,
  imagegen,
  pluginCreator,
  skillCreator,
  documents,
  pdf,
  spreadsheet,
  presentations,
];

// The closed workspace displays public summaries using the same manifests as the Gateway.
export const bundledCloudExtensionCatalog: ExtensionCatalog = {
  version: 0,
  packages: manifests.map((manifest): ExtensionPackage => {
    const { kind, primarySkill } = manifest.extensions["top.usa0"];
    return {
      id: manifest.name,
      kind: kind === "plugin" ? "plugin" : "skill",
      visibility: "public",
      owned: false,
      name: "interface" in manifest ? manifest.interface.displayName : manifest.name,
      description: manifest.description,
      publisher: "ZeroAgent",
      version: 0,
      installed: true,
      enabled: false,
      builtin: true,
      skills: [{ name: primarySkill, description: manifest.description, entry: "" }],
      disabled_skills: [],
      examples: [],
      updated_at: "",
    };
  }),
};
