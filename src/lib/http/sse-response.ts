export type JsonSseWriter<T> = {
  isClosed: () => boolean;
  send: (event: T) => void;
};

export function createJsonSseResponse<T>(
  signal: AbortSignal | undefined,
  run: (writer: JsonSseWriter<T>) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The consumer can close while background preparation is finishing.
        }
      };
      const writer: JsonSseWriter<T> = {
        isClosed: () => closed,
        send(event) {
          if (closed || signal?.aborted) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            closed = true;
          }
        },
      };
      signal?.addEventListener("abort", close, { once: true });
      void run(writer).finally(close);
    },
    cancel() {
      closed = true;
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