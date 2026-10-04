/** Cancel one waiter without cancelling other consumers of the same operation. */
export async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
