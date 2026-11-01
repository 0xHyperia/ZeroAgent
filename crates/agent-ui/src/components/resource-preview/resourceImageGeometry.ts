import {
  clampImageViewerPan,
  type ImageViewerSize,
  rotatedImageViewerSize,
} from "../chat/imagePreviewModel";

export type ImageView = { zoom: "fit-page" | number; rotation: number; x: number; y: number };
export const initialImageView: ImageView = { zoom: "fit-page", rotation: 0, x: 0, y: 0 };
export const imageScaleLimit = (scale: number) =>
  Math.max(0.01, Math.min(8, Number.isFinite(scale) ? scale : 1));
export function imageViewGeometry(
  size: ImageViewerSize,
  viewport: ImageViewerSize,
  rotation: number,
) {
  const rotated = rotatedImageViewerSize(size, rotation);
  const fit =
    rotated.width && rotated.height && viewport.width && viewport.height
      ? Math.min(1, viewport.width / rotated.width, viewport.height / rotated.height)
      : 1;
  return { size, viewport, fit };
}
export function boundImageView(
  view: ImageView,
  geometry: ReturnType<typeof imageViewGeometry>,
): ImageView {
  const scale = view.zoom === "fit-page" ? geometry.fit : imageScaleLimit(view.zoom / 100);
  const pan = clampImageViewerPan(view, {
    imageSize: { width: geometry.size.width * scale, height: geometry.size.height * scale },
    viewportSize: geometry.viewport,
    rotation: view.rotation,
    scale: 1,
  });
  return { ...view, ...pan, zoom: view.zoom === "fit-page" ? view.zoom : scale * 100 };
}
export function zoomImageView(
  view: ImageView,
  zoom: ImageView["zoom"],
  anchor: { x: number; y: number },
  geometry: ReturnType<typeof imageViewGeometry>,
) {
  const before = view.zoom === "fit-page" ? geometry.fit : imageScaleLimit(view.zoom / 100);
  const after = zoom === "fit-page" ? geometry.fit : imageScaleLimit(zoom / 100);
  return boundImageView(
    {
      ...view,
      zoom,
      x: anchor.x - ((anchor.x - view.x) * after) / before,
      y: anchor.y - ((anchor.y - view.y) * after) / before,
    },
    geometry,
  );
}
