import { type ReactNode, useEffect, useState } from "react";
import {
  type CloudWorkspaceAvailability,
  readCloudWorkspaceAvailability,
} from "@/lib/cloudWorkspaceAvailability";

export function GatewayCloudWorkspace({
  children,
  loading,
}: {
  children: (availability: CloudWorkspaceAvailability) => ReactNode;
  loading: ReactNode;
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
  return availability ? children(availability) : loading;
}
