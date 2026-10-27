import { createSessionWorkbenchFeature } from "@liveagent/ui/lib/workbench/featureFlags";

export const sessionWorkbench = createSessionWorkbenchFeature(
  import.meta.env.VITE_ZEROAGENT_SESSION_WORKBENCH,
);
