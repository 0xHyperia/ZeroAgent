export const DEVICE_PRESETS = [
  { id: "responsive", width: 390, height: 844, label: "Responsive" },
  { id: "4k", width: 2560, height: 1440, label: "4K" },
  { id: "laptop-l", width: 1440, height: 900, label: "Laptop L" },
  { id: "laptop", width: 1024, height: 768, label: "Laptop" },
  { id: "surface-pro-7", width: 912, height: 1368, label: "Surface Pro 7" },
  { id: "ipad-air", width: 820, height: 1180, label: "iPad Air" },
  { id: "ipad-mini", width: 768, height: 1024, label: "iPad Mini" },
  { id: "surface-duo", width: 540, height: 720, label: "Surface Duo" },
  { id: "iphone-15-pro-max", width: 430, height: 932, label: "iPhone 15 Pro Max" },
  { id: "pixel-8", width: 412, height: 915, label: "Pixel 8" },
  { id: "iphone-15-pro", width: 393, height: 852, label: "iPhone 15 Pro" },
  { id: "samsung-galaxy-s24-ultra", width: 384, height: 824, label: "Samsung Galaxy S24 Ultra" },
  { id: "iphone-se", width: 375, height: 667, label: "iPhone SE" },
] as const;

export type DeviceViewport = {
  preset: (typeof DEVICE_PRESETS)[number]["id"];
  width: number;
  height: number;
};

export const DEFAULT_DEVICE_VIEWPORT: DeviceViewport = {
  preset: "responsive",
  width: 390,
  height: 844,
};

export function clampDeviceDimension(axis: "width" | "height", value: number) {
  return Math.min(4096, Math.max(axis === "width" ? 240 : 160, Math.round(value)));
}

export function fitDeviceViewport(
  stage: { width: number; height: number },
  viewport: DeviceViewport,
) {
  const scale = Math.max(
    0,
    Math.min(1, (stage.width - 40) / viewport.width, (stage.height - 20) / viewport.height),
  );
  return {
    width: Math.round(viewport.width * scale),
    height: Math.round(viewport.height * scale),
    scale,
  };
}

export function rotateDeviceViewport(viewport: DeviceViewport): DeviceViewport {
  const width = clampDeviceDimension("width", viewport.height);
  const height = clampDeviceDimension("height", viewport.width);
  return {
    preset: width === viewport.height && height === viewport.width ? viewport.preset : "responsive",
    width,
    height,
  };
}
