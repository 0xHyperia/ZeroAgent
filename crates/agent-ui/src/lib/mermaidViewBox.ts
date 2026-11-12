export type MermaidViewBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MermaidPoint = { x: number; y: number };
export type MermaidViewport = { width: number; height: number };

export function parseMermaidViewBox(value: string | null): MermaidViewBox | null {
  if (!value) return null;
  const values = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    values.length !== 4 ||
    values.some((part) => !Number.isFinite(part)) ||
    values[2] <= 0 ||
    values[3] <= 0
  ) {
    return null;
  }
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

export function zoomMermaidViewBox(
  viewBox: MermaidViewBox,
  factor: number,
  anchor: MermaidPoint = { x: 0.5, y: 0.5 },
): MermaidViewBox {
  if (!Number.isFinite(factor) || factor <= 0) return viewBox;
  const width = viewBox.width / factor;
  const height = viewBox.height / factor;
  return {
    x: viewBox.x + (viewBox.width - width) * anchor.x,
    y: viewBox.y + (viewBox.height - height) * anchor.y,
    width,
    height,
  };
}

export function fitMermaidViewBox(
  diagram: MermaidViewBox,
  viewport: MermaidViewport,
  padding: number,
): MermaidViewBox {
  if (viewport.width <= 0 || viewport.height <= 0) return diagram;
  const scale = Math.min(
    1,
    Math.max(1, viewport.width - 2 * padding) / diagram.width,
    Math.max(1, viewport.height - 2 * padding) / diagram.height,
  );
  const width = viewport.width / scale;
  const height = viewport.height / scale;
  return {
    x: diagram.x + (diagram.width - width) / 2,
    y: diagram.y + (diagram.height - height) / 2,
    width,
    height,
  };
}

export function mermaidZoomAnchor(
  viewBox: MermaidViewBox,
  point: MermaidPoint,
  viewport: MermaidViewport,
): MermaidPoint {
  const scale = Math.min(viewport.width / viewBox.width, viewport.height / viewBox.height);
  if (!Number.isFinite(scale) || scale <= 0) return { x: 0.5, y: 0.5 };
  return {
    x: 0.5 + (point.x - viewport.width / 2) / (viewBox.width * scale),
    y: 0.5 + (point.y - viewport.height / 2) / (viewBox.height * scale),
  };
}

export function panMermaidViewBox(
  viewBox: MermaidViewBox,
  delta: MermaidPoint,
  viewport: MermaidViewport,
): MermaidViewBox {
  const scale = Math.min(viewport.width / viewBox.width, viewport.height / viewBox.height);
  if (!Number.isFinite(scale) || scale <= 0) return viewBox;
  return {
    ...viewBox,
    x: viewBox.x - delta.x / scale,
    y: viewBox.y - delta.y / scale,
  };
}

export function formatMermaidViewBox(viewBox: MermaidViewBox): string {
  return `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`;
}
