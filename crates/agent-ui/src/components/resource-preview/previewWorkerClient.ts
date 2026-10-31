import type { PreviewWorkerInput, PreviewWorkerResult } from "./previewWorkerProtocol";

export function createResourcePreviewWorker(signal: AbortSignal) {
  const worker = new Worker(new URL("./resourcePreview.worker.ts", import.meta.url), {
    type: "module",
  });
  let sequence = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (result: PreviewWorkerResult) => void;
      reject: (cause: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function dispose() {
    closed = true;
    worker.terminate();
    signal.removeEventListener("abort", dispose);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new DOMException("预览已关闭", "AbortError"));
    }
    pending.clear();
  }
  worker.onmessage = (
    event: MessageEvent<{ id: number; result?: PreviewWorkerResult; error?: string }>,
  ) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(event.data.id);
    if (event.data.error || !event.data.result)
      request.reject(new Error(event.data.error || "文件预览失败。"));
    else request.resolve(event.data.result);
  };
  worker.onerror = () => {
    for (const request of pending.values())
      request.reject(new Error("预览组件加载失败，请重试或下载原件。"));
    dispose();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return {
    dispose,
    request(input: PreviewWorkerInput): Promise<PreviewWorkerResult> {
      if (closed || signal.aborted)
        return Promise.reject(new DOMException("预览已关闭", "AbortError"));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("文件较复杂，预览超时。请下载原件查看。"));
          dispose();
        }, 20_000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, input });
      });
    },
  };
}
