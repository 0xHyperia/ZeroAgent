import {
  type CSSProperties,
  type PointerEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import Diamond from "~icons/lucide/diamond";
import Eraser from "~icons/lucide/eraser";
import Heart from "~icons/lucide/heart";
import Shapes from "~icons/lucide/shapes";
import Triangle from "~icons/lucide/triangle";
import Type from "~icons/lucide/type";
import { useLocale } from "../../i18n";
import type { AssistantDeliverable } from "../../lib/chat/assistantResources";
import { VisualCreationPending } from "../chat/AssistantVisuals";
import { createUuid } from "../../lib/shared/id";
import {
  ArrowUp,
  ArrowUpRight,
  BrushCleaning,
  ChevronDown,
  Circle,
  Download,
  ImageIcon,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
  Minus,
  PanelRightOpen,
  Redo2,
  Scissors,
  Square,
  SquareMousePointer,
  SquarePen,
  Star,
  Undo2,
  X,
} from "../IconSet";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "../ui/popover";
import { TooltipButton as Button } from "../ui/tooltip-button";
import {
  conversationImageCommentEdit,
  type ConversationImageEdit,
  type ConversationImageEditReceipt,
  conversationImageRatios,
  createImageRegionReference,
  eraseImageMarks,
  type ImageComment,
  type ImagePoint,
  type ImageMark,
  type ImageShape,
  imageEditInstruction,
  imageMarkAt,
  imageShapePoints,
  transformImageShape,
} from "./conversationImageAnnotation";
import { ConversationImageComments } from "./ConversationImageComments";
import { ConversationImageInk, ConversationImageShapeSelection } from "./ConversationImageInk";
import {
  canAnimateImageFocus,
  enterImageFocus,
  type ImageFocusOrigin,
  imageFocusDuration,
  imageFocusOrigin,
  leaveImageFocus,
} from "./conversationImageFocusMotion";
import {
  type ConversationImageSources,
  useConversationImageSource,
} from "./conversationImageSources";
import { ConversationFocusComposer, ConversationReaderLayout } from "./conversationReaderLayout";
import { mountImagePreviewWindowChrome } from "./imagePreviewWindowChrome";
import { PreviewToolbarMount } from "./PreviewChrome";
import { PreviewDock } from "./PreviewDock";
import { PreviewLoading, PreviewUnavailable } from "./PreviewFeedback";
import ResourceImagePreview from "./ResourceImagePreview";
import "./conversation-image-preview.css";

type ImageItem = AssistantDeliverable;
type Mark = ImageMark;
type ImageAction = { kind: "background" } | { kind: "resize"; ratio: string };
type RegionDraft = {
  marks: Mark[];
  undo: Mark[][];
  redo: Mark[][];
  regionRequest?: { marks: Mark[]; id: string };
};
type EditDraft = RegionDraft & { text: string; erase?: RegionDraft; comments?: ImageComment[] };
type PreviewRun = {
  scope: string;
  receipt: ConversationImageEditReceipt;
  controller: AbortController;
  stopping: boolean;
  stopFailed?: boolean;
};
const emptyRegions: RegionDraft = { marks: [], undo: [], redo: [] };
const emptyComments: ImageComment[] = [];
const emptyDraft: EditDraft = { ...emptyRegions, text: "" };
const maxImages = 100;

function imageNavigationDirection(event: KeyboardEvent): -1 | 1 | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
  if (event.key === "ArrowUp" || event.key === "ArrowLeft") return -1;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") return 1;
}
const imageShapes = [
  { id: "line", zh: "直线", en: "Line", Icon: Minus },
  { id: "arrow", zh: "箭头", en: "Arrow", Icon: ArrowUpRight },
  { id: "box", zh: "矩形", en: "Rectangle", Icon: Square },
  { id: "ellipse", zh: "椭圆", en: "Ellipse", Icon: Circle },
  { id: "triangle", zh: "三角形", en: "Triangle", Icon: Triangle },
  { id: "diamond", zh: "菱形", en: "Diamond", Icon: Diamond },
  { id: "star", zh: "星形", en: "Star", Icon: Star },
  { id: "heart", zh: "心形", en: "Heart", Icon: Heart },
] as const;
const inkColors = [
  ["#181818", "黑色", "Black"],
  ["#6b7280", "灰色", "Gray"],
  ["#92400e", "棕色", "Brown"],
  ["#e52b36", "红色", "Red"],
  ["#ed7626", "橙色", "Orange"],
  ["#f2c439", "黄色", "Yellow"],
  ["#288c47", "绿色", "Green"],
  ["#0f928a", "青绿色", "Teal"],
  ["#06b6d4", "青色", "Cyan"],
  ["#1a6de1", "蓝色", "Blue"],
  ["#5959d7", "靛蓝色", "Indigo"],
  ["#a855f7", "紫色", "Purple"],
  ["#db2777", "粉色", "Pink"],
] as const;

export function useConversationImagePreview(scope: string) {
  const images = useRef<{ scope: string; items: Map<string, ImageItem> }>({
    scope,
    items: new Map(),
  });
  const [selected, setSelected] = useState<{
    scope: string;
    id: string;
    edit?: boolean;
    waiting?: boolean;
  }>();
  const runRef = useRef<PreviewRun | undefined>(undefined);
  const [run, setRun] = useState<PreviewRun>();
  const [editDrafts, setEditDrafts] = useState<{
    scope: string;
    items: Map<string, EditDraft>;
  }>();
  const trigger = useRef<HTMLElement | null>(null);
  const origin = useRef<ImageFocusOrigin | undefined>(undefined);
  const [panel, setPanel] = useState(false);
  const [, refresh] = useState(0);
  const register = useCallback(
    (items: readonly ImageItem[]) => {
      if (images.current.scope !== scope) images.current = { scope, items: new Map() };
      const known = images.current.items;
      let changed = false;
      for (const item of items) {
        if (known.has(item.id)) continue;
        known.set(item.id, item);
        changed = true;
      }
      if (!changed) return;
      while (known.size > maxImages) {
        const oldest = [...known.keys()].find((id) => id !== selected?.id);
        if (!oldest) break;
        known.delete(oldest);
      }
      if (selected?.scope === scope) refresh((version) => version + 1);
    },
    [scope, selected?.scope, selected?.id],
  );
  const open = useCallback(
    (item: ImageItem, edit = false, source?: HTMLElement) => {
      register([item]);
      trigger.current =
        source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      origin.current = imageFocusOrigin(item.id, trigger.current);
      setPanel(false);
      setSelected({ scope, id: item.id, edit });
    },
    [register, scope],
  );
  const item =
    selected?.scope === scope && images.current.scope === scope
      ? images.current.items.get(selected.id)
      : undefined;
  const close = useCallback((restoreFocus = false) => {
    setSelected(undefined);
    const element = trigger.current;
    trigger.current = null;
    origin.current = undefined;
    if (restoreFocus)
      requestAnimationFrame(() => {
        if (element?.isConnected) element.focus({ preventScroll: true });
      });
  }, []);
  useEffect(() => {
    if (selected && selected.scope !== scope) close();
  }, [close, scope, selected]);
  useEffect(
    () => () => {
      const active = runRef.current;
      if (active?.scope !== scope) return;
      runRef.current = undefined;
      active.controller.abort();
    },
    [scope],
  );
  const select = (item: ImageItem) => {
    register([item]);
    setSelected((old) => ({
      scope,
      id: item.id,
      edit: old?.scope === scope ? old.edit : undefined,
    }));
  };
  const selectWaiting = () => {
    setSelected((old) => (old?.scope === scope ? { ...old, waiting: true } : old));
  };
  const trackRun = (receipt: ConversationImageEditReceipt, controller: AbortController) => {
    const active = { scope, receipt, controller, stopping: false };
    runRef.current = active;
    setRun(active);
    const finish = (result?: ImageItem) => {
      if (runRef.current?.receipt !== receipt || controller.signal.aborted) return;
      runRef.current = undefined;
      setRun(undefined);
      if (result) register([result]);
      setSelected((old) =>
        old?.scope === scope && old.waiting
          ? { ...old, waiting: false, id: result?.id ?? old.id }
          : old,
      );
    };
    void receipt.result.then(finish, () => finish());
  };
  const stopRun = useCallback(() => {
    const active = runRef.current;
    if (!active || active.scope !== scope || active.stopping) return;
    const stopping = { ...active, stopping: true, stopFailed: false };
    runRef.current = stopping;
    setRun(stopping);
    const unavailable = () => {
      if (runRef.current !== stopping || active.controller.signal.aborted) return;
      const retry = { ...active, stopFailed: true };
      runRef.current = retry;
      setRun(retry);
    };
    void Promise.resolve()
      .then(active.receipt.stop)
      .then((stopped) => {
        if (!stopped) unavailable();
      }, unavailable);
  }, [scope]);
  const updateDraft = useCallback(
    (id: string, change: (previous: EditDraft) => EditDraft) => {
      setEditDrafts((state) => {
        if (images.current.scope !== scope) return state;
        const previous = state?.scope === scope ? (state.items.get(id) ?? emptyDraft) : emptyDraft;
        const next = change(previous);
        if (next === previous) return state;
        const items = new Map(state?.scope === scope ? state.items : undefined);
        items.delete(id);
        if (next !== emptyDraft) items.set(id, next);
        if (items.size > maxImages) {
          const oldest = items.keys().next().value;
          if (oldest) items.delete(oldest);
        }
        return { scope, items };
      });
    },
    [scope],
  );
  return {
    item,
    edit: selected?.edit,
    origin: origin.current,
    panel: Boolean(item && panel),
    setPanel,
    register,
    open,
    close,
    select,
    waitingSelected: selected?.scope === scope && selected.waiting === true,
    selectWaiting,
    trackRun,
    stopRun,
    run: run?.scope === scope && !run.controller.signal.aborted ? run : undefined,
    draft: item && editDrafts?.scope === scope ? editDrafts.items.get(item.id) : undefined,
    updateDraft,
    find: (id: string) =>
      images.current.scope === scope ? images.current.items.get(id) : undefined,
    items: item ? Array.from(images.current.items.values()) : [],
  };
}

type Props = {
  item: ImageItem;
  items: readonly ImageItem[];
  panel: boolean;
  origin?: ImageFocusOrigin;
  edit?: boolean;
  onPanel: () => void;
  onPreview: () => void;
  onClose: (restoreFocus?: boolean) => void;
  onSelect: (item: ImageItem) => void;
  waitingSelected: boolean;
  onSelectWaiting: () => void;
  onTrackRun: (receipt: ConversationImageEditReceipt, controller: AbortController) => void;
  onStopRun: () => void;
  run?: PreviewRun;
  draft?: EditDraft;
  updateDraft: (id: string, change: (previous: EditDraft) => EditDraft) => void;
  sources: ConversationImageSources;
  onDownload: (item: ImageItem, signal: AbortSignal) => Promise<void>;
  onEdit?: (
    item: ImageItem,
    edit: ConversationImageEdit,
    signal: AbortSignal,
    keepPanel: boolean,
  ) => Promise<boolean | ConversationImageEditReceipt>;
};

export function ConversationImagePreview(props: Props) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const layout = useContext(ConversationReaderLayout);
  const composer = useContext(ConversationFocusComposer);
  const setComposerTarget = composer?.setTarget;
  const setComposerEdit = composer?.setEdit;
  const useSharedComposer =
    Boolean(setComposerEdit) && (!props.panel || (layout?.canSplit && !layout.expanded));
  const [zoomTarget, setZoomTarget] = useState<HTMLDivElement | null>(null);
  const fitBounds = useRef<HTMLDivElement>(null);
  const [focusArea, setFocusArea] = useState<{ width: number; height: number; offsetY: number }>();
  const [overview, setOverview] = useState(false);
  const [mode, setMode] = useState<
    "comment" | "mark" | "pointer" | ImageShape | "text" | "remove-mark" | "erase" | undefined
  >();
  const shape = imageShapes.find((entry) => entry.id === mode);
  const ShapeIcon = shape?.Icon ?? Shapes;
  const [activeMark, setActiveMark] = useState<Mark>();
  const [penColor, setPenColor] = useState("#e52b36");
  const [penWidth, setPenWidth] = useState(4);
  const [eraserWidth, setEraserWidth] = useState(52);
  const [markEraserWidth, setMarkEraserWidth] = useState(24);
  const [selectedShape, setSelectedShape] = useState<number>();
  const [shapeDraft, setShapeDraft] = useState<Mark>();
  const shapeGesture = useRef<
    | {
        pointer: number;
        index: number;
        original: Mark;
        origin: ImagePoint;
        handle?: string;
      }
    | undefined
  >(undefined);
  const widthGesture = useRef<{ mark?: Mark } | undefined>(undefined);
  const brushCursor = useRef<SVGGElement>(null);
  const [comment, setComment] = useState<ImageComment>();
  const touchStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const [textMark, setTextMark] = useState<{
    point: Mark["points"][number];
    text: string;
    size: number;
    index?: number;
  }>();
  const textResize = useRef<{ x: number; size: number } | null>(null);
  const focusTextMark = useCallback((element: HTMLInputElement | null) => {
    element?.focus({ preventScroll: true });
  }, []);
  const stroke = useRef<
    { pointer: number; mark: Mark; origin: Mark["points"][number] } | undefined
  >(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  const section = useRef<HTMLElement>(null);
  const navigateFromInput = useRef<(direction: -1 | 1) => void>(() => {});
  const focusLayer = useRef<HTMLDivElement>(null);
  const entrance = useRef<(() => void) | undefined>(undefined);
  const enteredFrom = useRef<ImageFocusOrigin | undefined>(undefined);
  const exit = useRef<(() => void) | undefined>(undefined);
  const exitTimer = useRef<number | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  const [discard, setDiscard] = useState<{ tool: boolean; restoreFocus: boolean }>();
  const windowChrome = useRef<HTMLDivElement>(null);
  const waitThumb = useRef<HTMLButtonElement>(null);
  const operation = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState<"download" | "edit">();
  const [preparingEdit, setPreparingEdit] = useState(false);
  const [queued, setQueued] = useState(false);
  const { run } = props;
  const stopping = run?.stopping ?? false;
  const hasWaiting = preparingEdit || Boolean(run);
  const showWaiting = hasWaiting && props.waitingSelected;
  const toolsLocked = Boolean(busy) || hasWaiting;
  const waitLabel = preparingEdit
    ? zh
      ? "正在准备修改"
      : "Preparing image edit"
    : stopping
      ? zh
        ? "正在停止"
        : "Stopping"
      : zh
        ? "正在生成图像"
        : "Creating image";
  const [error, setError] = useState("");
  const item = props.item;
  const draft = props.draft ?? emptyDraft;
  const comments = draft.comments ?? emptyComments;
  const commenting = mode === "comment";
  const selectedIndex = showWaiting
    ? props.items.length
    : props.items.findIndex((entry) => entry.id === item.id);
  const beforeId = props.items[selectedIndex - 1]?.id;
  const afterId = props.items[selectedIndex + 1]?.id;
  const { sources } = props;
  useEffect(() => {
    const adjacent = [beforeId, afterId].flatMap((id) =>
      id ? [sources.display(id, "original")] : [],
    );
    for (const lease of adjacent) void lease.ready.catch(() => {});
    return () => {
      for (const lease of adjacent) lease.release();
    };
  }, [sources, beforeId, afterId]);
  const wheel = useRef({ at: 0, distance: 0, navigated: false });
  const update = (change: (previous: EditDraft) => EditDraft) => props.updateDraft(item.id, change);
  const regionKey = mode === "erase" ? "erase" : undefined;
  const regions = regionKey ? (draft[regionKey] ?? emptyRegions) : draft;
  const changeRegions = (change: (old: RegionDraft) => RegionDraft) =>
    update((old) =>
      regionKey
        ? { ...old, [regionKey]: change(old[regionKey] ?? emptyRegions) }
        : { ...old, ...change(old) },
    );
  const { updateDraft } = props;
  const updateText = useCallback(
    (value: string) => updateDraft(item.id, (old) => ({ ...old, text: value })),
    [item.id, updateDraft],
  );
  const changeMarks = (change: (previous: Mark[]) => Mark[]) =>
    changeRegions((old) => {
      const marks = change(old.marks);
      return marks === old.marks
        ? old
        : { ...old, marks, undo: [...old.undo.slice(-23), old.marks], redo: [] };
    });
  const undoMark = () =>
    changeRegions((old) =>
      old.undo.length
        ? {
            ...old,
            marks: old.undo[old.undo.length - 1],
            undo: old.undo.slice(0, -1),
            redo: [...old.redo, old.marks],
          }
        : old,
    );
  const redoMark = () =>
    changeRegions((old) =>
      old.redo.length
        ? {
            ...old,
            marks: old.redo[old.redo.length - 1],
            undo: [...old.undo, old.marks],
            redo: old.redo.slice(0, -1),
          }
        : old,
    );
  const hasInstruction = commenting
    ? comments.length > 0
    : Boolean(regions.marks.length || (!regionKey && draft.text.trim()));
  const dirty = commenting
    ? Boolean(comments.length || comment?.text.trim())
    : Boolean(
        activeMark ||
          regions.marks.length ||
          (!regionKey && (draft.text.trim() || textMark?.text.trim())),
      );

  useEffect(() => () => operation.current?.abort(), []);
  useLayoutEffect(() => {
    if (props.panel) return;
    const bounds = fitBounds.current;
    const reader = section.current;
    if (!bounds || !reader) return;
    const measure = () => {
      const box = bounds.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      const surface = reader.getBoundingClientRect();
      const next = {
        width: box.width,
        height: box.height,
        offsetY: box.top + box.height / 2 - (surface.top + surface.height / 2),
      };
      setFocusArea((old) =>
        old?.width === next.width && old.height === next.height && old.offsetY === next.offsetY
          ? old
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bounds);
    observer.observe(reader);
    return () => observer.disconnect();
  }, [props.panel]);
  useLayoutEffect(() => {
    if (!props.panel && windowChrome.current) {
      return mountImagePreviewWindowChrome(windowChrome.current);
    }
  }, [props.panel]);
  useLayoutEffect(() => {
    const layer = focusLayer.current;
    if (props.panel || props.origin?.id !== item.id) {
      enteredFrom.current = props.origin;
      return;
    }
    if (layer && enteredFrom.current !== props.origin) {
      entrance.current = enterImageFocus(layer, props.origin);
      return () => {
        entrance.current?.();
        entrance.current = undefined;
      };
    }
  }, [item.id, props.origin, props.panel]);
  useLayoutEffect(
    () => () => {
      window.clearTimeout(exitTimer.current);
      exit.current?.();
    },
    [],
  );
  const focusEditInput = useCallback(() => {
    requestAnimationFrame(() => {
      const editor = (
        focusLayer.current ?? section.current?.closest(".cloud-resource-workbench")
      )?.querySelector<HTMLTextAreaElement>("[data-image-edit-input]");
      (editor ?? input.current)?.focus({ preventScroll: true });
    });
  }, []);
  const resetShapeSelection = useCallback(() => {
    setSelectedShape(undefined);
    setShapeDraft(undefined);
    shapeGesture.current = undefined;
    widthGesture.current = undefined;
  }, []);
  const clearEditTool = useCallback(() => {
    updateDraft(item.id, (old) => {
      if (commenting) return { ...old, comments: undefined };
      if (regionKey) return { ...old, erase: undefined };
      return { ...old, ...emptyRegions, text: "", regionRequest: undefined };
    });
    setComment(undefined);
    setTextMark(undefined);
    setActiveMark(undefined);
    stroke.current = undefined;
    resetShapeSelection();
    setMode(undefined);
  }, [commenting, item.id, regionKey, resetShapeSelection, updateDraft]);
  const leaveEditTool = useCallback(() => {
    if (operation.current || discard) return;
    if (dirty) setDiscard({ tool: true, restoreFocus: false });
    else {
      clearEditTool();
      focusEditInput();
    }
  }, [clearEditTool, dirty, discard, focusEditInput]);
  useEffect(() => {
    if (props.edit) focusEditInput();
    else section.current?.focus({ preventScroll: true });
  }, [props.panel, props.edit, focusEditInput]);
  useEffect(() => {
    if (!hasWaiting && document.activeElement === document.body) {
      section.current?.focus({ preventScroll: true });
    }
  }, [hasWaiting]);
  useEffect(() => {
    if (showWaiting) waitThumb.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [showWaiting]);
  const closePreview = useCallback(
    (restoreFocus = true) => {
      if (closing || busy === "edit") return;
      const layer = focusLayer.current;
      if (props.panel || !layer || !canAnimateImageFocus()) {
        props.onClose(restoreFocus);
        return;
      }
      entrance.current?.();
      if (props.origin?.id === item.id) exit.current = leaveImageFocus(layer, props.origin);
      setClosing(true);
      exitTimer.current = window.setTimeout(() => props.onClose(restoreFocus), imageFocusDuration);
    },
    [busy, closing, item.id, props.onClose, props.origin, props.panel],
  );
  const close = useCallback(
    (restoreFocus = true) => {
      if (closing || busy === "edit" || discard) return;
      if (dirty && !hasWaiting) setDiscard({ tool: Boolean(mode), restoreFocus });
      else closePreview(restoreFocus);
    },
    [busy, closePreview, closing, dirty, discard, hasWaiting, mode],
  );
  useEffect(() => {
    const layer = focusLayer.current;
    if (!layer || props.panel) return;
    const handleFocusKeys = (event: KeyboardEvent) => {
      if (event.key === "Tab" && !event.defaultPrevented && event.target instanceof HTMLElement) {
        const controls = [
          ...layer.querySelectorAll<HTMLElement>(
            "button, input, textarea, a[href], [tabindex], [contenteditable=true]",
          ),
        ].filter(
          (control) =>
            control.tabIndex >= 0 &&
            !control.matches(":disabled") &&
            !control.closest("[hidden],[inert]") &&
            control.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (first && last && (event.shiftKey ? event.target === first : event.target === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus({ preventScroll: true });
        }
      }
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !event.isComposing &&
        event.target instanceof Element &&
        event.target.closest(".za-image-focus-composer")
      ) {
        event.preventDefault();
        if (mode) leaveEditTool();
        else close();
      }
      const direction = imageNavigationDirection(event);
      if (
        direction &&
        !event.defaultPrevented &&
        event.target instanceof HTMLTextAreaElement &&
        event.target.hasAttribute("data-image-edit-input") &&
        !event.target.value
      ) {
        event.preventDefault();
        navigateFromInput.current(direction);
      }
    };
    layer.addEventListener("keydown", handleFocusKeys);
    return () => layer.removeEventListener("keydown", handleFocusKeys);
  }, [close, leaveEditTool, mode, props.panel]);
  const resetSelection = () => {
    if (busy === "download") {
      operation.current?.abort();
      operation.current = undefined;
      setBusy(undefined);
    }
    setError("");
    setActiveMark(undefined);
    setComment(undefined);
    setTextMark(undefined);
    stroke.current = undefined;
    resetShapeSelection();
    setOverview(false);
    if (hasWaiting) setMode(undefined);
  };
  const canSwitch = !closing && (busy !== "edit" || preparingEdit);
  const pick = (entry: ImageItem) => {
    if (!canSwitch || (!showWaiting && !overview && entry.id === item.id)) return;
    resetSelection();
    props.onSelect(entry);
  };
  const pickWaiting = () => {
    if (!canSwitch || showWaiting || !hasWaiting) return;
    resetSelection();
    props.onSelectWaiting();
  };
  const navigate = (offset: -1 | 1, moveFocus = false) => {
    if (!canSwitch) return;
    const next = selectedIndex + offset;
    const entry = props.items[next];
    if (entry) pick(entry);
    else if (hasWaiting && next === props.items.length) pickWaiting();
    else return;
    if (moveFocus)
      requestAnimationFrame(() => {
        section.current
          ?.querySelector<HTMLButtonElement>(
            '.za-conversation-image-choices button[aria-pressed="true"]',
          )
          ?.focus({ preventScroll: true });
      });
  };
  navigateFromInput.current = (direction) => {
    if (!overview) navigate(direction, true);
  };
  const startMode = (next: typeof mode) => {
    resetShapeSelection();
    setMode(next);
    setError("");
    if (next === "comment" || next === "erase")
      requestAnimationFrame(() =>
        section.current
          ?.querySelector<HTMLButtonElement>("[data-image-mode-cancel]")
          ?.focus({ preventScroll: true }),
      );
  };
  const download = async () => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy("download");
    setError("");
    try {
      await props.onDownload(item, controller.signal);
    } catch {
      if (!controller.signal.aborted)
        setError(zh ? "暂时无法下载图片。" : "Could not download the image.");
    } finally {
      if (operation.current === controller) {
        operation.current = undefined;
        if (!controller.signal.aborted) setBusy(undefined);
      }
    }
  };
  const submit = async (action?: ImageAction) => {
    if (!props.onEdit) return;
    if (operation.current || hasWaiting || (!action && (!hasInstruction || comment || textMark)))
      return;
    const commentEdit = !action && commenting ? conversationImageCommentEdit(comments) : undefined;
    const marks = action || commentEdit ? [] : regions.marks;
    const keepPreview = commentEdit?.keepPreview ?? Boolean(action || marks.length);
    const text =
      action?.kind === "resize"
        ? zh
          ? `将宽高比设为 ${action.ratio}`
          : `Set the aspect ratio to ${action.ratio}`
        : action?.kind === "background"
          ? zh
            ? "移除图像背景"
            : "Remove the image background"
          : regionKey === "erase"
            ? zh
              ? "移除图像中标记的区域"
              : "Remove the marked area"
            : draft.text.trim() || (zh ? "根据标注修改图像" : "Apply the image annotations");
    const aspectRatio = action?.kind === "resize" ? action.ratio : undefined;
    const controller = new AbortController();
    operation.current = controller;
    setBusy("edit");
    setPreparingEdit(keepPreview);
    setQueued(false);
    if (keepPreview) props.onSelectWaiting();
    setError("");
    try {
      const keepPanel = props.panel && layout?.canSplit === true && !layout.expanded;
      let region: ConversationImageEdit["region"];
      if (marks.length) {
        const request =
          regions.regionRequest?.marks === marks
            ? regions.regionRequest
            : { marks, id: createUuid() };
        if (request !== regions.regionRequest) {
          changeRegions((old) => ({ ...old, regionRequest: request }));
        }
        const source = await sources.read(item.id, controller.signal);
        region = {
          file: await createImageRegionReference(source, marks, controller.signal),
          requestId: request.id,
        };
      }
      const accepted = await props.onEdit(
        item,
        commentEdit ?? {
          text,
          instruction: imageEditInstruction(marks, action?.kind, aspectRatio),
          region,
          aspectRatio,
          keepPreview,
        },
        controller.signal,
        keepPanel,
      );
      if (!accepted) {
        throw new Error("Image edit was not accepted");
      }
      if (controller.signal.aborted) return;
      if (!action) {
        update((old) =>
          commentEdit
            ? { ...old, comments: undefined }
            : regionKey
              ? { ...old, [regionKey]: undefined }
              : { ...old, ...emptyDraft, regionRequest: undefined },
        );
      }
      setMode(undefined);
      if (accepted === true) {
        if (keepPreview) setQueued(true);
        else if (!keepPanel) props.onClose();
      } else {
        props.onTrackRun(accepted, controller);
      }
    } catch {
      if (!controller.signal.aborted)
        setError(
          commentEdit
            ? zh
              ? "暂时无法发送。评论已保留。"
              : "Could not send. Your comments are kept."
            : zh
              ? "暂时无法发送。修改说明和标注已保留。"
              : "Could not send. Your instructions and marks are kept.",
        );
    } finally {
      if (operation.current === controller) {
        operation.current = undefined;
        if (!controller.signal.aborted) {
          setBusy(undefined);
          setPreparingEdit(false);
        }
      }
    }
  };

  const dedicated = commenting || Boolean(regionKey);
  const annotating = Boolean(mode && !dedicated);
  const drawing = Boolean(mode && mode !== "pointer" && !overview && !toolsLocked);
  const selecting = mode === "pointer" && !toolsLocked;
  const selectedMark =
    selecting && selectedShape !== undefined
      ? (shapeDraft ?? regions.marks[selectedShape])
      : undefined;
  const toolWidth =
    mode === "erase" ? eraserWidth : mode === "remove-mark" ? markEraserWidth : penWidth;
  const roundCursor = mode === "mark" || mode === "remove-mark" || mode === "erase";
  const position = (event: { currentTarget: SVGSVGElement; clientX: number; clientY: number }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };
  const showBrushCursor = (event: PointerEvent<SVGSVGElement>, point: ImagePoint) => {
    if (event.pointerType === "touch" || !brushCursor.current) return;
    brushCursor.current.setAttribute("transform", `translate(${point.x * 1000} ${point.y * 1000})`);
    brushCursor.current.style.visibility = "visible";
  };
  const hideBrushCursor = () => {
    if (brushCursor.current) brushCursor.current.style.visibility = "hidden";
  };
  const extendMark = (
    mark: Mark,
    origin: Mark["points"][number],
    point: Mark["points"][number],
  ): Mark => {
    if (shape) return { ...mark, points: imageShapePoints(shape.id, origin, point) };
    const last = mark.points.at(-1);
    if (last?.x === point.x && last.y === point.y) return mark;
    const points =
      mark.points.length >= 300 ? mark.points.filter((_, index) => index % 2 === 0) : mark.points;
    return { ...mark, points: [...points, point] };
  };
  const editShape = (index: number, mark: Mark) =>
    changeMarks((marks) => marks.map((previous, i) => (i === index ? mark : previous)));
  const selectShape = (event: PointerEvent<SVGSVGElement>, point: ImagePoint) => {
    const { width, height } = event.currentTarget.getBoundingClientRect();
    const handle =
      event.target instanceof Element
        ? (event.target.getAttribute("data-image-shape-handle") ?? undefined)
        : undefined;
    const shapes = regions.marks.flatMap((mark, index) =>
      mark.kind && mark.kind !== "pen" && mark.kind !== "text" ? [{ mark, index }] : [],
    );
    const hit = imageMarkAt(
      shapes.map(({ mark }) => mark),
      point,
      { x: 10 / width, y: 10 / height },
    );
    const index = handle ? selectedShape : shapes[hit]?.index;
    if (index === undefined) {
      resetShapeSelection();
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedShape(index);
    shapeGesture.current = {
      index,
      pointer: event.pointerId,
      original: regions.marks[index],
      origin: point,
      handle,
    };
  };
  const resizeShape = (gesture: NonNullable<typeof shapeGesture.current>, point: ImagePoint) =>
    transformImageShape(
      gesture.original,
      point.x - gesture.origin.x,
      point.y - gesture.origin.y,
      gesture.handle,
    );
  const finishShape = (event: PointerEvent<SVGSVGElement>, save: boolean) => {
    const gesture = shapeGesture.current;
    if (gesture?.pointer !== event.pointerId) return false;
    event.stopPropagation();
    shapeGesture.current = undefined;
    setShapeDraft(undefined);
    const point = position(event);
    if (save && (point.x !== gesture.origin.x || point.y !== gesture.origin.y))
      editShape(gesture.index, resizeShape(gesture, point));
    return true;
  };
  const changeWidth = (width: number) => {
    if (mode === "remove-mark") setMarkEraserWidth(width);
    else if (mode === "erase") setEraserWidth(width);
    else if (selectedMark && selectedShape !== undefined) {
      const mark = {
        ...selectedMark,
        width,
        normalizedWidth: selectedMark.normalizedWidth
          ? (selectedMark.normalizedWidth * width) / selectedMark.width
          : undefined,
      };
      if (widthGesture.current) {
        widthGesture.current.mark = mark;
        setShapeDraft(mark);
      } else editShape(selectedShape, mark);
    } else setPenWidth(width);
  };
  const finishWidth = (save: boolean) => {
    const gesture = widthGesture.current;
    widthGesture.current = undefined;
    if (!gesture) return;
    setShapeDraft(undefined);
    if (save && gesture.mark && selectedShape !== undefined) editShape(selectedShape, gesture.mark);
  };
  const endStroke = (event: PointerEvent<SVGSVGElement>, save: boolean) => {
    if (finishShape(event, save)) return;
    const current = stroke.current;
    if (current?.pointer !== event.pointerId) return;
    event.stopPropagation();
    stroke.current = undefined;
    setActiveMark(undefined);
    if (save) {
      const end = position(event);
      if (shape && end.x === current.origin.x && end.y === current.origin.y) return;
      const mark = extendMark(current.mark, current.origin, end);
      if (mode === "remove-mark" && mark.normalizedWidth) {
        const cut = { points: mark.points, normalizedWidth: mark.normalizedWidth };
        const { width, height } = event.currentTarget.getBoundingClientRect();
        changeMarks((marks) => eraseImageMarks(marks, cut, { width, height }));
        return;
      }
      changeMarks((marks) => [...marks, mark]);
      if (shape) {
        setSelectedShape(regions.marks.length);
        setMode("pointer");
      }
    }
  };
  const openNewComment = (point: ImagePoint) => {
    if (!comment && comments.length < 12) setComment({ id: createUuid(), point, text: "" });
  };
  const saveComment = (saved: ImageComment) => {
    update((old) => {
      const entries = old.comments ?? emptyComments;
      return {
        ...old,
        comments: entries.some(({ id }) => id === saved.id)
          ? entries.map((entry) => (entry.id === saved.id ? saved : entry))
          : [...entries, saved],
      };
    });
    setComment(undefined);
  };
  const deleteComment = (id: string) => {
    update((old) => ({ ...old, comments: old.comments?.filter((entry) => entry.id !== id) }));
    setComment(undefined);
  };
  const saveText = () => {
    if (!textMark) return;
    const label = textMark.text.trim();
    if (label) {
      const mark: Mark = {
        points: [textMark.point],
        kind: "text",
        erase: false,
        color: penColor,
        width: penWidth,
        label,
        labelSize: textMark.size,
      };
      changeMarks((marks) =>
        textMark.index === undefined
          ? [...marks, mark]
          : marks.map((old, index) => (index === textMark.index ? mark : old)),
      );
    }
    setTextMark(undefined);
  };
  const focusTextCanvas = (control: HTMLElement) => {
    const canvas = control.closest<HTMLElement>(".za-image-canvas");
    requestAnimationFrame(() => canvas?.focus({ preventScroll: true }));
  };
  const overlay = (style: CSSProperties) => {
    const width = Math.max(1, Number(style.width));
    const height = Math.max(1, Number(style.height));
    const marks = commenting ? [] : [...regions.marks];
    if (shapeDraft && selectedShape !== undefined) marks[selectedShape] = shapeDraft;
    if (activeMark && mode !== "remove-mark") marks.push(activeMark);
    const pendingCut =
      mode === "remove-mark" && activeMark?.normalizedWidth
        ? { points: activeMark.points, normalizedWidth: activeMark.normalizedWidth }
        : undefined;
    return regions.marks.length || drawing || (commenting && comments.length) ? (
      <>
        <svg
          aria-hidden="true"
          className="za-conversation-image-marks"
          data-drawing={drawing ? mode : undefined}
          data-selecting={selecting || undefined}
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          style={style}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            if (selecting) {
              selectShape(event, position(event));
              return;
            }
            if (!drawing) return;
            event.stopPropagation();
            if (commenting) return;
            const point = position(event);
            if (mode === "text") {
              if (textMark) return;
              event.preventDefault();
              const index = imageMarkAt(regions.marks, point, { x: 0.012, y: 0.012 });
              const existing = regions.marks[index];
              if (existing?.kind === "text") {
                setPenColor(existing.color);
                setTextMark({
                  point: existing.points[0],
                  text: existing.label ?? "",
                  size: existing.labelSize ?? 0.032,
                  index,
                });
              } else if (regions.marks.length < 12) {
                setTextMark({
                  point: { x: Math.min(point.x, 0.78), y: Math.min(point.y, 0.92) },
                  text: "",
                  size: 0.032,
                });
              }
              return;
            }
            if (regions.marks.length >= 12 && mode !== "remove-mark") return;
            event.currentTarget.setPointerCapture(event.pointerId);
            showBrushCursor(event, point);
            const mark = {
              points: [point],
              erase: mode === "erase",
              kind: shape?.id ?? ("pen" as const),
              normalizedWidth: toolWidth / Math.min(width, height),
              color: mode === "erase" ? "#72acff" : penColor,
              width: toolWidth,
            };
            stroke.current = { pointer: event.pointerId, mark, origin: point };
            setActiveMark(mark);
          }}
          onPointerMove={(event) => {
            const point = position(event);
            showBrushCursor(event, point);
            const gesture = shapeGesture.current;
            if (gesture?.pointer === event.pointerId) {
              if (event.buttons === 0) finishShape(event, false);
              else setShapeDraft(resizeShape(gesture, point));
              return;
            }
            const current = stroke.current;
            if (current?.pointer !== event.pointerId) return;
            if (event.buttons === 0) {
              endStroke(event, false);
              return;
            }
            event.stopPropagation();
            const mark = extendMark(current.mark, current.origin, point);
            stroke.current = { ...current, mark };
            setActiveMark(mark);
          }}
          onPointerEnter={(event) => showBrushCursor(event, position(event))}
          onPointerLeave={hideBrushCursor}
          onPointerUp={(event) => endStroke(event, true)}
          onClick={(event) => {
            if (commenting && drawing) openNewComment(position(event));
          }}
          onPointerCancel={(event) => {
            hideBrushCursor();
            endStroke(event, false);
          }}
          onLostPointerCapture={(event) => {
            if (event.buttons === 0) endStroke(event, false);
          }}
          onDoubleClick={(event) => {
            if (drawing || selecting) event.stopPropagation();
          }}
        >
          <ConversationImageInk
            marks={marks}
            scale={Math.min(width, height)}
            editingText={textMark?.index}
            erasing={pendingCut}
          />
          {selectedMark && (
            <ConversationImageShapeSelection mark={selectedMark} width={width} height={height} />
          )}
          {drawing && roundCursor && (
            <g ref={brushCursor} className="za-image-brush-cursor" visibility="hidden">
              <ellipse
                rx={(toolWidth * 500) / width}
                ry={(toolWidth * 500) / height}
                fill={mode === "mark" ? penColor : "none"}
                stroke="#141414"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
              <ellipse
                rx={(toolWidth * 500) / width}
                ry={(toolWidth * 500) / height}
                fill="none"
                stroke="#fff"
                strokeWidth="0.8"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )}
        </svg>
        {textMark && (
          <div
            className="za-image-comment-layer za-image-text-layer"
            style={{
              "--za-image-text-layer-width": `${width}px`,
              "--za-image-text-layer-height": `${height}px`,
              "--za-image-text-layer-transform": style.transform,
            } as CSSProperties}
            data-image-gesture-exempt=""
            onPointerDown={(event) => event.stopPropagation()}
          >
            <form
              className="za-image-text-editor"
              style={{
                left: `${textMark.point.x * 100}%`,
                top: `${textMark.point.y * 100}%`,
                "--za-image-text-editor-max-width": `${(1 - textMark.point.x) * 100}%`,
                "--za-image-text-editor-color": penColor,
              } as CSSProperties}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) saveText();
              }}
              onSubmit={(event) => {
                event.preventDefault();
                saveText();
                focusTextCanvas(event.currentTarget);
              }}
            >
              <input
                type="text"
                aria-label={zh ? "图上标注文字" : "Text on image"}
                ref={focusTextMark}
                style={{
                  "--za-image-text-size": `${Math.max(15, textMark.size * height)}px`,
                } as CSSProperties}
                maxLength={40}
                value={textMark.text}
                onChange={(event) => setTextMark({ ...textMark, text: event.currentTarget.value })}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter" || event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === "Enter") saveText();
                    else setTextMark(undefined);
                    focusEditInput();
                  }
                }}
              />
              <div className="za-image-text-actions">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={zh ? "取消文字标注" : "Cancel text annotation"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    setTextMark(undefined);
                    focusTextCanvas(event.currentTarget);
                  }}
                >
                  <X />
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  onMouseDown={(event) => event.preventDefault()}
                  disabled={!textMark.text.trim()}
                >
                  {zh ? "保存" : "Save"}
                </Button>
              </div>
              <span
                className="za-image-text-resize"
                aria-hidden="true"
                onPointerDown={(event) => {
                  event.preventDefault();
                  textResize.current = { x: event.clientX, size: textMark.size };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const start = textResize.current;
                  if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  setTextMark({
                    ...textMark,
                    size: Math.max(
                      0.018,
                      Math.min(
                        0.095,
                        start.size + (event.clientX - start.x) / Math.max(240, Number(style.width)),
                      ),
                    ),
                  });
                }}
                onLostPointerCapture={() => {
                  textResize.current = null;
                }}
              />
            </form>
          </div>
        )}
        {commenting && (
          <ConversationImageComments
            comments={comments}
            editor={comment}
            style={style}
            reader={section}
            disabled={toolsLocked}
            onEditor={setComment}
            onSave={saveComment}
            onDelete={deleteComment}
          />
        )}
      </>
    ) : undefined;
  };
  const showEdit = Boolean(props.onEdit) && (showWaiting || (!dedicated && !overview));
  const editLabel = zh ? "修改说明" : "Edit instructions";
  const editPlaceholder = annotating
    ? zh
      ? "添加说明"
      : "Add instructions"
    : zh
      ? "描述修改内容"
      : "Describe what to change";
  const editSendLabel = zh ? "发送图像修改" : "Send image edit";
  const submitLatest = useRef(submit);
  useLayoutEffect(() => {
    submitLatest.current = submit;
  });
  const sendEdit = useCallback(() => void submitLatest.current(), []);
  useLayoutEffect(() => {
    setComposerEdit?.(
      useSharedComposer && !closing
        ? {
            value: draft.text,
            label: editLabel,
            placeholder: editPlaceholder,
            sendLabel: editSendLabel,
            pending: busy === "edit" || stopping,
            canSend: run ? !stopping : !busy && !textMark && hasInstruction,
            hidden: !showEdit,
            onChange: updateText,
            onSend: run ? props.onStopRun : sendEdit,
            stoppingRun: Boolean(run),
          }
        : null,
    );
  }, [
    setComposerEdit,
    useSharedComposer,
    showEdit,
    closing,
    draft.text,
    editLabel,
    editPlaceholder,
    editSendLabel,
    busy,
    hasInstruction,
    updateText,
    sendEdit,
    run,
    stopping,
    props.onStopRun,
    textMark,
  ]);
  useLayoutEffect(() => () => setComposerEdit?.(null), [setComposerEdit]);
  const title = zh ? "图像预览" : "Image preview";
  const closeLabel = zh ? "关闭图像预览" : "Close image preview";
  const body = (
    <section
      ref={section}
      tabIndex={-1}
      className="za-conversation-image-reader"
      data-panel={props.panel}
      data-mode={mode}
      data-edit-mode={dedicated ? "dedicated" : annotating ? "markup" : undefined}
      aria-label={title}
      onWheel={(event) => {
        if (
          event.defaultPrevented ||
          event.ctrlKey ||
          event.metaKey ||
          overview ||
          drawing ||
          (props.items.length < 2 && !hasWaiting) ||
          !(event.target instanceof Element) ||
          !event.target.closest('.za-image-workspace[data-can-pan="false"]')
        )
          return;
        const now = performance.now();
        if (now - wheel.current.at > 180)
          wheel.current = { at: now, distance: 0, navigated: false };
        const gesture = wheel.current;
        gesture.at = now;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        gesture.distance += delta * (event.deltaMode ? 16 : 1);
        if (gesture.navigated || Math.abs(gesture.distance) < 28) return;
        gesture.navigated = true;
        navigate(gesture.distance < 0 ? -1 : 1);
      }}
      onTouchStart={(event) => {
        if (
          drawing ||
          event.touches.length !== 1 ||
          !(event.target instanceof Element) ||
          !event.target.closest('.za-image-workspace[data-can-pan="false"]')
        ) {
          touchStart.current = undefined;
          return;
        }
        const touch = event.touches[0];
        touchStart.current = { x: touch.clientX, y: touch.clientY };
      }}
      onTouchEnd={(event) => {
        const start = touchStart.current;
        touchStart.current = undefined;
        if (!start || event.touches.length || event.changedTouches.length !== 1) return;
        const touch = event.changedTouches[0];
        const x = start.x - touch.clientX;
        const y = start.y - touch.clientY;
        const delta = Math.abs(x) > Math.abs(y) ? x : y;
        if (Math.abs(delta) >= 42) navigate(delta > 0 ? 1 : -1);
      }}
      onTouchCancel={() => {
        touchStart.current = undefined;
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        const direction = imageNavigationDirection(event.nativeEvent);
        if (
          commenting &&
          !comment &&
          !busy &&
          comments.length < 12 &&
          (event.key === "Enter" || event.key === " ") &&
          event.target instanceof Element &&
          event.target.matches(".za-image-canvas")
        ) {
          event.preventDefault();
          openNewComment({ x: 0.5, y: 0.5 });
        } else if (event.key === "Escape" && mode) {
          event.preventDefault();
          event.stopPropagation();
          leaveEditTool();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (
          !overview &&
          direction &&
          !(
            event.target instanceof Element &&
            event.target.closest(
              "input,textarea,[role=menu],[contenteditable=true],[data-slot=popover-content]",
            )
          )
        ) {
          event.preventDefault();
          navigate(direction, true);
        }
      }}
    >
      {!props.panel && (
        <div ref={fitBounds} className="za-conversation-image-fit-area" aria-hidden="true" />
      )}
      <header className="za-conversation-image-header">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="sm" className="za-conversation-image-name" />}
            aria-label={zh ? `${item.name}的文件操作` : `File actions for ${item.name}`}
          >
            <ImageIcon /> <span>{zh ? "图像" : "Image"}</span>
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-72">
            <DropdownMenuLabel className="truncate" title={item.name}>
              {item.name}
            </DropdownMenuLabel>
            {(item.mime || item.version) && (
              <div className="px-2.5 pb-1.5 text-xs text-muted-foreground">
                {[
                  item.mime,
                  item.version ? (zh ? `版本 ${item.version}` : `Version ${item.version}`) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
            <DropdownMenuItem disabled={toolsLocked || overview} onClick={() => void download()}>
              <Download /> {zh ? "下载原图" : "Download original"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {props.items.length > 1 && !hasWaiting && (
          <Button
            variant="ghost"
            size="icon-sm"
            tooltip={zh ? "所有图像" : "All images"}
            aria-label={zh ? "所有图像" : "All images"}
            aria-pressed={overview}
            onClick={() => setOverview(!overview)}
          >
            <LayoutGrid />
          </Button>
        )}
        <div ref={setZoomTarget} className="za-conversation-image-zoom" />
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={zh ? "下载原图" : "Download original"}
          aria-label={zh ? "下载原图" : "Download original"}
          disabled={!!busy || showWaiting || overview}
          onClick={() => void download()}
        >
          <Download />
        </Button>
        {layout?.canSplit &&
          (props.panel ? (
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={
                layout.expanded
                  ? zh
                    ? "恢复并排"
                    : "Restore side panel"
                  : zh
                    ? "展开预览"
                    : "Expand preview"
              }
              aria-label={
                layout.expanded
                  ? zh
                    ? "恢复并排"
                    : "Restore side panel"
                  : zh
                    ? "展开预览"
                    : "Expand preview"
              }
              onClick={layout.expanded ? layout.toggleExpanded : props.onPreview}
              disabled={toolsLocked || Boolean(mode)}
            >
              {layout.expanded ? <Minimize2 /> : <Maximize2 />}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="za-conversation-image-panel-button"
              tooltip={zh ? "在侧面板中打开" : "Open in side panel"}
              aria-label={zh ? "在侧面板中打开" : "Open in side panel"}
              disabled={toolsLocked || Boolean(mode)}
              onClick={props.onPanel}
            >
              <PanelRightOpen />
              <span>{zh ? "在侧面板中打开" : "Open in side panel"}</span>
            </Button>
          ))}
        <Button
          data-cloud-reader-return=""
          variant="ghost"
          size="icon-sm"
          tooltip={closeLabel}
          aria-label={closeLabel}
          disabled={busy === "edit"}
          onClick={(event) => close(event.detail === 0)}
        >
          <X />
        </Button>
        {!props.panel && <div ref={windowChrome} className="za-image-window-controls" />}
      </header>
      {(props.items.length > 1 || hasWaiting) && !overview && (
        <nav className="za-conversation-image-rail" aria-label={zh ? "切换图像" : "Switch images"}>
          <div className="za-conversation-image-choices">
            {props.items.map((entry) => (
              <ImageChoice
                key={entry.id}
                item={entry}
                active={!showWaiting && entry.id === item.id}
                disabled={!canSwitch}
                sources={sources}
                pick={() => pick(entry)}
              />
            ))}
            {hasWaiting && (
              <button
                ref={waitThumb}
                type="button"
                className="za-image-wait-thumb"
                aria-label={waitLabel}
                aria-pressed={showWaiting}
                disabled={!canSwitch}
                onClick={pickWaiting}
              />
            )}
          </div>
        </nav>
      )}
      {showWaiting ? (
        <div className="za-image-wait-stage">
          <VisualCreationPending label={waitLabel} />
        </div>
      ) : overview ? (
        <div className="za-conversation-image-grid">
          {props.items.map((entry) => (
            <ImageChoice
              key={entry.id}
              item={entry}
              active={entry.id === item.id}
              sources={sources}
              pick={() => pick(entry)}
            />
          ))}
        </div>
      ) : props.panel || focusArea ? (
        <PreviewToolbarMount.Provider value={{ target: zoomTarget }}>
          <ImageCanvas
            key={item.id}
            focusArea={props.panel ? undefined : focusArea}
            item={item}
            sources={sources}
            overlay={overlay}
            interactiveOverlay={mode === "comment" || mode === "text"}
            onNavigate={
              drawing || (props.items.length < 2 && !hasWaiting)
                ? undefined
                : (offset) => navigate(offset, true)
            }
            onDownload={() => void download()}
          />
        </PreviewToolbarMount.Provider>
      ) : null}
      <div className="za-conversation-image-controls">
        {!overview && props.onEdit && (
          <div className="za-conversation-image-bottom">
            <PreviewDock
              label={zh ? "图像编辑工具" : "Image editing tools"}
              className={`za-conversation-image-dock${annotating ? " za-conversation-image-annotation-dock" : dedicated ? " za-image-mode-dock" : ""}`}
              draggable={!props.panel}
            >
              {dedicated ? (
                <>
                  {mode === "erase" && (regions.undo.length > 0 || regions.redo.length > 0) ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        tooltip={zh ? "撤销" : "Undo"}
                        aria-label={zh ? "撤销擦除选区" : "Undo erase selection"}
                        disabled={!regions.undo.length || !!busy}
                        onClick={undoMark}
                      >
                        <Undo2 />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        tooltip={zh ? "重做" : "Redo"}
                        aria-label={zh ? "重做擦除选区" : "Redo erase selection"}
                        disabled={!regions.redo.length || !!busy}
                        onClick={redoMark}
                      >
                        <Redo2 />
                      </Button>
                    </>
                  ) : (
                    <span role="status" className="za-image-mode-hint">
                      {mode === "erase"
                        ? zh
                          ? "在要移除的内容上涂抹"
                          : "Brush over what to remove"
                        : comments.length
                          ? zh
                            ? `${comments.length} 条评论`
                            : `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`
                          : zh
                            ? "点击图像以添加评论"
                            : "Click the image to add a comment"}
                    </span>
                  )}
                  <Button
                    data-image-mode-send=""
                    variant="ghost"
                    size="sm"
                    className="za-image-mode-send"
                    aria-busy={busy === "edit"}
                    disabled={!hasInstruction || !!comment || !!busy}
                    onClick={() => void submit()}
                  >
                    {busy === "edit" && <LoaderCircle className="motion-safe:animate-spin" />}
                    {zh ? "发送" : "Send"}
                  </Button>
                  <Button
                    data-image-mode-cancel=""
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy === "edit"}
                    aria-label={zh ? "取消" : "Cancel"}
                    tooltip={zh ? "取消" : "Cancel"}
                    onClick={leaveEditTool}
                  >
                    <X />
                  </Button>
                </>
              ) : annotating ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={zh ? "选择形状或移动画布" : "Select shape or pan image"}
                    tooltip={zh ? "选择形状或移动画布" : "Select shape or pan image"}
                    aria-pressed={mode === "pointer"}
                    onClick={() => startMode("pointer")}
                  >
                    <SquareMousePointer />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={zh ? "画笔" : "Pen"}
                    tooltip={zh ? "画笔" : "Pen"}
                    aria-pressed={mode === "mark"}
                    onClick={() => startMode("mark")}
                  >
                    <SquarePen />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={zh ? "文字标注" : "Text annotation"}
                    tooltip={zh ? "文字标注" : "Text annotation"}
                    aria-pressed={mode === "text"}
                    onClick={() => startMode("text")}
                  >
                    <Type />
                  </Button>
                  <Popover>
                    <PopoverTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                      aria-label={zh ? "形状" : "Shapes"}
                      aria-pressed={Boolean(shape)}
                    >
                      <ShapeIcon />
                    </PopoverTrigger>
                    <PopoverContent
                      side="top"
                      align="center"
                      aria-label={zh ? "形状" : "Shapes"}
                      className="za-image-tool-popover za-image-shapes"
                    >
                      {imageShapes.map(({ id, zh: name, en, Icon }) => (
                        <PopoverClose
                          key={id}
                          render={<Button variant="ghost" size="icon-sm" />}
                          aria-label={zh ? name : en}
                          title={zh ? name : en}
                          aria-pressed={shape?.id === id}
                          onClick={() => startMode(id)}
                        >
                          <Icon />
                        </PopoverClose>
                      ))}
                    </PopoverContent>
                  </Popover>
                  <Popover>
                    <PopoverTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                      aria-label={zh ? "墨迹颜色" : "Ink color"}
                    >
                      <span className="za-image-ink-swatch" style={{ backgroundColor: penColor }} />
                    </PopoverTrigger>
                    <PopoverContent
                      side="top"
                      align="center"
                      aria-label={zh ? "墨迹颜色" : "Ink color"}
                      className="za-image-tool-popover za-image-ink-menu"
                    >
                      <label
                        className="za-image-custom-ink"
                        title={zh ? "选择自定义颜色" : "Choose custom color"}
                      >
                        <input
                          type="color"
                          value={penColor}
                          aria-label={zh ? "选择自定义颜色" : "Choose custom color"}
                          onChange={(event) => setPenColor(event.currentTarget.value)}
                        />
                      </label>
                      {inkColors.map(([color, name, en]) => (
                        <PopoverClose
                          key={color}
                          render={<Button variant="ghost" size="icon-sm" />}
                          aria-label={zh ? `使用${name}` : `Use ${en}`}
                          title={zh ? name : en}
                          aria-pressed={color === penColor}
                          onClick={() => setPenColor(color)}
                        >
                          <span
                            className="za-image-ink-swatch"
                            style={{ backgroundColor: color }}
                          />
                        </PopoverClose>
                      ))}
                    </PopoverContent>
                  </Popover>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={zh ? "擦掉标注" : "Erase annotation"}
                    tooltip={zh ? "擦掉标注" : "Erase annotation"}
                    aria-pressed={mode === "remove-mark"}
                    onClick={() => startMode("remove-mark")}
                  >
                    <Eraser />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    tooltip={zh ? "撤销标记" : "Undo mark"}
                    aria-label={zh ? "撤销标记" : "Undo mark"}
                    disabled={!draft.undo.length || busy === "edit"}
                    onClick={undoMark}
                  >
                    <Undo2 />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    tooltip={zh ? "重做标记" : "Redo mark"}
                    aria-label={zh ? "重做标记" : "Redo mark"}
                    disabled={!draft.redo.length || busy === "edit"}
                    onClick={redoMark}
                  >
                    <Redo2 />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={zh ? "退出标注" : "Exit markup"}
                    tooltip={zh ? "退出标注" : "Exit markup"}
                    disabled={busy === "edit"}
                    onClick={leaveEditTool}
                  >
                    <X />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={toolsLocked}
                    onClick={() => startMode("mark")}
                  >
                    <SquarePen />
                    {zh ? "标注" : "Mark up"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={toolsLocked}
                    onClick={() => startMode("comment")}
                  >
                    <MessageSquare />
                    {zh ? "添加评论" : "Add comment"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={toolsLocked}
                    onClick={() => void submit({ kind: "background" })}
                  >
                    <Scissors />
                    {zh ? "移除背景" : "Remove background"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={toolsLocked}
                    onClick={() => startMode("erase")}
                  >
                    <BrushCleaning />
                    {zh ? "擦除" : "Erase"}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={toolsLocked}
                      render={<Button variant="ghost" size="sm" />}
                    >
                      <Maximize2 />
                      {zh ? "调整大小" : "Resize"}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="top" className="za-image-ratio-menu">
                      {conversationImageRatios.map(({ ratio, zh: labelZh, en }) => (
                        <DropdownMenuItem
                          key={ratio}
                          onClick={() => void submit({ kind: "resize", ratio })}
                        >
                          <span
                            className="za-image-ratio-icon"
                            data-ratio={ratio}
                            aria-hidden="true"
                          />
                          <span>{zh ? labelZh : en}</span>
                          <small>{ratio}</small>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </PreviewDock>
            {(roundCursor || selecting || shape) && (
              <div className="za-image-width-control">
                <input
                  className="za-image-pen-width"
                  type="range"
                  min={mode === "erase" || mode === "remove-mark" ? 8 : 2}
                  max={mode === "erase" ? 160 : mode === "remove-mark" ? 72 : 26}
                  value={selectedMark?.width ?? toolWidth}
                  disabled={toolsLocked}
                  aria-label={
                    selectedMark
                      ? zh
                        ? "形状描边粗细"
                        : "Shape stroke width"
                      : mode === "erase" || mode === "remove-mark"
                        ? zh
                          ? "橡皮擦粗细"
                          : "Eraser width"
                        : zh
                          ? "画笔粗细"
                          : "Pen width"
                  }
                  onPointerDown={() => {
                    if (selectedMark) widthGesture.current = {};
                  }}
                  onPointerUp={() => finishWidth(true)}
                  onPointerCancel={() => finishWidth(false)}
                  onLostPointerCapture={() => finishWidth(true)}
                  onBlur={() => finishWidth(true)}
                  onChange={(event) => changeWidth(event.currentTarget.valueAsNumber)}
                />
              </div>
            )}
            {showEdit && (
              <div
                className={
                  useSharedComposer ? "za-image-edit-context" : "za-conversation-image-draft"
                }
              >
                {((props.panel && (annotating || draft.marks.length > 0)) ||
                  mode === "remove-mark" ||
                  draft.marks.length >= 12) && (
                  <div className="za-conversation-image-mark-tools">
                    <span>
                      {draft.marks.length >= 12
                        ? zh
                          ? "已达到 12 处标记"
                          : "12-region limit reached"
                        : mode === "remove-mark"
                          ? zh
                            ? "在标注上涂抹以擦除"
                            : "Brush over annotations to erase them"
                          : mode === "text"
                            ? zh
                              ? "点按图像以放置文字"
                              : "Tap the image to place the label"
                            : drawing
                              ? zh
                                ? "在图上标出要修改的区域"
                                : "Mark the area you want to change"
                              : zh
                                ? `${draft.marks.length} 处标记`
                                : `${draft.marks.length} marked regions`}
                    </span>
                  </div>
                )}
                {!useSharedComposer && run && (
                  <Button type="button" disabled={stopping} onClick={props.onStopRun}>
                    <Square />
                    {zh ? "停止" : "Stop"}
                  </Button>
                )}
                {!useSharedComposer && !hasWaiting && (
                  <form
                    className="za-conversation-image-draft-row"
                    aria-busy={busy === "edit"}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submit();
                    }}
                  >
                    <textarea
                      ref={input}
                      rows={1}
                      maxLength={2000}
                      value={draft.text}
                      disabled={busy === "edit"}
                      aria-label={editLabel}
                      placeholder={editPlaceholder}
                      onChange={(event) => update((old) => ({ ...old, text: event.target.value }))}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                    />
                    <Button
                      size="icon-sm"
                      type="submit"
                      aria-label={zh ? "发送图像修改" : "Send image edit"}
                      tooltip={zh ? "发送图像修改" : "Send image edit"}
                      disabled={!!busy || !hasInstruction}
                    >
                      {busy === "edit" ? (
                        <LoaderCircle className="motion-safe:animate-spin" />
                      ) : (
                        <ArrowUp />
                      )}
                    </Button>
                  </form>
                )}
              </div>
            )}
            {(error || run?.stopFailed) && (
              <p className="za-conversation-image-error" role="status">
                {error ||
                  (zh
                    ? "停止结果尚未确认，可在对话中核对。"
                    : "Stop is unconfirmed. Check the conversation for the current status.")}
              </p>
            )}
            {queued && (
              <span className="za-image-edit-context" role="status">
                {zh
                  ? "修改已排队，可在对话中查看进度。"
                  : "Image edit queued. Follow its progress in the conversation."}
              </span>
            )}
            {busy === "edit" && !mode && !showWaiting && (
              <span className="za-image-edit-context" role="status">
                {zh ? "正在提交修改…" : "Submitting the edit…"}
              </span>
            )}
          </div>
        )}
        {!props.panel && (
          <div
            className="za-image-focus-composer"
            hidden={!showEdit}
            ref={closing ? undefined : setComposerTarget}
          />
        )}
      </div>
    </section>
  );
  const confirmation = (
    <AlertDialog
      open={Boolean(discard)}
      onOpenChange={(open) => {
        if (!open) setDiscard(undefined);
      }}
    >
      <AlertDialogContent
        className="za-image-discard-dialog"
        backdrop="image-edit"
      >
        <AlertDialogTitle>{zh ? "放弃更改？" : "Discard changes?"}</AlertDialogTitle>
        <AlertDialogDescription>
          {zh ? "你的更改不会被保存" : "Your changes won’t be saved."}
        </AlertDialogDescription>
        <div className="za-image-discard-actions">
          <AlertDialogClose render={<Button />}>
            {zh ? "继续编辑" : "Continue editing"}
          </AlertDialogClose>
          <Button
            variant="ghost"
            className="za-image-discard-button"
            onClick={() => {
              if (!discard) return;
              const { tool, restoreFocus } = discard;
              setDiscard(undefined);
              clearEditTool();
              if (tool) focusEditInput();
              else closePreview(restoreFocus);
            }}
          >
            {zh ? "放弃更改" : "Discard changes"}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
  if (props.panel)
    return (
      <>
        {body}
        {confirmation}
      </>
    );
  const focus = (
    <div
      ref={focusLayer}
      className="za-conversation-image-focus"
      data-closing={closing || undefined}
    >
      <div
        className="za-conversation-image-scrim"
        aria-hidden="true"
        onClick={() => close(false)}
      />
      {body}
      {confirmation}
    </div>
  );
  return typeof document === "undefined" ? null : createPortal(focus, document.body);
}

function ImageCanvas({
  item,
  focusArea,
  sources,
  overlay,
  interactiveOverlay,
  onDownload,
  onNavigate,
}: {
  item: ImageItem;
  focusArea?: { width: number; height: number; offsetY: number };
  sources: ConversationImageSources;
  overlay: (style: CSSProperties) => React.ReactNode;
  interactiveOverlay: boolean;
  onDownload: () => void;
  onNavigate?: (offset: -1 | 1) => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [decodeFailed, setDecodeFailed] = useState(false);
  const { source, failed, retry } = useConversationImageSource(sources, item.id, "original");
  if (failed || decodeFailed)
    return (
      <div className="za-conversation-image-feedback">
        <PreviewUnavailable
          message={zh ? "图片暂未载入" : "Could not load the image"}
          onDownload={onDownload}
          onRetry={() => {
            setDecodeFailed(false);
            retry();
          }}
        />
      </div>
    );
  if (!source)
    return (
      <div className="za-conversation-image-feedback">
        <PreviewLoading message={zh ? "正在载入图片…" : "Loading image…"} />
      </div>
    );
  return (
    <ResourceImagePreview
      name={item.name}
      dimensions={{ width: 1, height: 1 }}
      decodedDimensions={source.dimensions}
      url={source.url}
      assertCurrent={source.assertCurrent}
      onError={() => setDecodeFailed(true)}
      conversation={{ overlay, onNavigate, focusArea, interactiveOverlay }}
    />
  );
}

function ImageChoice({
  item,
  sources,
  active,
  disabled,
  pick,
}: {
  item: ImageItem;
  sources: ConversationImageSources;
  active: boolean;
  disabled?: boolean;
  pick: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const { source } = useConversationImageSource(
    sources,
    item.id,
    sources.thumbnail,
    active || visible,
  );
  useEffect(() => {
    if (active && ref.current?.closest(".za-conversation-image-choices"))
      ref.current.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={item.name}
      title={item.name}
      aria-pressed={active}
      disabled={disabled}
      onClick={pick}
    >
      {(active || visible) && source ? (
        <img src={source.url} alt="" draggable={false} />
      ) : (
        <ImageIcon aria-hidden="true" />
      )}
    </button>
  );
}
