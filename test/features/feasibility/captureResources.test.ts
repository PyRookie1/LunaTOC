/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedImageUrl, readImage, TaskImageReader } from '@/features/conversationExport/images';
import { CaptureTask, mapWithLimit } from '@/features/conversationExport/task';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('capture resource limits', () => {
  it('rejects arbitrary hosts, insecure URLs, foreign blobs and credentials', () => {
    expect(allowedImageUrl('https://evil.example/image.png', 'https://chatgpt.com')).toBeNull();
    expect(allowedImageUrl('http://chatgpt.com/image.png', 'https://chatgpt.com')).toBeNull();
    expect(allowedImageUrl('blob:https://evil.example/id', 'https://chatgpt.com')).toBeNull();
    expect(allowedImageUrl('https://user:password@chatgpt.com/img', 'https://chatgpt.com')).toBeNull();
    expect(allowedImageUrl('https://files.oaiusercontent.com/image', 'https://chatgpt.com')).not.toBeNull();
  });

  it('bounds concurrency and prevents queued jobs after cancellation', async () => {
    const controller = new AbortController(); let running = 0; let max = 0;
    await mapWithLimit([1, 2, 3, 4], 2, controller.signal, async () => {
      running++; max = Math.max(max, running); await Promise.resolve(); running--; return 1;
    });
    expect(max).toBe(2);
    let count = 0;
    await expect(mapWithLimit([1, 2, 3], 1, controller.signal, async () => {
      count++; controller.abort(); return 1;
    })).rejects.toBeDefined();
    expect(count).toBe(1);
  });

  it('cleans up exactly once on timeout and late registrations immediately', () => {
    vi.useFakeTimers();
    const task = new CaptureTask(100);
    const cleanup = vi.fn(); task.addCleanup(cleanup);
    vi.advanceTimersByTime(101); task.cancel();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(task.signal.reason).toBe('timeout');
    const late = vi.fn(); task.addCleanup(late); expect(late).toHaveBeenCalledOnce();
    expect(() => task.check()).toThrow();
  });

  it('reads original image bytes, verifies decoding and closes the bitmap', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 2, height: 3, close }));
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    const result = await readImage('https://files.oaiusercontent.com/image', new AbortController().signal, fetcher);
    expect(result).toEqual({ width: 2, height: 3, bytes: 3, mime: 'image/png' });
    expect(close).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects a disguised non-image and oversized response before decoding', async () => {
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
    const response = new Response('not an image', { headers: { 'content-type': 'text/html' } });
    await expect(readImage('https://files.oaiusercontent.com/image', new AbortController().signal,
      vi.fn().mockResolvedValue(response))).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
    const tooLarge = new Response('small body', { headers: { 'content-type': 'image/png', 'content-length': String(13 * 1024 * 1024) } });
    await expect(readImage('https://files.oaiusercontent.com/image', new AbortController().signal,
      vi.fn().mockResolvedValue(tooLarge))).rejects.toThrow();
  });

  it('coalesces same-resource reads and cancels queued image jobs', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_source: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('ended', 'AbortError')), { once: true });
    }));
    const reader = new TaskImageReader(controller.signal, fetcher as unknown as typeof fetch, 1);
    const first = reader.read('https://files.oaiusercontent.com/one');
    expect(reader.read('https://files.oaiusercontent.com/one')).toBe(first);
    const queued = reader.read('https://files.oaiusercontent.com/two');
    const results = Promise.allSettled([first, queued]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    controller.abort();
    expect((await results).every(item => item.status === 'rejected')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
