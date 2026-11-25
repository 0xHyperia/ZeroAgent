import { FilePenLine } from "@liveagent/ui/components/IconSet";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@liveagent/ui/components/ui/context-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useWorkspaceEditors } from "@liveagent/ui/lib/tools/workspaceEditors";
import AndroidIcon from "~icons/logos/android-icon";
import CLionIcon from "~icons/logos/clion";
import GitIcon from "~icons/logos/git-icon";
import GoLandIcon from "~icons/logos/goland";
import IntelliJIcon from "~icons/logos/intellij-idea";
import WslIcon from "~icons/logos/linux-tux";
import PyCharmIcon from "~icons/logos/pycharm";
import SublimeIcon from "~icons/logos/sublimetext-icon";
import TerminalIcon from "~icons/logos/terminal";
import VisualStudioIcon from "~icons/logos/visual-studio";
import VSCodeIcon from "~icons/logos/visual-studio-code";
import WebStormIcon from "~icons/logos/webstorm";
import XcodeIcon from "~icons/logos/xcode";
import CursorIcon from "~icons/material-icon-theme/cursor";

export const WORKSPACE_OPEN_TARGETS = [
  { id: "vscode", label: "VS Code", Icon: VSCodeIcon },
  { id: "visual-studio", label: "Visual Studio", Icon: VisualStudioIcon },
  { id: "vscode-insiders", label: "VS Code Insiders", Icon: VSCodeIcon },
  { id: "cursor", label: "Cursor", Icon: CursorIcon },
  { id: "windsurf", label: "Windsurf", Icon: FilePenLine },
  { id: "zed", label: "Zed", Icon: FilePenLine },
  { id: "sublime", label: "Sublime Text", Icon: SublimeIcon },
  { id: "intellij-idea", label: "IntelliJ IDEA", Icon: IntelliJIcon },
  { id: "webstorm", label: "WebStorm", Icon: WebStormIcon },
  { id: "goland", label: "GoLand", Icon: GoLandIcon },
  { id: "clion", label: "CLion", Icon: CLionIcon },
  { id: "rustrover", label: "RustRover", Icon: FilePenLine },
  { id: "xcode", label: "Xcode", Icon: XcodeIcon },
  { id: "terminal", label: "Terminal", Icon: TerminalIcon, terminal: true },
  { id: "git-bash", label: "Git Bash", Icon: GitIcon, terminal: true },
  { id: "wsl", label: "WSL", Icon: WslIcon, terminal: true },
  { id: "android-studio", label: "Android Studio", Icon: AndroidIcon },
  { id: "pycharm", label: "PyCharm", Icon: PyCharmIcon },
];

export function installedWorkspaceEditorTargets(targets: readonly string[], preferredEditor = "") {
  return WORKSPACE_OPEN_TARGETS.filter(({ id }) => targets.includes(id)).sort(
    (first, second) => Number(second.id === preferredEditor) - Number(first.id === preferredEditor),
  );
}

export function WorkspaceEditorMenuItems({ onOpen }: { onOpen: (editor: string) => void }) {
  const { locale } = useLocale();
  const { targets, preferredEditor } = useWorkspaceEditors(true);
  const [preferred, ...others] = installedWorkspaceEditorTargets(targets, preferredEditor).filter(
    ({ terminal }) => !terminal,
  );
  if (!preferred) return null;
  const openIn = (label: string) =>
    locale === "zh-CN" ? `在 ${label} 中打开` : `Open in ${label}`;
  return (
    <>
      <ContextMenuItem onClick={() => onOpen(preferred.id)}>
        <preferred.Icon aria-hidden="true" className="size-3.5 shrink-0" />
        {openIn(preferred.label)}
      </ContextMenuItem>
      {others.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {locale === "zh-CN" ? "在其他编辑器中打开" : "Open in Other Editor"}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {others.map(({ id, label, Icon }) => (
              <ContextMenuItem key={id} onClick={() => onOpen(id)}>
                <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                {label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
    </>
  );
}
