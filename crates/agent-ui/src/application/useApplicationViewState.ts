import { useState } from "react";
import type { ApplicationViewId } from "./ApplicationView";

export function useApplicationViewState<TResourceProject>(initialView: ApplicationViewId = "chat") {
  const [activeView, setActiveView] = useState(initialView);
  const [projectSettingsProject, setProjectSettingsProject] = useState<TResourceProject | null>(
    null,
  );

  return {
    activeView,
    setActiveView,
    projectSettingsProject,
    setProjectSettingsProject,
  };
}
