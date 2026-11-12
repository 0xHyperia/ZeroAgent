import { createContext, type ReactNode } from "react";
import type { DocumentRevisionComment } from "./ResourceDocumentComments";

export type MarkdownSelectionActions = {
  onAddToChat: (text: string, comment?: string) => boolean;
  onEditSource?: (line: number, column: number) => void;
};

export type WorkspaceImageActions = {
  onCopy: () => Promise<void>;
  onCopyAbsolutePath?: () => Promise<void>;
  onCopyRelativePath?: () => Promise<void>;
  onOpenInSystemViewer?: () => void;
  sizeBytes: number;
};

/** Reading identity and presentation hooks; no bytes or credentials. */
export const PreviewIdentityContext = createContext<{
  name: string;
  mime: string;
  thumbnail?: boolean;
  loadingStartedAt?: number;
  loadingSkeleton?: "media";
  sourceRange?: { fromLine: number; toLine?: number };
  sourcePaths?: { path?: string; relativePath?: string };
  workspaceImageActions?: WorkspaceImageActions;
  markdownSelectionActions?: MarkdownSelectionActions;
  onRequestRevision?: (
    comments: readonly DocumentRevisionComment[],
    evidence?: readonly File[],
  ) => Promise<boolean> | boolean;
}>({ name: "file", mime: "" });
export const PreviewToolbarMount = createContext<{
  target: HTMLElement | null;
  leadingTarget?: HTMLElement | null;
  optionsTarget?: HTMLElement | null;
  inspectorOpen?: boolean;
  pageTarget?: HTMLElement | null;
  workspaceTab?: boolean;
  fileMenu?: ReactNode;
  setFileMenu?: (content: ReactNode) => void;
  registerEscapeHandler?: (handler: () => boolean) => () => void;
} | null>(null);
