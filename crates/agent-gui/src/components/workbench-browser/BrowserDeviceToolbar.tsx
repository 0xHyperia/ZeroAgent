import { X } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useId, useRef, useState } from "react";
import Rotate from "~icons/lucide/rotate-cw";
import {
  clampDeviceDimension,
  DEVICE_PRESETS,
  type DeviceViewport,
  rotateDeviceViewport,
} from "./browserDeviceViewport";

const text = {
  en: {
    toolbar: "Device toolbar",
    dimensions: "Dimensions:",
    responsive: "Responsive",
    width: "Viewport width",
    height: "Viewport height",
    rotate: "Rotate viewport",
    zoom: "Browser zoom",
    exit: "Exit device toolbar mode",
    resize: "Resize device viewport",
  },
  zh: {
    toolbar: "设备工具栏",
    dimensions: "尺寸：",
    responsive: "响应式",
    width: "视口宽度",
    height: "视口高度",
    rotate: "旋转视口",
    zoom: "浏览器缩放",
    exit: "退出设备工具栏模式",
    resize: "调整设备视口大小",
  },
};

function DimensionInput({
  axis,
  value,
  label,
  onCommit,
}: {
  axis: "width" | "height";
  value: number;
  label: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const min = axis === "width" ? 240 : 160;
  return (
    <input
      type="number"
      min={min}
      max={4096}
      aria-label={label}
      value={draft ?? value}
      onFocus={(event) => {
        setDraft(String(value));
        event.currentTarget.select();
      }}
      onChange={(event) => {
        const next = event.currentTarget.valueAsNumber;
        setDraft(event.currentTarget.value);
        if (next >= min && next <= 4096) onCommit(clampDeviceDimension(axis, next));
      }}
      onBlur={(event) => {
        const next = event.currentTarget.valueAsNumber;
        if (Number.isFinite(next)) onCommit(clampDeviceDimension(axis, next));
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function BrowserDeviceToolbar({
  viewport,
  zoom,
  onChange,
  onZoom,
  onClose,
}: {
  viewport: DeviceViewport;
  zoom: number;
  onChange: (viewport: DeviceViewport) => void;
  onZoom: (zoom: number) => void;
  onClose: () => void;
}) {
  const { locale } = useLocale();
  const l = text[locale.startsWith("zh") ? "zh" : "en"];
  const presetId = useId();
  const [rotation, setRotation] = useState(0);
  const zoomPercent = Math.round(zoom * 100);
  const zoomSteps = Array.from(new Set([50, 75, 100, 125, 150, 200, zoomPercent])).sort(
    (a, b) => a - b,
  );
  function changeDimension(axis: "width" | "height", value: number) {
    if (value !== viewport[axis]) onChange({ ...viewport, preset: "responsive", [axis]: value });
  }
  return (
    <div className="za-workspace-browser-device-toolbar" role="toolbar" aria-label={l.toolbar}>
      <label htmlFor={presetId}>{l.dimensions}</label>
      <select
        id={presetId}
        value={viewport.preset}
        onChange={(event) => {
          const preset = DEVICE_PRESETS.find((item) => item.id === event.currentTarget.value);
          if (!preset) return;
          onChange(
            preset.id === "responsive"
              ? { ...viewport, preset: preset.id }
              : { preset: preset.id, width: preset.width, height: preset.height },
          );
          if (zoom !== 1) onZoom(1);
          event.currentTarget.blur();
        }}
      >
        {DEVICE_PRESETS.map(({ id, label }) => (
          <option key={id} value={id}>
            {id === "responsive" ? l.responsive : label}
          </option>
        ))}
      </select>
      <div className="za-workspace-browser-device-dimensions">
        <DimensionInput
          axis="width"
          value={viewport.width}
          label={l.width}
          onCommit={(value) => changeDimension("width", value)}
        />
        <span aria-hidden="true">×</span>
        <DimensionInput
          axis="height"
          value={viewport.height}
          label={l.height}
          onCommit={(value) => changeDimension("height", value)}
        />
      </div>
      <button
        type="button"
        aria-label={l.rotate}
        title={l.rotate}
        onClick={(event) => {
          setRotation((value) => value + 1);
          onChange(rotateDeviceViewport(viewport));
          event.currentTarget.blur();
        }}
      >
        <Rotate key={rotation} className={rotation > 0 ? "is-rotating" : undefined} />
      </button>
      <select
        className="za-workspace-browser-device-zoom"
        aria-label={l.zoom}
        value={zoomPercent}
        onChange={(event) => {
          onZoom(Number(event.currentTarget.value) / 100);
          event.currentTarget.blur();
        }}
      >
        {zoomSteps.map((value) => (
          <option key={value} value={value}>
            {value}%
          </option>
        ))}
      </select>
      <button
        className="za-workspace-browser-device-exit"
        type="button"
        aria-label={l.exit}
        title={l.exit}
        onClick={onClose}
      >
        <X />
      </button>
    </div>
  );
}

const resizeEdges = ["left", "right", "bottom", "bottom-left", "bottom-right"] as const;
type ResizeEdge = (typeof resizeEdges)[number];

export function BrowserDeviceResizeHandles({
  viewport,
  scale,
  stage,
  onChange,
}: {
  viewport: DeviceViewport;
  scale: number;
  stage: { width: number; height: number };
  onChange: (viewport: DeviceViewport) => void;
}) {
  const { locale } = useLocale();
  const l = text[locale.startsWith("zh") ? "zh" : "en"];
  const drag = useRef<{
    edge: ResizeEdge;
    x: number;
    y: number;
    viewport: DeviceViewport;
    scale: number;
  } | null>(null);
  const queuedPoint = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);
  useEffect(() => () => window.cancelAnimationFrame(frame.current), []);
  function resize(point: { x: number; y: number }) {
    const start = drag.current;
    if (!start) return;
    const factor = Math.max(0.01, start.scale);
    const left = start.edge.endsWith("left");
    const width = start.viewport.width + ((point.x - start.x) * (left ? -2 : 2)) / factor;
    const height = start.viewport.height + (point.y - start.y) / factor;
    onChange({
      preset: "responsive",
      width:
        start.edge === "bottom"
          ? start.viewport.width
          : clampDeviceDimension(
              "width",
              Math.min(width, Math.max(start.viewport.width, (stage.width - 40) / factor)),
            ),
      height: start.edge.startsWith("bottom")
        ? clampDeviceDimension(
            "height",
            Math.min(height, Math.max(start.viewport.height, (stage.height - 20) / factor)),
          )
        : start.viewport.height,
    });
  }
  return resizeEdges.map((edge) => (
    <button
      key={edge}
      type="button"
      aria-label={`${l.resize} (${edge})`}
      className={`za-workspace-browser-device-resize is-${edge}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { edge, x: event.clientX, y: event.clientY, viewport, scale };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        queuedPoint.current = { x: event.clientX, y: event.clientY };
        if (!frame.current) {
          frame.current = window.requestAnimationFrame(() => {
            frame.current = 0;
            if (queuedPoint.current) resize(queuedPoint.current);
          });
        }
      }}
      onPointerUp={(event) => {
        resize({ x: event.clientX, y: event.clientY });
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        queuedPoint.current = null;
        window.cancelAnimationFrame(frame.current);
        frame.current = 0;
      }}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const axis = event.key === "ArrowLeft" || event.key === "ArrowRight" ? "width" : "height";
        if (
          (edge === "bottom" && axis === "width") ||
          (!edge.startsWith("bottom") && axis === "height")
        )
          return;
        const delta =
          (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) *
          (event.shiftKey ? 10 : 1);
        onChange({ ...viewport, [axis]: clampDeviceDimension(axis, viewport[axis] + delta) });
      }}
    />
  ));
}
