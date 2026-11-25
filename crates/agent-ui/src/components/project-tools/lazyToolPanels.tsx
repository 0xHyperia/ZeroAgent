// Project tool panels load the first time a dock tab or workbench pane shows them, so the
// chat startup bundle does not carry the diff viewer, tree view or tunnel UIs.
// The exports keep the panels' own names and props.
import type { ComponentProps } from "react";
import { onDemand } from "../OnDemand";
import type {
  FileTreePanel as FileTreePanelComponent,
  FileTreePaneSurface as FileTreePaneSurfaceComponent,
} from "./file-tree/index";
import type { GitReviewPanel as GitReviewPanelComponent } from "./git-review/index";
import type { LocalTunnelPanel as LocalTunnelPanelComponent } from "./LocalTunnelPanel";
import type { SshTunnelPanel as SshTunnelPanelComponent } from "./SshTunnelPanel";

export const FileTreePanel = onDemand<ComponentProps<typeof FileTreePanelComponent>>(
  async () => (await import("./file-tree/index")).FileTreePanel,
);

export const FileTreePaneSurface = onDemand<ComponentProps<typeof FileTreePaneSurfaceComponent>>(
  async () => (await import("./file-tree/index")).FileTreePaneSurface,
);

export const GitReviewPanel = onDemand<ComponentProps<typeof GitReviewPanelComponent>>(
  async () => (await import("./git-review/index")).GitReviewPanel,
);

export const LocalTunnelPanel = onDemand<ComponentProps<typeof LocalTunnelPanelComponent>>(
  async () => (await import("./LocalTunnelPanel")).LocalTunnelPanel,
);

export const SshTunnelPanel = onDemand<ComponentProps<typeof SshTunnelPanelComponent>>(
  async () => (await import("./SshTunnelPanel")).SshTunnelPanel,
);
