export function createQuickOpenWorker(): Worker | null {
  try {
    return new Worker(new URL("./fileQuickOpen.worker.ts", import.meta.url), {
      type: "module",
      name: "palette-quick-open",
    });
  } catch {
    return null;
  }
}
