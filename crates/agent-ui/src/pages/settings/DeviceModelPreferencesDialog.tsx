import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import type { ImageStudioClient } from "../../lib/imaging/types";
import { DeviceImageModelPreferences } from "./DeviceImageModelPreferences";
import { ProviderSettingsDialog } from "./ProvidersSection";

export function DeviceModelPreferencesDialog({
  client,
  onClose,
  ...props
}: SettingsSectionProps & { client?: ImageStudioClient; onClose: () => void }) {
  return (
    <ProviderSettingsDialog
      {...props}
      providerType={props.settings.customProviders[0]?.type ?? "codex"}
      onClose={onClose}
      media={<DeviceImageModelPreferences {...props} client={client} />}
    />
  );
}
