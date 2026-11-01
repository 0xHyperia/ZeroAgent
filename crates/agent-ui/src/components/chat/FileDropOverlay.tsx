import { FileDropPrompt } from "../files/FileDropPrompt";

/** Native hosts retain their drag routing and only share the visual surface. */
export function FileDropOverlay(props: {
  canDropUpload: boolean;
  title: string;
  description: string;
  limitHint: string;
  variant?: "panel" | "composer";
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 rounded-[inherit]" aria-hidden="true">
      <FileDropPrompt
        title={props.title}
        hint={[props.description, props.limitHint].filter(Boolean).join(" · ")}
        blocked={!props.canDropUpload}
        compact={props.variant === "composer"}
      />
    </div>
  );
}
