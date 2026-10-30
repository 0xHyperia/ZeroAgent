import { isWindowsTauriRuntime, WindowsTitleBar } from "./WindowsTitleBar";

export function WindowsSettingsHeader() {
  if (!isWindowsTauriRuntime()) return null;

  return (
    <header
      data-windows-settings-header=""
      data-tauri-drag-region
      className="settings-window-chrome"
    >
      <div data-tauri-drag-region className="h-full flex-1" />
      <WindowsTitleBar controlsOnly />
    </header>
  );
}
