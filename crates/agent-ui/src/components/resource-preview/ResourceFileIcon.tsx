import type { SVGProps } from "react";
import Code2 from "~icons/lucide/code-xml";
import { getFileTypeIcon, getUploadedFileTypeIcon } from "../chat/fileTypeIcons";
import { FileText } from "../IconSet";
import { isSourceFileName } from "./sourceFileType";

type Props = SVGProps<SVGSVGElement>;

/** Reading surfaces use a quiet outline family; source-tree icons retain their language marks. */
function DocumentIcon({ kind, ...props }: Props & { kind: "word" | "pdf" | "sheet" | "slides" }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M8 3.5h7l4.5 4.5v10.5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" />
      <path d="M15 3.5V8h4.5" />
      {kind === "word" ? (
        <>
          <rect x="2.5" y="9" width="10" height="8" rx="1.5" fill="var(--za-surface, white)" />
          <path d="m4.5 11 1 4 1-2.5L8 15l1-4M15 12h2M15 15h2" />
        </>
      ) : null}
      {kind === "pdf" ? (
        <path d="M3 11h1.5a1.5 1.5 0 0 1 0 3H3v3m5-6v6h1a3 3 0 0 0 0-6H8m6 6v-6h3m-3 3h2" />
      ) : null}
      {kind === "sheet" ? (
        <>
          <rect x="9" y="11" width="7" height="6" rx=".5" />
          <path d="M9 14h7m-3.5-3v6" />
        </>
      ) : null}
      {kind === "slides" ? (
        <>
          <path d="M13 11a3.5 3.5 0 1 0 3.5 3.5H13V11Z" />
          <path d="M15 10v2.5h2.5A3.5 3.5 0 0 0 15 10Z" />
        </>
      ) : null}
    </svg>
  );
}

const WordIcon = (props: Props) => <DocumentIcon kind="word" color="#4b87d1" {...props} />;
const PDFIcon = (props: Props) => <DocumentIcon kind="pdf" color="#d46770" {...props} />;
const SheetIcon = (props: Props) => <DocumentIcon kind="sheet" color="#40966c" {...props} />;
const SlidesIcon = (props: Props) => <DocumentIcon kind="slides" color="#ce7184" {...props} />;
const MarkdownIcon = (props: Props) => <FileText color="#4b87d1" {...props} />;

function documentIcon(name: string) {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "docx" || extension === "doc") return WordIcon;
  if (extension === "pdf") return PDFIcon;
  if (["xlsx", "xls", "csv", "tsv", "ods"].includes(extension ?? "")) return SheetIcon;
  if (["pptx", "ppt", "odp"].includes(extension ?? "")) return SlidesIcon;
  if (["md", "markdown", "mdown", "mkd"].includes(extension ?? "")) return MarkdownIcon;
  if (isSourceFileName(name) && !/\.(?:txt|log)$/i.test(name)) return Code2;
  return null;
}

export function getResourceFileIcon(name: string) {
  return documentIcon(name) ?? getFileTypeIcon(name, "file");
}
export function getUploadedResourceFileIcon(file: { fileName: string; kind: string }) {
  return documentIcon(file.fileName) ?? getUploadedFileTypeIcon(file);
}
