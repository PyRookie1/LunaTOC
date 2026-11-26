/** Task-scoped original-byte reader. Does not request host permissions or persist media. */
export interface ImageEvidence { bytes: number; width: number; height: number; mime: string }
const IMAGE_BUDGET = 12 * 1024 * 1024;

export function allowedImageUrl(source: string, origin: string): URL | null {
  try {
    const url = new URL(source, origin);
    if (url.username || url.password) return null;
    if (url.protocol === 'blob:') return url.origin === origin ? url : null;
    if (url.protocol === 'data:') return /^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(source) &&
      source.length <= IMAGE_BUDGET * 1.4 ? url : null;
    if (url.protocol !== 'https:') return null;
    return url.origin === origin || url.hostname.endsWith('.oaiusercontent.com') ? url : null;
  } catch { return null; }
}

export async function readImage(source: string, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<ImageEvidence> {
  const url = allowedImageUrl(source, location.origin);
  if (!url) throw new Error('unsupported-image-origin');
  const response = await fetcher(url.href, {
    signal, credentials: url.origin === location.origin ? 'include' : 'omit',
    redirect: 'error', cache: 'no-store',
  });
  if (!response.ok || Number(response.headers.get('content-length')) > IMAGE_BUDGET) throw new Error('image-budget');
  const mime = (response.headers.get('content-type') ?? '').split(';')[0];
  if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime)) throw new Error('image-type');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('image-body');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > IMAGE_BUDGET) throw new Error('image-budget');
      chunks.push(new Uint8Array(next.value));
    }
    signal.throwIfAborted();
    if (bytes === 0) throw new Error('image-empty');
    const bitmap = await createImageBitmap(new Blob(chunks, { type: mime }));
    try {
      signal.throwIfAborted();
      return { bytes, width: bitmap.width, height: bitmap.height, mime };
    } finally { bitmap.close(); }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    chunks.length = 0;
  }
}

/** Selects a loaded, genuinely visible content image; never scrolls or clicks. */
export function visibleImage(root: Element | null): HTMLImageElement | null {
  if (!root) return null;
  const bounds = root.getBoundingClientRect();
  return Array.from(root.querySelectorAll('img')).find(image => {
    const rect = image.getBoundingClientRect();
    return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0 &&
      rect.width > 0 && rect.height > 0 && getComputedStyle(image).visibility !== 'hidden' &&
      rect.bottom > Math.max(0, bounds.top) && rect.top < Math.min(innerHeight, bounds.bottom) &&
      rect.right > Math.max(0, bounds.left) && rect.left < Math.min(innerWidth, bounds.right);
  }) ?? null;
}

/** Bounded, task-local request coalescing. Successful entries retain evidence, not bytes. */
export class TaskImageReader {
  private readonly requests = new Map<string, Promise<ImageEvidence>>();
  private readonly queue: Array<{ run: () => void; reject: (reason: unknown) => void }> = [];
  private active = 0;

  constructor(private readonly signal: AbortSignal, private readonly fetcher: typeof fetch = fetch,
    private readonly concurrency = 2) {
    signal.addEventListener('abort', () => {
      for (const item of this.queue.splice(0)) item.reject(new DOMException('Task ended', 'AbortError'));
      this.requests.clear();
    }, { once: true });
  }

  read(source: string): Promise<ImageEvidence> {
    if (this.signal.aborted) return Promise.reject(new DOMException('Task ended', 'AbortError'));
    const key = allowedImageUrl(source, location.origin)?.href;
    if (!key) return Promise.reject(new Error('unsupported-image-origin'));
    const existing = this.requests.get(key);
    if (existing) return existing;
    if (this.queue.length >= 64) return Promise.reject(new Error('image-queue-budget'));
    const promise = new Promise<ImageEvidence>((resolve, reject) => {
      this.queue.push({ reject, run: () => {
        this.active++;
        void readImage(key, this.signal, this.fetcher).then(resolve, reject).finally(() => {
          this.active--; this.pump();
        });
      } });
    });
    this.requests.set(key, promise);
    void promise.catch(() => { if (this.requests.get(key) === promise) this.requests.delete(key); });
    this.pump();
    return promise;
  }

  private pump(): void {
    while (!this.signal.aborted && this.active < Math.max(1, this.concurrency) && this.queue.length) {
      this.queue.shift()!.run();
    }
  }
}
