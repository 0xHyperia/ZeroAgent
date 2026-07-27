import {
  type FirstRunOnboardingDataSource,
  type FirstRunOnboardingProps,
  FirstRunOnboarding as SharedFirstRunOnboarding,
} from "../../../../agent-gateway/web/src/components/onboarding/FirstRunOnboarding";
import { createRelayApiKeys, listRelayApiKeys, listRelayGroups } from "../../lib/relay/client";
import { relayProviderTypeForPlatform } from "../../lib/relay/providers";

const DESKTOP_DATA_SOURCE: FirstRunOnboardingDataSource = {
  listApiKeys: listRelayApiKeys,
  listGroups: listRelayGroups,
  createApiKeys: createRelayApiKeys,
  supportsPlatform: (platform) => Boolean(relayProviderTypeForPlatform(platform)),
};

export function FirstRunOnboarding(props: FirstRunOnboardingProps) {
  return <SharedFirstRunOnboarding {...props} dataSource={DESKTOP_DATA_SOURCE} />;
}
