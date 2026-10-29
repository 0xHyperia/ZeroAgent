import { type CSSProperties, type Ref, useRef, useState } from "react";

const adjustmentKeys = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];

/** Continuous pointer position; discrete reasoning values are previewed and committed separately. */
export function ReasoningSlider(props: {
  value: number;
  max: number;
  label: string;
  valueText: string;
  describedBy?: string;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onPreview: (index: number) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const [position, setPosition] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hoveredTick, setHoveredTick] = useState<number | null>(null);
  const [thumbHovered, setThumbHovered] = useState(false);
  const pointerDown = useRef(false);
  const latest = useRef(props.value);
  const raw = position ?? props.value;
  const ratio = raw / Math.max(1, props.max);

  function preview(next: number) {
    const bounded = Math.max(0, Math.min(props.max, next));
    latest.current = Math.round(bounded);
    setPosition(bounded);
    props.onPreview(latest.current);
  }
  function finish(cancel = false) {
    pointerDown.current = false;
    setDragging(false);
    setPosition(null);
    if (cancel) props.onCancel();
    else props.onCommit();
  }

  return (
    <div
      className="composer-reasoning-slider"
      data-dragging={dragging || undefined}
      data-thumb-hovered={thumbHovered || undefined}
      style={
        {
          "--reasoning-progress": `${ratio * 100}%`,
          "--reasoning-thumb-offset": `${13 - 26 * ratio}px`,
        } as CSSProperties
      }
    >
      <div className="composer-reasoning-track" aria-hidden="true">
        <span className="composer-reasoning-fill" />
        <span className="composer-reasoning-ticks">
          {Array.from({ length: props.max + 1 }, (_, tick) => tick).map((tick) => (
            <i
              key={tick}
              data-filled={tick <= props.value || undefined}
              data-hovered={tick === hoveredTick || undefined}
            />
          ))}
        </span>
      </div>
      <div className="composer-reasoning-thumb-rail" aria-hidden="true">
        <div className="composer-reasoning-thumb-motion">
          <span className="composer-reasoning-thumb" />
        </div>
      </div>
      <input
        ref={props.inputRef}
        type="range"
        min={0}
        max={props.max}
        step="any"
        value={raw}
        aria-label={props.label}
        aria-valuenow={props.value}
        aria-valuetext={props.valueText}
        aria-describedby={props.describedBy}
        disabled={props.disabled}
        onChange={(event) => preview(Number(event.currentTarget.value))}
        onPointerDown={(event) => {
          if (props.disabled || event.button !== 0) return;
          pointerDown.current = true;
          latest.current = props.value;
          setDragging(true);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (props.disabled || event.pointerType === "touch") return;
          const rect = event.currentTarget.getBoundingClientRect();
          const width = Math.max(1, rect.width - 26);
          const x = event.clientX - rect.left - 13;
          const nearest = Math.max(0, Math.min(props.max, Math.round((x / width) * props.max)));
          const onRail = Math.abs(event.clientY - (rect.top + rect.height / 2)) <= 9;
          setHoveredTick(
            onRail && Math.abs(x - (nearest / Math.max(1, props.max)) * width) <= 9
              ? nearest
              : null,
          );
          setThumbHovered(
            Math.abs(x - ratio * width) <= 15 &&
              Math.abs(event.clientY - (rect.top + rect.height / 2)) <= 15,
          );
        }}
        onPointerLeave={() => {
          setHoveredTick(null);
          setThumbHovered(false);
        }}
        onPointerUp={() => finish()}
        onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => {
          if (pointerDown.current) finish(true);
        }}
        onBlur={() => finish()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            finish(true);
            return;
          }
          if (!adjustmentKeys.includes(event.key)) return;
          event.preventDefault();
          const current = position === null ? props.value : latest.current;
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? props.max
                : current + (["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key) ? -1 : 1);
          preview(next);
        }}
        onKeyUp={(event) => {
          if (adjustmentKeys.includes(event.key)) finish();
        }}
      />
    </div>
  );
}
