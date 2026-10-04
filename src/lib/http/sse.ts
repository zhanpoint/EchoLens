export type SseJsonStreamOptions = {
  onDone?: () => void;
};

export async function* readSseJsonStream<T>(
  stream: ReadableStream<Uint8Array>,
  options: SseJsonStreamOptions = {},
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/u);
      buffer = events.pop() ?? "";
      for (const event of events) {
        if (isSseDoneEvent(event)) {
          options.onDone?.();
          return;
        }
        const payload = parseSseJsonPayload<T>(event);
        if (payload) {
          yield payload;
        }
      }
    }

    buffer += decoder.decode();
    if (isSseDoneEvent(buffer)) {
      options.onDone?.();
      return;
    }
    const payload = parseSseJsonPayload<T>(buffer);
    if (payload) {
      yield payload;
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function readSseData(event: string): string {
  return event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
}

function isSseDoneEvent(event: string): boolean {
  return readSseData(event) === "[DONE]";
}

function parseSseJsonPayload<T>(event: string): T | null {
  const data = readSseData(event);

  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
