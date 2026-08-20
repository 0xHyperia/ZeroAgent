export type ImageLoadState = "loading" | "loaded" | "error";

export type LoadedImageSize = {
  width: number;
  height: number;
};

export function getCompletedImageLoadState(
  image: HTMLImageElement | null,
): Exclude<ImageLoadState, "loading"> | null {
  if (!image?.complete) return null;
  return image.naturalWidth > 0 || image.naturalHeight > 0 ? "loaded" : "error";
}

export function getLoadedImageSize(image: HTMLImageElement | null): LoadedImageSize | null {
  if (getCompletedImageLoadState(image) !== "loaded") return null;
  return {
    width: image?.naturalWidth ?? 0,
    height: image?.naturalHeight ?? 0,
  };
}
