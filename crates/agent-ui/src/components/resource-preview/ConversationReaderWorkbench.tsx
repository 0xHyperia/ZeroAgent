import { WorkbenchBody } from "@liveagent/ui/application/WorkbenchShell";
import { ResourcePreviewReadingSession } from "@liveagent/ui/components/resource-preview/ResourcePreview";
import { DividerLayer } from "@liveagent/ui/components/workbench/DividerLayer";
import { useLocale } from "@liveagent/ui/i18n";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import {
  ConversationFocusComposer,
  type ConversationImageComposerEdit,
  ConversationReaderLayout,
} from "./conversationReaderLayout";
import "./conversation-reader-workbench.css";

const DEFAULT_READER_SPLIT_RATIO = 0.44;

/** Presentation only: both the original canvas and resource controller stay mounted. */
export function ConversationReaderWorkbench(props: {
  open: boolean;
  primaryVisible: boolean;
  onSplitAvailabilityChange?: (canSplit: boolean) => void;
  readingScope?: string;
  defaultSplitRatio?: number;
  header?: ReactNode;
  headerPlacement?: "primary" | "workspace";
  headerInFlow?: boolean;
  primary: ReactNode | ((readingOnly: boolean) => ReactNode);
  children: ReactNode;
}) {
  const { t } = useLocale();
  const defaultRatio = props.defaultSplitRatio ?? DEFAULT_READER_SPLIT_RATIO;
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [composerTarget, setComposerTarget] = useState<HTMLElement | null>(null);
  const [composerEdit, setComposerEdit] = useState<ConversationImageComposerEdit | null>(null);
  const [canSplit, setCanSplit] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [split, setSplit] = useState({
    scope: props.readingScope,
    mode: defaultRatio,
    ratio: defaultRatio,
  });
  const [splitPreview, setSplitPreview] = useState<typeof split | null>(null);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    const element = host;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (
        width < 900 &&
        element.contains(document.activeElement) &&
        document.activeElement?.matches('[data-workbench-divider="cloud-reader"]')
      )
        element.querySelector<HTMLButtonElement>("[data-cloud-reader-return]")?.focus({
          preventScroll: true,
        });
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
    props.onSplitAvailabilityChange?.(canSplit);
  }, [canSplit, props.onSplitAvailabilityChange]);
  useEffect(() => {
    if (!props.open) setExpanded(false);
  }, [props.open]);
  const readingOnly = props.open && (!props.primaryVisible || expanded || !canSplit);
  const workspaceHeader = props.headerPlacement === "workspace";
  const usable = Math.max(1, area.width - 8);
  const currentSplit = splitPreview ?? split;
  const ratio = Math.max(
    320 / usable,
    Math.min(
      1 - 420 / usable,
      currentSplit.scope === props.readingScope && currentSplit.mode === defaultRatio
        ? currentSplit.ratio
        : defaultRatio,
    ),
  );
  const primaryWidth = usable * ratio;
  const nextSplit = (value: number) => ({
    scope: props.readingScope,
    mode: defaultRatio,
    ratio: value,
  });
  const changeRatio = (_id: string, value: number) => {
    setSplitPreview(null);
    setSplit(nextSplit(value));
  };
  return (
    <ResourcePreviewReadingSession scope={props.readingScope ?? "workspace"}>
      <ConversationFocusComposer.Provider
        value={{
          target: composerTarget,
          setTarget: setComposerTarget,
          edit: composerEdit,
          setEdit: setComposerEdit,
        }}
      >
        <ConversationReaderLayout.Provider
          value={{
            expanded,
            canSplit: canSplit && props.primaryVisible,
            toggleExpanded: () => setExpanded((value) => !value),
          }}
        >
          {workspaceHeader && props.header}
          <WorkbenchBody
            ref={setHost}
            className="cloud-resource-workbench"
            data-reader-open={props.open}
            data-reader-only={readingOnly}
            data-reader-resizing={resizing}
            data-header-in-flow={props.headerInFlow || undefined}
            style={{ "--cloud-primary-width": `${primaryWidth}px` } as CSSProperties}
          >
            <div
              className="cloud-workspace-primary"
              hidden={!props.primaryVisible || readingOnly}
              inert={!props.primaryVisible || readingOnly}
            >
              {!workspaceHeader && <div className="cloud-workspace-chrome">{props.header}</div>}
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
              separatorLabel={t("layout.resizeChatReader")}
              resetHint={t("layout.resetSplitHint")}
              minSizesForSplit={() => ({ firstMin: 320, secondMin: 420 })}
              onResizePreview={(_id, value) => setSplitPreview(nextSplit(value))}
              onResizeCommit={changeRatio}
              onResizeCancel={() => setSplitPreview(null)}
              onDragStateChange={setResizing}
              onEqualize={() => changeRatio("cloud-reader", defaultRatio)}
            />
          </WorkbenchBody>
        </ConversationReaderLayout.Provider>
      </ConversationFocusComposer.Provider>
    </ResourcePreviewReadingSession>
  );
}
