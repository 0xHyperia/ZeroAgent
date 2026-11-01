import type { PreviewArchiveEntry } from "./previewArchive";
import type { SheetModel } from "./sheetModel";

export type PreviewWorkerInput =
  | { type: "load"; kind: "inspect" | "pptx" | "sheet" | "sheet-source"; bytes: Uint8Array }
  | { type: "slide"; index: number }
  | { type: "sheet"; name: string };
export type PreviewWorkerResult = {
  entries?: PreviewArchiveEntry[];
  slideCount?: number;
  svg?: string;
  sheetNames?: string[];
  rows?: string[][];
  sheet?: SheetModel;
  workbookBytes?: Uint8Array;
  sheetFallback?: boolean;
};
