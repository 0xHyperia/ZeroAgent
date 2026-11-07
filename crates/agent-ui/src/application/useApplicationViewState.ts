import { useState } from "react";
import type { ApplicationViewId } from "./ApplicationView";

export function useApplicationViewState<TResourceProject>(initialView: ApplicationViewId = "chat") {
  const [activeView, setActiveView] = useState(initialView);
  const [projectSettingsProject, setProjectSettingsProject] = useState<TResourceProject | null>(
    null,
  );
  const [rightDockOpen, setRightDockOpen] = useState(false);

  return {
    activeView,
    setActiveView,
    projectSettingsProject,
    setProjectSettingsProject,
    rightDockOpen,
    setRightDockOpen,
  };
}
