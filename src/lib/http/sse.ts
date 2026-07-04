export async function* readSseJsonStream<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/u);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const payload = parseSseJsonPayload<T>(event);
        if (payload) {
          yield payload;
        }
      }
    }

    buffer += decoder.decode();
    const payload = parseSseJsonPayload<T>(buffer);
    if (payload) {
      yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseJsonPayload<T>(event: string): T | null {
  const data = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
