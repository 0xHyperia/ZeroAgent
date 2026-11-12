import {
  clampImageViewerPan,
  type ImageViewerSize,
  rotatedImageViewerSize,
} from "../chat/imagePreviewModel";

export type ImageView = { zoom: "fit-page" | number; rotation: number; x: number; y: number };
export const initialImageView: ImageView = { zoom: "fit-page", rotation: 0, x: 0, y: 0 };
export const imageScaleLimit = (scale: number) =>
  Math.max(0.1, Math.min(4, Number.isFinite(scale) ? scale : 1));
export function imageViewGeometry(
  size: ImageViewerSize,
  viewport: ImageViewerSize,
  rotation: number,
  fitArea?: ImageViewerSize & { offsetY: number },
) {
  const rotated = rotatedImageViewerSize(size, rotation);
  const available = fitArea ?? viewport;
  const fit =
    rotated.width && rotated.height && available.width && available.height
      ? Math.min(1, available.width / rotated.width, available.height / rotated.height)
      : 1;
  return { size, viewport, fit, fitArea };
}
export function boundImageView(
  view: ImageView,
  geometry: ReturnType<typeof imageViewGeometry>,
): ImageView {
  if (view.zoom === "fit-page" && geometry.fitArea) {
    return { ...view, x: 0, y: geometry.fitArea.offsetY };
  }
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
