import { Package } from "../../components/IconSet";
import { getFileTypeIcon } from "../../components/chat/fileTypeIcons";
import { extensionImage } from "../../lib/extensions/presentation";
import { builtinFileSkillPresentation } from "../../lib/skills/fileSkillPresentation";
import { cn } from "../../lib/shared/utils";
import "./ExtensionMark.css";

export function ExtensionMark({ id, small = false }: { id: string; small?: boolean }) {
  const image = extensionImage(id);
  const fileSkill = builtinFileSkillPresentation(id, true);
  const Icon = fileSkill ? getFileTypeIcon(`skill.${fileSkill.extension}`, "file") : Package;
  return (
    <span
      className={cn("za-extension-mark", small && "za-extension-mark-small")}
      data-brand={id}
      data-logo={image ? "true" : undefined}
    >
      {image ? (
        <img src={image} alt="" aria-hidden="true" draggable={false} />
      ) : (
        <Icon className="size-5" aria-hidden="true" />
      )}
    </span>
  );
}
