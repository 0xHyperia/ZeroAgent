import { useId } from "react";
import {
  type ImageMark,
  type ImageMarkCut,
  type ImagePoint,
  imageMarkBounds,
} from "./conversationImageAnnotation";

function imageInkWidth(mark: ImageMark, scale: number) {
  return mark.normalizedWidth ? mark.normalizedWidth * scale : mark.width;
}

const inkPath = (points: ImagePoint[]) =>
  points.length === 1
    ? `M${points[0].x * 1000},${points[0].y * 1000}h0.001`
    : points.map(({ x, y }, index) => `${index ? "L" : "M"}${x * 1000},${y * 1000}`).join(" ");

export function ConversationImageInk({
  marks,
  scale,
  erasing,
  editingText,
}: {
  marks: readonly ImageMark[];
  scale: number;
  erasing?: ImageMarkCut;
  editingText?: number;
}) {
  const prefix = useId();
  const path = (cut: ImageMarkCut) => (
    <path
      d={inkPath(cut.points)}
      stroke="#000"
      strokeWidth={cut.normalizedWidth * scale}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
      fill="none"
    />
  );
  return (
    <>
      {marks.map((mark, index) => {
        if (index === editingText) return null;
        const cuts = erasing ? [...(mark.cuts ?? []), erasing] : mark.cuts;
        const mask = `${prefix}-${index}`;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: this SVG renders ordered ink, with no per-mark React state.
          <g key={index} mask={cuts?.length ? `url(#${mask})` : undefined}>
            {cuts?.length ? (
              <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000">
                <rect width="1000" height="1000" fill="#fff" />
                {cuts.map((cut, position) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cut paths are ordered geometry.
                  <g key={position}>{path(cut)}</g>
                ))}
              </mask>
            ) : null}
            {mark.label ? (
              <text
                x={mark.points[0].x * 1000}
                y={(mark.points[0].y + (mark.labelSize ?? 0.032) * 0.87) * 1000}
                textLength={(imageMarkBounds(mark).right - mark.points[0].x) * 1000}
                lengthAdjust="spacingAndGlyphs"
                fill={mark.color}
                fontWeight={600}
                fontSize={(mark.labelSize ?? 0.032) * 1000}
              >
                {mark.label}
              </text>
            ) : (
              <path
                className="za-image-ink"
                d={inkPath(mark.points)}
                stroke={mark.color}
                strokeWidth={imageInkWidth(mark, scale)}
                data-erase={mark.erase || undefined}
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            )}
          </g>
        );
      })}
    </>
  );
}

const handles = [
  ["nw", 0, 0],
  ["n", 0.5, 0],
  ["ne", 1, 0],
  ["e", 1, 0.5],
  ["se", 1, 1],
  ["s", 0.5, 1],
  ["sw", 0, 1],
  ["w", 0, 0.5],
] as const;

export function ConversationImageShapeSelection({
  mark,
  width,
  height,
}: {
  mark: ImageMark;
  width: number;
  height: number;
}) {
  const { left, top, right, bottom } = imageMarkBounds(mark);
  const w = 7000 / width;
  const h = 7000 / height;
  return (
    <g className="za-image-shape-selection">
      <rect
        x={left * 1000}
        y={top * 1000}
        width={(right - left) * 1000}
        height={(bottom - top) * 1000}
        vectorEffect="non-scaling-stroke"
      />
      {handles
        .filter(([, x, y]) => (left !== right || x === 0.5) && (top !== bottom || y === 0.5))
        .map(([handle, x, y]) => (
          <rect
            key={handle}
            data-image-shape-handle={handle}
            x={(left + x * (right - left)) * 1000 - w / 2}
            y={(top + y * (bottom - top)) * 1000 - h / 2}
            width={w}
            height={h}
            vectorEffect="non-scaling-stroke"
          />
        ))}
    </g>
  );
}
