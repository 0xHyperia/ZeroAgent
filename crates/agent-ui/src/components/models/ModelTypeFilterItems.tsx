import { useLocale } from "@liveagent/ui/i18n/index";
import { MODEL_TYPES, type ModelType } from "../../lib/models/modelTypes";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../ui/dropdown-menu";

const labels = {
  text: "chat.modelPickerTypeText",
  image: "chat.modelPickerTypeImage",
  video: "chat.modelPickerTypeVideo",
  other: "chat.modelPickerTypeOther",
} as const;

export function ModelTypeFilterItems({
  scope,
  value,
  onChange,
}: {
  scope?: ModelType;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useLocale();
  return (
    <>
      <DropdownMenuLabel>{t("chat.modelPickerType")}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={scope ?? value} onValueChange={onChange}>
        {!scope && (
          <DropdownMenuRadioItem value="">{t("chat.modelPickerTypeAll")}</DropdownMenuRadioItem>
        )}
        {(scope ? [scope] : MODEL_TYPES).map((type) => (
          <DropdownMenuRadioItem key={type} value={type}>
            {t(labels[type])}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
