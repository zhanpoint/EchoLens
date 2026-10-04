import { describe, expect, it, vi } from "vitest";
import { readSseJsonStream } from "@/lib/http/sse";
import { createJsonSseResponse } from "@/lib/http/sse-response";

const encode = (value: string) => new TextEncoder().encode(value);

describe("SSE lifecycle", () => {
  it("cancels upstream when a consumer stops iterating early", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encode('data: {"value":1}\n\n')); },
      cancel,
    });
    for await (const event of readSseJsonStream<{ value: number }>(stream)) {
      expect(event.value).toBe(1);
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("stops at DONE without waiting for a persistent upstream to disconnect", async () => {
    const cancel = vi.fn();
    const done = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('data: {"value":1}\n\ndata: [DONE]\n\ndata: {"value":2}\n\n'));
      },
      cancel,
    });
    const events = [];
    for await (const event of readSseJsonStream(stream, { onDone: done })) events.push(event);
    expect(events).toEqual([{ value: 1 }]);
    expect(done).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts the producer when the response body is canceled", async () => {
    let signal: AbortSignal | undefined;
    const response = createJsonSseResponse(undefined, async (writer) => {
      signal = writer.signal;
      writer.send({ value: 1 });
      await new Promise<void>((resolve) => writer.signal.addEventListener("abort", () => resolve(), { once: true }));
      writer.send({ value: 2 });
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"value":1');
    await reader.cancel();
    expect(signal?.aborted).toBe(true);
  });

  it("detaches the request listener on normal completion", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const response = createJsonSseResponse(controller.signal, async ({ send }) => { send({ done: true }); });
    expect(await response.text()).toContain('"done":true');
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not start upstream work for an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();
    expect(await createJsonSseResponse(controller.signal, run).text()).toBe("");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports unexpected producer errors through the response without an unhandled rejection", async () => {
    const response = createJsonSseResponse(undefined, async () => { throw new Error("producer failed"); });
    await expect(response.text()).rejects.toThrow("producer failed");
  });
});
