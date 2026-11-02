import { createContext, type ReactNode } from "react";
import type { DocumentRevisionComment } from "./ResourceDocumentComments";

/** Reading identity and toolbar placement only; no bytes, credentials or host actions. */
export const PreviewIdentityContext = createContext<{
  name: string;
  mime: string;
  thumbnail?: boolean;
  loadingStartedAt?: number;
  sourceRange?: { fromLine: number; toLine?: number };
  sourcePaths?: { path?: string; relativePath?: string };
  onRequestRevision?: (comments: readonly DocumentRevisionComment[]) => Promise<boolean> | boolean;
}>({ name: "file", mime: "" });
export const PreviewToolbarMount = createContext<{
  target: HTMLElement | null;
  leadingTarget?: HTMLElement | null;
  optionsTarget?: HTMLElement | null;
  inspectorOpen?: boolean;
  pageTarget?: HTMLElement | null;
  fileMenu?: ReactNode;
  setFileMenu?: (content: ReactNode) => void;
} | null>(null);
