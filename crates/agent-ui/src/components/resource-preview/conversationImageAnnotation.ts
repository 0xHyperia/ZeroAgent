export type ImagePoint = { x: number; y: number };
export type ImageMarkCut = { points: ImagePoint[]; normalizedWidth: number };
export type ImageComment = { id: string; point: ImagePoint; text: string };
export type ImageShape =
  | "line"
  | "arrow"
  | "box"
  | "ellipse"
  | "triangle"
  | "diamond"
  | "star"
  | "heart";

export type ImageMark = {
  points: ImagePoint[];
  erase: boolean;
  color: string;
  width: number;
  label?: string;
  labelSize?: number;
  kind?: "pen" | ImageShape | "text";
  normalizedWidth?: number;
  cuts?: ImageMarkCut[];
};

export type ConversationImageEdit = {
  text: string;
  instruction: string;
  aspectRatio?: string;
  keepPreview?: boolean;
  region?: { file: File; requestId: string };
};

export type ConversationImageEditReceipt = {
  result: Promise<AssistantDeliverable | undefined>;
  stop: () => boolean | Promise<boolean>;
};

export const conversationImageRatios = [
  { ratio: "1:1", zh: "正方形", en: "Square" },
  { ratio: "3:4", zh: "竖向", en: "Portrait" },
  { ratio: "9:16", zh: "故事版式", en: "Story" },
  { ratio: "4:3", zh: "横向", en: "Landscape" },
  { ratio: "16:9", zh: "宽屏", en: "Widescreen" },
] as const;

export function conversationImageCommentEdit(
  comments: readonly ImageComment[],
): ConversationImageEdit {
  return {
    text: comments
      .map(({ text }, index) => `${index + 1}. ${text.replaceAll("\n", "\n    ")}`)
      .join("\n"),
    instruction: [
      "Apply all numbered comments to the selected original in one edit. Return one new full image. Keep the original canvas, composition and transparency, and preserve everything outside the requested changes.",
      "Each point is (x, y) as percentages of the original image width and height, measured rightward and downward from its top-left corner. The point locates the object named in that comment.",
      ...comments.map(
        ({ point, text }, index) =>
          `${index + 1}. (x: ${(point.x * 100).toFixed(1)}%, y: ${(point.y * 100).toFixed(1)}%): ${JSON.stringify(text)}`,
      ),
      "Keep the pins, coordinates and annotation text out of the generated image. Report only the resulting changes or relevant limitations.",
    ].join("\n"),
    keepPreview: true,
  };
}

export function imageShapePoints(shape: ImageShape, start: ImagePoint, end: ImagePoint) {
  if (shape === "line") return [start, end];
  if (shape === "box")
    return [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start];
  const map = (x: number, y: number) => ({
    x: start.x + x * (end.x - start.x),
    y: start.y + y * (end.y - start.y),
  });
  if (shape === "triangle") return [map(0.5, 0), map(1, 1), map(0, 1), map(0.5, 0)];
  if (shape === "diamond") return [map(0.5, 0), map(1, 0.5), map(0.5, 1), map(0, 0.5), map(0.5, 0)];
  if (shape === "star") {
    return Array.from({ length: 11 }, (_, index) => {
      const angle = (index / 5) * Math.PI - Math.PI / 2;
      const radius = index % 2 ? 0.22 : 0.5;
      return map(0.5 + Math.cos(angle) * radius, 0.5 + Math.sin(angle) * radius);
    });
  }
  if (shape === "heart") {
    return Array.from({ length: 41 }, (_, index) => {
      const angle = (index * Math.PI) / 20;
      const y =
        13 * Math.cos(angle) -
        5 * Math.cos(2 * angle) -
        2 * Math.cos(3 * angle) -
        Math.cos(4 * angle);
      return map(0.5 + Math.sin(angle) ** 3 / 2, Math.max(0, Math.min(1, (12 - y) / 29)));
    });
  }
  if (shape === "ellipse") {
    const rx = (end.x - start.x) / 2;
    const ry = (end.y - start.y) / 2;
    return Array.from({ length: 33 }, (_, index) => {
      const angle = (index / 32) * 2 * Math.PI;
      return { x: start.x + rx * (1 + Math.cos(angle)), y: start.y + ry * (1 + Math.sin(angle)) };
    });
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const angle = Math.atan2(dy, dx);
  const length = Math.min(0.04, Math.hypot(dx, dy) * 0.35);
  const wing = (offset: number) => ({
    x: Math.max(0, Math.min(1, end.x - Math.cos(angle + offset) * length)),
    y: Math.max(0, Math.min(1, end.y - Math.sin(angle + offset) * length)),
  });
  return [start, end, wing(Math.PI / 6), end, wing(-Math.PI / 6)];
}

export function imageEditInstruction(
  marks: readonly ImageMark[],
  action?: "background" | "resize",
  ratio?: string,
) {
  const local = marks.length > 0;
  const eraseOnly = local && marks.every((mark) => mark.erase);
  const guidance = [
    "Edit the selected original as the primary image. Return one new full image.",
    action === "resize"
      ? `Set the final canvas to ${ratio}. Preserve subject scale and proportions. Reframe by extending surroundings and preserve any original transparency. Avoid cutting off the subject or stretching pixels.`
      : action === "background"
        ? "Remove the entire background and return a PNG with real alpha. Preserve fine subject edges and identity, without halos or restyling."
        : "Keep the original canvas, composition and transparency. Preserve all content outside the requested changes.",
    local
      ? eraseOnly
        ? "If an auxiliary black-and-white selection is supplied, white marks the removal area in the full original frame. Use it only to locate what to remove. Reconstruct the immediate surroundings naturally. Never paint the black or white guide into the result."
        : "The marked detail, if supplied, is a locator. Apply changes at the listed positions on the original, without reproducing the marks or annotation text."
      : "",
  ];
  for (const mark of marks) {
    const { left, top, right, bottom } = imageMarkBounds(mark);
    const position = [left, top, right, bottom]
      .map((value) => `${Math.round(value * 100)}%`)
      .join(", ");
    const operation = mark.erase
      ? "Remove and reconstruct"
      : mark.label
        ? "Apply the attached note here"
        : mark.cuts?.length
          ? "Use only the visible ink in the auxiliary reference to locate the change"
          : mark.kind &&
              ["box", "ellipse", "triangle", "diamond", "star", "heart"].includes(mark.kind)
            ? "Target the interior of this shape"
            : mark.kind === "arrow"
              ? `Target the point at the arrow tip (${Math.round(mark.points[1].x * 100)}%, ${Math.round(mark.points[1].y * 100)}%)`
              : "Target the subject indicated by the stroke";
    guidance.push(
      `${operation} (left, top, right, bottom from original top-left: ${position})${mark.label ? `: ${JSON.stringify(mark.label)}` : "."}`,
    );
  }
  guidance.push(
    "Report the resulting edit and any relevant limitations. Keep internal coordinates and reference identifiers out of the reply.",
  );
  return guidance.filter(Boolean).join("\n");
}

export function imageMarkBounds(mark: ImageMark) {
  const x = mark.points.map((point) => point.x);
  const y = mark.points.map((point) => point.y);
  const labelLength = mark.label?.length ?? 0;
  const labelSize = mark.labelSize ?? 0.032;
  return {
    left: Math.min(...x),
    top: Math.min(...y),
    right: Math.min(1, Math.max(...x) + labelLength * labelSize * 0.54),
    bottom: Math.min(1, Math.max(...y) + (labelLength ? labelSize * 1.15 : 0)),
  };
}

export function transformImageShape(mark: ImageMark, dx: number, dy: number, handle?: string) {
  const { left, top, right, bottom } = imageMarkBounds(mark);
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  let map: (point: ImagePoint) => ImagePoint;
  if (handle) {
    const w = right - left,
      h = bottom - top;
    const x1 = handle.includes("w") ? clamp(left + dx, 0, right - Math.min(w, 0.005)) : left;
    const x2 = handle.includes("e") ? clamp(right + dx, left + Math.min(w, 0.005), 1) : right;
    const y1 = handle.includes("n") ? clamp(top + dy, 0, bottom - Math.min(h, 0.005)) : top;
    const y2 = handle.includes("s") ? clamp(bottom + dy, top + Math.min(h, 0.005), 1) : bottom;
    map = ({ x, y }) => ({
      x: w ? x1 + ((x - left) / w) * (x2 - x1) : x,
      y: h ? y1 + ((y - top) / h) * (y2 - y1) : y,
    });
  } else {
    const xOffset = clamp(dx, -left, 1 - right);
    const yOffset = clamp(dy, -top, 1 - bottom);
    map = ({ x, y }) => ({ x: x + xOffset, y: y + yOffset });
  }
  return {
    ...mark,
    points: mark.points.map(map),
    cuts: mark.cuts?.map((cut) => ({
      ...cut,
      points: cut.points.map(map),
    })),
  };
}

export function imageMarkAt(marks: readonly ImageMark[], point: ImagePoint, tolerance: ImagePoint) {
  const distance = (a: ImagePoint, b: ImagePoint) => {
    const x = (b.x - a.x) / tolerance.x;
    const y = (b.y - a.y) / tolerance.y;
    const dx = (point.x - a.x) / tolerance.x;
    const dy = (point.y - a.y) / tolerance.y;
    const fraction = Math.max(0, Math.min(1, (dx * x + dy * y) / (x * x + y * y || 1)));
    return Math.hypot(dx - x * fraction, dy - y * fraction);
  };
  for (let index = marks.length - 1; index >= 0; index--) {
    const mark = marks[index];
    if (mark.label) {
      const { left, top, right, bottom } = imageMarkBounds(mark);
      if (
        point.x >= left - tolerance.x &&
        point.x <= right + tolerance.x &&
        point.y >= top - tolerance.y &&
        point.y <= bottom + tolerance.y
      )
        return index;
    } else if (mark.points.some((start, i) => distance(start, mark.points[i + 1] ?? start) <= 1)) {
      return index;
    }
  }
  return -1;
}

/** An eraser gesture masks only the ink present when that gesture was drawn. */
export function eraseImageMarks(
  marks: ImageMark[],
  cut: ImageMarkCut,
  size: { width: number; height: number },
) {
  const scale = Math.min(size.width, size.height);
  const radius = (cut.normalizedWidth * scale) / 2;
  const toPixels = ({ x, y }: ImagePoint) => ({ x: x * size.width, y: y * size.height });
  const trail = cut.points.map(toPixels);
  const withinTrail = (point: ImagePoint, path: ImagePoint[], limit: number) =>
    path.some((a, index) => {
      const b = path[index + 1] ?? a;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const fraction = Math.max(
        0,
        Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
      );
      return Math.hypot(point.x - a.x - dx * fraction, point.y - a.y - dy * fraction) <= limit;
    });
  const samples = (path: ImagePoint[], spacing: number) =>
    path.flatMap((a, index) => {
      const b = path[index + 1];
      if (!b) return [a];
      const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing));
      return Array.from({ length: count }, (_, step) => ({
        x: a.x + ((b.x - a.x) * step) / count,
        y: a.y + ((b.y - a.y) * step) / count,
      }));
    });
  let changed = false;
  const remaining = marks.flatMap((mark) => {
    const ink = mark.label
      ? 0
      : (mark.normalizedWidth ? mark.normalizedWidth * scale : mark.width) / 2;
    const bounds = imageMarkBounds(mark);
    const a = toPixels({ x: bounds.left, y: bounds.top });
    const b = toPixels({ x: bounds.right, y: bounds.bottom });
    const outer = radius + ink;
    if (
      trail.every((p) => p.x < a.x - outer) ||
      trail.every((p) => p.x > b.x + outer) ||
      trail.every((p) => p.y < a.y - outer) ||
      trail.every((p) => p.y > b.y + outer)
    )
      return [mark];
    const spacing = Math.max(1, radius / 3);
    const path = mark.points.map(toPixels);
    if (
      !mark.label &&
      !samples(path, spacing).some((point) => withinTrail(point, trail, outer + spacing / 2))
    )
      return [mark];
    changed = true;
    const cuts = [...(mark.cuts ?? []), cut];
    const sweeps = cuts.flatMap(({ points, normalizedWidth }) => {
      const inner = (normalizedWidth * scale) / 2 - ink;
      return inner > 0
        ? [{ path: points === cut.points ? trail : points.map(toPixels), inner }]
        : [];
    });
    if (sweeps.length) {
      const step = Math.max(1, Math.min(...sweeps.map(({ inner }) => inner)) / 3);
      // A text box is fully covered only if a single disk contains its corners.
      // For strokes, the margin covers the space between adjacent samples.
      const covered = mark.label
        ? sweeps.some(({ path, inner }) =>
            path.some((p) =>
              [a, b, { x: a.x, y: b.y }, { x: b.x, y: a.y }].every(
                (corner) => Math.hypot(corner.x - p.x, corner.y - p.y) <= inner,
              ),
            ),
          )
        : samples(path, step).every((p) =>
            sweeps.some(({ path, inner }) => withinTrail(p, path, inner - step / 2)),
          );
      if (covered) return [];
    }
    return [{ ...mark, cuts }];
  });
  return changed ? remaining : marks;
}

/** Make a bounded visual reference from the original pixels. The source itself is immutable. */
export async function createImageRegionReference(
  blob: Blob,
  marks: readonly ImageMark[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const image = await createImageBitmap(blob);
  try {
    signal.throwIfAborted();
    const eraseOnly = marks.every((mark) => mark.erase);
    const bounds = marks.map(imageMarkBounds);
    const left = Math.min(...bounds.map((mark) => mark.left));
    const top = Math.min(...bounds.map((mark) => mark.top));
    const right = Math.max(...bounds.map((mark) => mark.right));
    const bottom = Math.max(...bounds.map((mark) => mark.bottom));
    const minImageSize = Math.min(image.width, image.height);
    const paintRadius =
      Math.max(
        ...marks.map((mark) =>
          mark.normalizedWidth ? mark.normalizedWidth * minImageSize : mark.width,
        ),
      ) /
        2 +
      1;
    const paddingX = Math.max(0.025, (right - left) * 0.25, paintRadius / image.width);
    const paddingY = Math.max(0.025, (bottom - top) * 0.25, paintRadius / image.height);
    const x = eraseOnly ? 0 : Math.floor(Math.max(0, left - paddingX) * image.width);
    const y = eraseOnly ? 0 : Math.floor(Math.max(0, top - paddingY) * image.height);
    const width = eraseOnly
      ? image.width
      : Math.ceil(Math.min(1, right + paddingX) * image.width) - x;
    const height = eraseOnly
      ? image.height
      : Math.ceil(Math.min(1, bottom + paddingY) * image.height) - y;
    const scale = Math.min(1, 768 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image region canvas is unavailable");
    if (eraseOnly) {
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
    }
    const layer = marks.some((mark) => mark.cuts?.length)
      ? document.createElement("canvas")
      : undefined;
    if (layer) {
      layer.width = canvas.width;
      layer.height = canvas.height;
    }
    const inkContext = layer?.getContext("2d");
    if (layer && !inkContext) throw new Error("Image markup canvas is unavailable");
    const px = (point: ImagePoint) => (point.x * image.width - x) * (canvas.width / width);
    const py = (point: ImagePoint) => (point.y * image.height - y) * (canvas.height / height);
    const pixelScale = Math.min(image.width, image.height) * scale;
    const paint = (
      target: CanvasRenderingContext2D,
      points: ImagePoint[],
      weight: number,
      color: string,
    ) => {
      target.lineCap = "round";
      target.lineJoin = "round";
      target.lineWidth = weight;
      target.beginPath();
      if (points.length === 1) {
        target.fillStyle = color;
        target.arc(px(points[0]), py(points[0]), weight / 2, 0, 2 * Math.PI);
        target.fill();
        return;
      }
      target.strokeStyle = color;
      points.forEach((point, index) => {
        if (index === 0) target.moveTo(px(point), py(point));
        else target.lineTo(px(point), py(point));
      });
      target.stroke();
    };
    for (const mark of marks) {
      const target: CanvasRenderingContext2D =
        mark.cuts?.length && inkContext ? inkContext : context;
      if (target !== context) target.clearRect(0, 0, canvas.width, canvas.height);
      if (mark.label && mark.points[0]) {
        const markBounds = imageMarkBounds(mark);
        target.font = `600 ${Math.max(10, (mark.labelSize ?? 0.032) * image.height * scale)}px sans-serif`;
        target.fillStyle = mark.color;
        target.textAlign = "start";
        target.textBaseline = "top";
        target.fillText(
          mark.label,
          px(mark.points[0]),
          py(mark.points[0]),
          (markBounds.right - markBounds.left) * image.width * scale,
        );
      } else {
        const weight = mark.normalizedWidth ? mark.normalizedWidth * pixelScale : mark.width;
        paint(target, mark.points, Math.max(1, weight), eraseOnly ? "#fff" : mark.color);
      }
      if (target !== context && layer) {
        target.globalCompositeOperation = "destination-out";
        for (const cut of mark.cuts ?? [])
          paint(target, cut.points, cut.normalizedWidth * pixelScale, "#000");
        target.globalCompositeOperation = "source-over";
        context.drawImage(layer, 0, 0);
      }
    }
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("Could not encode image region"))),
        "image/png",
      );
    });
    signal.throwIfAborted();
    return new File([png], eraseOnly ? "image-edit-selection.png" : "image-edit-region.png", {
      type: "image/png",
    });
  } finally {
    image.close();
  }
}
import type { AssistantDeliverable } from "../../lib/chat/assistantResources";
