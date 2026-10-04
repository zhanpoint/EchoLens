import { awaitWithSignal } from "@/lib/http/abort";

type Schedule = { tail: Promise<void>; nextAt: number };
export function createDashScopeRequestPolicy() {
  const schedules = new Map<string, Schedule>();
  return {
    async beforeRequest(model: string, signal?: AbortSignal | null) {
      signal?.throwIfAborted();
      let schedule = schedules.get(model);
      if (!schedule) {
        schedule = { tail: Promise.resolve(), nextAt: 0 };
        schedules.set(model, schedule);
      }
      // Official ASR limits: 600 RPM per model, task queries 20 QPS.
      const interval = model === "query" ? 50 : 100;
      const slot = schedule;
      const request = slot.tail.then(async () => {
        signal?.throwIfAborted();
        const wait = Math.min(interval, Math.max(0, slot.nextAt - Date.now()));
        if (wait) await awaitWithSignal(new Promise(resolve => setTimeout(resolve, wait)), signal ?? undefined);
        signal?.throwIfAborted();
        slot.nextAt = Date.now() + interval;
      });
      slot.tail = request.catch(() => undefined);
      await request;
    },
  };
}

const globals = globalThis as typeof globalThis & {
  __echolensAsrRequestPolicy?: ReturnType<typeof createDashScopeRequestPolicy>;
};
export const dashScopeRequestPolicy = globals.__echolensAsrRequestPolicy ??= createDashScopeRequestPolicy();
