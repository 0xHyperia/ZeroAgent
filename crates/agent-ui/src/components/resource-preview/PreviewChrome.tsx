import { createContext, type ReactNode } from "react";
import type { DocumentRevisionComment } from "./ResourceDocumentComments";

/** Reading identity and toolbar placement only; no bytes, credentials or host actions. */
export const PreviewIdentityContext = createContext<{
  name: string;
  mime: string;
  onRequestRevision?: (comments: readonly DocumentRevisionComment[]) => Promise<boolean> | boolean;
}>({ name: "file", mime: "" });
export const PreviewToolbarMount = createContext<{
  target: HTMLElement | null;
  pageTarget?: HTMLElement | null;
  fileMenu?: ReactNode;
  setFileMenu?: (content: ReactNode) => void;
} | null>(null);
