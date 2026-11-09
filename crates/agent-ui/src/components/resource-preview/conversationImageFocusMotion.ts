export const imageFocusDuration = 180;
const easing = "cubic-bezier(.2,.75,.3,1)";

export type ImageFocusOrigin = {
  id: string;
  image: HTMLImageElement;
  radius: string;
};

export function imageFocusOrigin(
  id: string,
  trigger: HTMLElement | null,
): ImageFocusOrigin | undefined {
  const card = trigger?.closest<HTMLElement>("[data-image-preview-origin]");
  if (card?.dataset.imagePreviewOrigin !== id) return;
  const image = card.querySelector("img");
  if (image?.complete && image.naturalWidth > 0) {
    return { id, image, radius: getComputedStyle(card).borderRadius };
  }
}

export function imageFocusRect(element: Element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 &&
    rect.height > 0 &&
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
    ? rect
    : null;
}

export function canAnimateImageFocus() {
  return (
    typeof HTMLElement.prototype.animate === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function focusCanvasImage(layer: HTMLElement) {
  return layer.querySelector<HTMLImageElement>(
    '.za-image-workspace[data-ready="true"] img.za-image-content',
  );
}

function focusGhost(layer: HTMLElement, source: HTMLImageElement, rect: DOMRect, radius: string) {
  const ghost = document.createElement("img");
  ghost.alt = "";
  ghost.setAttribute("aria-hidden", "true");
  ghost.className = "za-conversation-image-flight";
  ghost.src = source.currentSrc || source.src;
  Object.assign(ghost.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    borderRadius: radius,
  });
  layer.append(ghost);
  return ghost;
}

function fly(ghost: HTMLImageElement, from: DOMRect, to: DOMRect, radius: string) {
  return ghost.animate(
    [
      { transform: "none", borderRadius: ghost.style.borderRadius },
      {
        transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`,
        borderRadius: radius,
      },
    ],
    { duration: imageFocusDuration, easing, fill: "forwards" },
  );
}

export function enterImageFocus(layer: HTMLElement, origin: ImageFocusOrigin) {
  const start = imageFocusRect(origin.image);
  if (!start || !canAnimateImageFocus()) return;
  const ghost = focusGhost(layer, origin.image, start, origin.radius);
  layer.dataset.flying = "true";
  let animation: Animation | undefined;
  let frame = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    observer.disconnect();
    window.clearTimeout(timeout);
    window.cancelAnimationFrame(frame);
    animation?.cancel();
    ghost.remove();
    delete layer.dataset.flying;
  };
  const scheduleStart = () => {
    if (animation || frame || finished) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      // The ready attribute can change in the same commit as the canvas dimensions.
      const image = focusCanvasImage(layer);
      const target = image && imageFocusRect(image);
      if (!target) return;
      animation = fly(ghost, start, target, "0px");
      animation.onfinish = finish;
    });
  };
  const observer = new MutationObserver(scheduleStart);
  observer.observe(layer, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-ready"],
  });
  const timeout = window.setTimeout(finish, 1200);
  scheduleStart();
  return finish;
}

export function leaveImageFocus(layer: HTMLElement, origin: ImageFocusOrigin) {
  const image = focusCanvasImage(layer);
  const start = image && imageFocusRect(image);
  const target = origin.image.isConnected ? imageFocusRect(origin.image) : null;
  if (!image || !start || !target) return;
  const ghost = focusGhost(layer, image, start, "0px");
  layer.dataset.flying = "true";
  const animation = fly(ghost, start, target, origin.radius);
  return () => {
    animation.cancel();
    ghost.remove();
    delete layer.dataset.flying;
  };
}
