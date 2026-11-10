import {
  useWorkspaceTabPresentation,
  type WorkspaceTabOptions,
} from "@liveagent/ui/components/project-tools/WorkspaceTabPresentation";
import { type ComponentProps, lazy } from "react";

const BrowserPane = lazy(async () => ({
  default: (await import("../../../components/workbench-browser/WorkbenchBrowserPane"))
    .WorkbenchBrowserPane,
}));

type BrowserAnnotation = Parameters<
  NonNullable<ComponentProps<typeof BrowserPane>["onAnnotate"]>
>[0];

export function useDesktopWorkspaceTabPresentation(
  options: WorkspaceTabOptions<BrowserAnnotation>,
) {
  return useWorkspaceTabPresentation({ ...options, browserPane: BrowserPane });
}
