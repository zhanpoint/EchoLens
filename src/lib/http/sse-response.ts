export type JsonSseWriter<T> = {
  isClosed: () => boolean;
  send: (event: T) => void;
  signal: AbortSignal;
};

export function createJsonSseResponse<T>(
  signal: AbortSignal | undefined,
  run: (writer: JsonSseWriter<T>) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const operation = new AbortController();
  let closed = false;
  let detach = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
        detach();
      };
      const abort = () => {
        operation.abort(signal?.reason);
        close();
      };
      detach = () => signal?.removeEventListener("abort", abort);
      const writer: JsonSseWriter<T> = {
        isClosed: () => closed,
        signal: operation.signal,
        send(event) {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        },
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      void (async () => {
        operation.signal.throwIfAborted();
        await run(writer);
      })().then(close, (error: unknown) => {
        if (!closed) {
          closed = true;
          controller.error(error);
        }
      }).finally(detach);
    },
    cancel(reason) {
      closed = true;
      operation.abort(reason);
      detach();
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}
