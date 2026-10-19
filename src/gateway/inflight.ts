/** Tracks running handlers so shutdown can wait for them instead of dropping replies. */
export class Inflight {
  private running = new Set<Promise<unknown>>();

  track<T>(work: Promise<T>): Promise<T> {
    this.running.add(work);
    const done = () => this.running.delete(work);
    work.then(done, done);
    return work;
  }

  get size(): number {
    return this.running.size;
  }

  /** Resolves true when everything finished, false if `timeoutMs` elapsed first. */
  async drain(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), timeoutMs)));
    const all = Promise.allSettled([...this.running]).then(() => true as const);
    try {
      return await Promise.race([all, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
