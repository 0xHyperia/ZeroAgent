import { useSettingsOverlay } from "@liveagent/ui/lib/settings/useSettingsOverlay";
import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from "react";

import type { SectionId } from "@/pages/settings/types";

import { isMobileSidebarLayout } from "../historyUtils";

export function useGatewaySettingsOverlay(setSidebarOpen: Dispatch<SetStateAction<boolean>>) {
  const {
    settingsOpen,
    overlay,
    openSettingsOverlay,
    closeSettingsOverlay,
    handleSettingsOverlayTransitionEnd,
    resetSettingsOverlay: resetOverlay,
  } = useSettingsOverlay();
  const [modelPreferencesOpen, setModelPreferencesOpen] = useState(false);
  const resetSettingsOverlay = useCallback(() => {
    setModelPreferencesOpen(false);
    resetOverlay();
  }, [resetOverlay]);
  const [settingsSection, setSettingsSection] = useState<SectionId>("system");
  const [settingsAnchor, setSettingsAnchor] = useState<string>();
  const [settingsProviderId, setSettingsProviderId] = useState<string>();
  const leaveGuard = useRef<(() => boolean) | undefined>(undefined);
  const registerSettingsLeaveGuard = useCallback((guard: () => boolean) => {
    leaveGuard.current = guard;
    return () => {
      if (leaveGuard.current === guard) leaveGuard.current = undefined;
    };
  }, []);
  const closeSettings = useCallback(() => {
    if (leaveGuard.current && !leaveGuard.current()) return false;
    closeSettingsOverlay();
    return true;
  }, [closeSettingsOverlay]);

  const openSettings = useCallback(
    (section: SectionId = "system", providerId?: string, anchor?: string) => {
      if (section === "model-preferences" || section === "image-studio") {
        setModelPreferencesOpen(true);
        return;
      }
      if (leaveGuard.current && !leaveGuard.current()) return;
      if (isMobileSidebarLayout()) setSidebarOpen(false);
      setSettingsSection(section);
      setSettingsAnchor(anchor);
      setSettingsProviderId(section === "providers" ? providerId : undefined);
      openSettingsOverlay();
    },
    [openSettingsOverlay, setSidebarOpen],
  );

  return {
    modelPreferencesOpen,
    setModelPreferencesOpen,
    settingsOpen,
    overlay,
    openSettings,
    closeSettings,
    registerSettingsLeaveGuard,
    handleSettingsTransitionEnd: handleSettingsOverlayTransitionEnd,
    resetSettingsOverlay,
    settingsSection,
    settingsAnchor,
    settingsProviderId,
  };
}
