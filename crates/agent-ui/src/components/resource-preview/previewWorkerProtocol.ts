import type { DocumentRegion } from "./docxReaderDocument";
import type { PreviewArchiveEntry } from "./previewArchive";
import type { SheetModel } from "./sheetModel";

export type SlideRevisionMetadata = {
  slideId: string;
  slideTitle?: string;
  width: number;
  height: number;
  elements: {
    id: string;
    name: string;
    kind: string;
    rotation: number;
    quote: string;
    region: DocumentRegion;
  }[];
};

export type PreviewWorkerInput =
  | { type: "load"; kind: "inspect" | "sheet" | "sheet-source"; bytes: Uint8Array }
  | { type: "load"; kind: "pptx"; bytes: Uint8Array; includeAnnotations?: boolean }
  | { type: "slide"; index: number; includeAnnotations?: boolean }
  | { type: "sheet"; name: string };
export type PreviewWorkerResult = {
  entries?: PreviewArchiveEntry[];
  slideCount?: number;
  hiddenSlides?: number[];
  svg?: string;
  slideRevision?: SlideRevisionMetadata;
  sheetNames?: string[];
  rows?: string[][];
  sheet?: SheetModel;
  workbookBytes?: Uint8Array;
  sheetFallback?: boolean;
};
