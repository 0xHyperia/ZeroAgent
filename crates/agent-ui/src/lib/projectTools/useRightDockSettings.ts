import {
  type AppSettings,
  getSshProjectHostIds,
  patchRightDockFileTreeState,
  type RightDockFileTreeStatePatch,
  type RightDockProjectState,
  readRightDockFileTreeState,
  updateChatTranscriptWidth,
  updateRightDockWidth,
  updateSshProjectHostIds,
} from "@liveagent/app/lib/settings";
import { useCallback, useMemo } from "react";
import type { useConversationRightDock } from "./useConversationRightDock";

type UseRightDockSettingsParams = {
  settings: AppSettings;
  setSettings: (updater: (previousSettings: AppSettings) => AppSettings) => void;
  terminalProjectPathKey: string;
  dock: ReturnType<typeof useConversationRightDock>;
};

export function useRightDockSettings(params: UseRightDockSettingsParams) {
  const { settings, setSettings, terminalProjectPathKey, dock } = params;
  const { updateToolState } = dock;
  const rightDockProjectState = dock.getToolState(terminalProjectPathKey);
  const rightDockFileTreeState = useMemo(
    () => readRightDockFileTreeState(rightDockProjectState),
    [rightDockProjectState],
  );
  const rightDockFileTreeOpen = Boolean(rightDockProjectState.tools.fileTree);
  const associatedSshHostIds = useMemo(
    () => getSshProjectHostIds(settings.ssh, terminalProjectPathKey),
    [settings.ssh, terminalProjectPathKey],
  );
  const handleChatTranscriptWidthChange = useCallback(
    (nextWidth: number) => {
      setSettings((previousSettings) => updateChatTranscriptWidth(previousSettings, nextWidth));
    },
    [setSettings],
  );
  const handleRightDockWidthChange = useCallback(
    (nextWidth: number) => {
      setSettings((previousSettings) => updateRightDockWidth(previousSettings, nextWidth));
    },
    [setSettings],
  );
  const handleRightDockProjectStateChange = useCallback(
    (updater: (current: RightDockProjectState) => RightDockProjectState) => {
      updateToolState(terminalProjectPathKey, updater);
    },
    [updateToolState, terminalProjectPathKey],
  );
  const handleRightDockFileTreeStateChange = useCallback(
    (patch: RightDockFileTreeStatePatch) => {
      updateToolState(terminalProjectPathKey, (state) => patchRightDockFileTreeState(state, patch));
    },
    [updateToolState, terminalProjectPathKey],
  );
  const handleSshProjectHostIdsChange = useCallback(
    (hostIds: string[]) => {
      setSettings((previousSettings) =>
        updateSshProjectHostIds(previousSettings, terminalProjectPathKey, hostIds),
      );
    },
    [setSettings, terminalProjectPathKey],
  );

  return {
    rightDockProjectState,
    rightDockFileTreeState,
    rightDockFileTreeOpen,
    associatedSshHostIds,
    handleChatTranscriptWidthChange,
    handleRightDockWidthChange,
    handleRightDockProjectStateChange,
    handleRightDockFileTreeStateChange,
    handleSshProjectHostIdsChange,
  };
}
