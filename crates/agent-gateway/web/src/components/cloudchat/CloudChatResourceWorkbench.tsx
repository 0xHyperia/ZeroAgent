import { WorkbenchBody } from "@liveagent/ui/application/WorkbenchShell";
import { ResourcePreviewReadingSession } from "@liveagent/ui/components/resource-preview/ResourcePreview";
import { createContext, type ReactNode, useEffect, useRef, useState } from "react";

export const CloudChatReaderLayout = createContext<{
  expanded: boolean;
  canSplit: boolean;
  toggleExpanded: () => void;
} | null>(null);

/** Presentation only: both the original canvas and resource controller stay mounted. */
export function CloudChatResourceWorkbench(props: {
  open: boolean;
  primaryVisible: boolean;
  readingScope?: string;
  primary: ReactNode | ((readingOnly: boolean) => ReactNode);
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [canSplit, setCanSplit] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setCanSplit(element.getBoundingClientRect().width >= 1040);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!props.open) setExpanded(false);
  }, [props.open]);
  const readingOnly = props.open && (expanded || !canSplit);
  return (
    <ResourcePreviewReadingSession scope={props.readingScope ?? "workspace"}>
      <CloudChatReaderLayout.Provider
        value={{ expanded, canSplit, toggleExpanded: () => setExpanded((value) => !value) }}
      >
        <WorkbenchBody
          ref={host}
          className="cloud-resource-workbench"
          data-reader-open={props.open}
          data-reader-only={readingOnly}
        >
          <div
            className="cloud-workspace-primary"
            hidden={!props.primaryVisible || readingOnly}
            inert={!props.primaryVisible || readingOnly}
          >
            {typeof props.primary === "function" ? props.primary(readingOnly) : props.primary}
          </div>
          {props.children}
        </WorkbenchBody>
      </CloudChatReaderLayout.Provider>
    </ResourcePreviewReadingSession>
  );
}
