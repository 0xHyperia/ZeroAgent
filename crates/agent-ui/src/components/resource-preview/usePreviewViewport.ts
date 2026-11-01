import { useContext, useEffect, useRef, useState } from "react";
import { PreviewToolbarMount } from "./PreviewChrome";

/** Measure the reading pane, which can be narrow inside a wide application window. */
export function usePreviewViewport<T extends HTMLElement = HTMLDivElement>() {
  const container = useRef<T>(null);
  const chrome = useContext(PreviewToolbarMount);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setViewport((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const sideInset = chrome?.inspectorOpen && viewport.width >= 600 ? 288 : 0;
  return { container, viewport, sideInset };
}
