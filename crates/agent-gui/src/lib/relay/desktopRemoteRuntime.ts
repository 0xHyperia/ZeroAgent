import type {
  DesktopCloudHost,
  DesktopRemoteHost,
  DesktopTaskConversation,
} from "@/lib/desktopRemoteHost";

type Runtime = {
  mount(
    container: HTMLElement,
    host: DesktopRemoteHost | DesktopCloudHost,
  ): {
    dispose(): void;
    setActive?(active: boolean): void;
    setAccountLayout?(layout: import("@/lib/desktopRemoteHost").DesktopAccountLayout): void;
    setTaskConversation?(conversation: DesktopTaskConversation): void;
  };
};
type RuntimeFactory = { createDesktopRemoteRuntime(): Runtime };
type Manifest = { schemaVersion: number; entry: string; styles: string[]; sha256: string };
let prepared: Promise<{ factory: RuntimeFactory; styles: string[] }> | undefined;

export function loadDesktopRemoteRuntime() {
  prepared ??= (async () => {
    const base = new URL("remote-device/", document.baseURI);
    const response = await fetch(new URL("manifest.json", base));
    if (!response.ok) throw new Error("完整远程界面未打包，请重新构建 ZeroAgent。");
    const manifest = (await response.json()) as Manifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.entry !== "runtime.js" ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Array.isArray(manifest.styles) ||
      manifest.styles.length !== 1 ||
      manifest.styles.some((name) => !/^[\w.-]+\.css$/.test(name))
    )
      throw new Error("远程界面构建信息无效。");
    const entry = new URL(manifest.entry, base);
    entry.searchParams.set("build", manifest.sha256);
    const factory = (await import(/* @vite-ignore */ entry.href)) as RuntimeFactory;
    if (typeof factory.createDesktopRemoteRuntime !== "function")
      throw new Error("远程界面构建版本不兼容。");
    return { factory, styles: manifest.styles.map((name) => new URL(name, base).href) };
  })().catch((error) => {
    prepared = undefined;
    throw error;
  });
  return prepared;
}

export async function attachDesktopRemoteStyles(styles: string[], signal: AbortSignal) {
  const links: HTMLLinkElement[] = [];
  const dispose = () => {
    for (const link of links) link.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    await Promise.all(
      styles.map(
        (href) =>
          new Promise<void>((resolve, reject) => {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = href;
            link.dataset.zeroagentRemoteStyles = "";
            link.onload = () => resolve();
            link.onerror = () => reject(new Error("远程界面样式加载失败。"));
            signal.addEventListener("abort", () => reject(new Error("远程界面已关闭。")), {
              once: true,
            });
            links.push(link);
            if (signal.aborted) {
              reject(new Error("远程界面已关闭。"));
              return;
            }
            document.head.append(link);
          }),
      ),
    );
    return Object.assign(dispose, {
      setEnabled(enabled: boolean) {
        for (const link of links) link.disabled = !enabled;
      },
    });
  } catch (error) {
    dispose();
    throw error;
  }
}
