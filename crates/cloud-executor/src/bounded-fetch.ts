// Used in the isolated interpreter worker before the SDK's NDJSON parser.
export function boundedFetch(actualFetch: typeof fetch, maxWireBytes: number): typeof fetch {
  let wireBytes = 0;
  return async (...args: Parameters<typeof fetch>) => {
    const response = await actualFetch(...args);
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) {
            controller.close();
            return;
          }
          wireBytes += item.value.byteLength;
          if (wireBytes > maxWireBytes) {
            await reader.cancel();
            controller.error(new Error("output_limit"));
            return;
          }
          controller.enqueue(item.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
