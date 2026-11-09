/**
 * Waits `ms`, or less when `signal` aborts first. Resolves true after the full wait, false on abort. The timer is
 * unref'd: a pending backoff must not keep the process alive on shutdown.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (full: boolean) => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      resolve(full);
    };
    const onAbort = () => finish(false);
    const t = setTimeout(() => finish(true), ms);
    t.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
