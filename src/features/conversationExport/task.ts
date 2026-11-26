/** Cancellable task lifetime. Disposal is synchronous and idempotent. */
export class CaptureTask {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly id = crypto.randomUUID();
  private cleanups = new Set<() => void>();

  constructor(timeoutMs = 180_000) {
    const timer = setTimeout(() => this.cancel('timeout'), timeoutMs);
    this.addCleanup(() => clearTimeout(timer));
  }

  addCleanup(cleanup: () => void): void {
    if (this.signal.aborted) cleanup();
    else this.cleanups.add(cleanup);
  }

  check(): void {
    if (this.signal.aborted) throw new DOMException('Task ended', 'AbortError');
  }

  cancel(reason = 'cancelled'): void {
    if (this.signal.aborted) return;
    this.controller.abort(reason);
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch { /* Continue releasing the remaining task resources. */ }
    }
    this.cleanups.clear();
  }
}

/** Bounded async work; abort prevents queued work from starting. */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number,
  signal: AbortSignal, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, async () => {
    while (next < items.length) {
      signal.throwIfAborted();
      const index = next++;
      results[index] = await work(items[index]);
      signal.throwIfAborted();
    }
  }));
  return results;
}
