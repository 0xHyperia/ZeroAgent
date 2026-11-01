import { WorkbenchBody } from "@liveagent/ui/application/WorkbenchShell";
import { ResourcePreviewReadingSession } from "@liveagent/ui/components/resource-preview/ResourcePreview";
import { DividerLayer } from "@liveagent/ui/components/workbench/DividerLayer";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import { CloudChatReaderLayout } from "./CloudChatReaderContext";

/** Presentation only: both the original canvas and resource controller stay mounted. */
export function CloudChatResourceWorkbench(props: {
  open: boolean;
  primaryVisible: boolean;
  readingScope?: string;
  header?: ReactNode;
  primary: ReactNode | ((readingOnly: boolean) => ReactNode);
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [canSplit, setCanSplit] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [split, setSplit] = useState({ scope: props.readingScope, ratio: 0.44 });
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    const element = host;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setCanSplit(width >= 900);
      setArea((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [host]);
  useEffect(() => {
    if (!props.open) setExpanded(false);
  }, [props.open]);
  const readingOnly = props.open && (!props.primaryVisible || expanded || !canSplit);
  const usable = Math.max(1, area.width - 8);
  const ratio = Math.max(
    320 / usable,
    Math.min(1 - 420 / usable, split.scope === props.readingScope ? split.ratio : 0.44),
  );
  const primaryWidth = usable * ratio;
  const changeRatio = (_id: string, value: number) =>
    setSplit({ scope: props.readingScope, ratio: value });
  useEffect(() => {
    const end = () => setResizing(false);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, []);
  return (
    <ResourcePreviewReadingSession scope={props.readingScope ?? "workspace"}>
      <CloudChatReaderLayout.Provider
        value={{
          expanded,
          canSplit: canSplit && props.primaryVisible,
          toggleExpanded: () => setExpanded((value) => !value),
        }}
      >
        <WorkbenchBody
          ref={setHost}
          className="cloud-resource-workbench"
          data-reader-open={props.open}
          data-reader-only={readingOnly}
          data-reader-resizing={resizing}
          style={{ "--cloud-primary-width": `${primaryWidth}px` } as CSSProperties}
          onPointerDownCapture={(event) => {
            if (
              event.button === 0 &&
              event.target instanceof Element &&
              event.target.closest('[data-workbench-divider="cloud-reader"]')
            )
              setResizing(true);
          }}
          onLostPointerCapture={() => setResizing(false)}
        >
          <div
            className="cloud-workspace-primary"
            hidden={!props.primaryVisible || readingOnly}
            inert={!props.primaryVisible || readingOnly}
          >
            <div className="cloud-workspace-chrome">{props.header}</div>
            {typeof props.primary === "function" ? props.primary(readingOnly) : props.primary}
          </div>
          {props.open && !readingOnly ? (
            <div className="cloud-reader-divider-gap" aria-hidden="true" />
          ) : null}
          {props.children}
          <DividerLayer
            dividers={
              props.open && !readingOnly
                ? [
                    {
                      splitId: "cloud-reader",
                      axis: "horizontal",
                      splitArea: { left: 0, top: 0, ...area },
                      rect: { left: primaryWidth, top: 0, width: 8, height: area.height },
                    },
                  ]
                : []
            }
            dividerSize={8}
            hitSlop={8}
            separatorLabel="调整对话与预览宽度"
            minSizesForSplit={() => ({ firstMin: 320, secondMin: 420 })}
            onResizePreview={changeRatio}
            onResizeCommit={changeRatio}
            onEqualize={() => changeRatio("cloud-reader", 0.5)}
          />
        </WorkbenchBody>
      </CloudChatReaderLayout.Provider>
    </ResourcePreviewReadingSession>
  );
}
