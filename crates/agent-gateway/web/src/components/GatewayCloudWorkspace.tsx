import { type Locale, t as translate } from "@liveagent/ui/i18n/index";
import { type ReactNode, useEffect, useState } from "react";
import {
  type CloudWorkspaceAvailability,
  readCloudWorkspaceAvailability,
} from "@/lib/cloudWorkspaceAvailability";
import { GatewayLoadingCard, GatewayLoadingScreen } from "@/pages/GatewayLoadingScreen";

export function GatewayCloudWorkspace({
  children,
  locale,
}: {
  children: (availability: CloudWorkspaceAvailability) => ReactNode;
  locale: Locale;
}) {
  const [availability, setAvailability] = useState<CloudWorkspaceAvailability>();
  useEffect(() => {
    const controller = new AbortController();
    void readCloudWorkspaceAvailability(window.fetch.bind(window), controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setAvailability(value);
      },
    );
    return () => controller.abort();
  }, []);
  if (availability) return children(availability);
  return (
    <GatewayLoadingScreen>
      <GatewayLoadingCard label={translate("app.loadingCloudWorkspace", locale)} />
    </GatewayLoadingScreen>
  );
}
