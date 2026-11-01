import { Ban, FileText, ImageIcon, Upload } from "@liveagent/ui/components/IconSet";
import "./file-drop.css";

/** Visual drop target shared by browser and native drag lifetimes. */
export function FileDropPrompt({
  title,
  hint,
  blocked = false,
  compact = false,
  viewport = false,
}: {
  title: string;
  hint?: string;
  blocked?: boolean;
  compact?: boolean;
  viewport?: boolean;
}) {
  return (
    <div
      className="za-file-drop-overlay"
      data-blocked={blocked}
      data-compact={compact}
      data-coverage={viewport ? "viewport" : "local"}
      role="status"
    >
      <div className="za-file-drop-art" aria-hidden="true">
        <span className="za-file-drop-sheet">
          <FileText />
        </span>
        <span className="za-file-drop-picture">
          <ImageIcon />
        </span>
        <span className="za-file-drop-arrow">{blocked ? <Ban /> : <Upload />}</span>
      </div>
      <strong>{title}</strong>
      <span>{hint}</span>
    </div>
  );
}
