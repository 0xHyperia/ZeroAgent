import type { PreviewArchiveEntry } from "./previewArchive";

export type PreviewWorkerInput =
  | { type: "load"; kind: "inspect" | "pptx" | "sheet"; bytes: Uint8Array }
  | { type: "slide"; index: number }
  | { type: "sheet"; name: string };
export type PreviewWorkerResult = {
  entries?: PreviewArchiveEntry[];
  slideCount?: number;
  svg?: string;
  sheetNames?: string[];
  rows?: string[][];
};
