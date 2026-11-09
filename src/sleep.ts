/**
 * Waits `ms`, or less when `signal` aborts first. Resolves true after the full wait, false on abort. `unref`: the
 * timer does not keep the process alive (a backoff that may be dropped on shutdown).
 */
export function abortableSleep(ms: number, signal?: AbortSignal, o: { unref?: boolean } = {}): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (full: boolean) => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      resolve(full);
    };
    const onAbort = () => finish(false);
    const t = setTimeout(() => finish(true), ms);
    if (o.unref) t.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
