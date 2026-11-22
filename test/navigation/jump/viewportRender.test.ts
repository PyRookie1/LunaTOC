/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForViewportRender } from '@/navigation/jump/viewportRender';
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); });

describe('virtual viewport render pacing', () => {
  it('waits for delayed mounting and subsequent height/scroll compensation to become quiet', async () => {
    const feed = document.createElement('div'); document.body.append(feed);
    let height = 97881;
    Object.defineProperty(feed, 'scrollHeight', { get: () => height });
    let settled = false;
    const done = waitForViewportRender(feed, () => false).then(() => { settled = true; });
    setTimeout(() => { feed.append(document.createElement('article')); height = 95695; }, 280);
    setTimeout(() => { height = 93597; feed.scrollTop = 3264; }, 520);
    await vi.advanceTimersByTimeAsync(560);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(settled).toBe(true);
  });

  it('bounds waits during continuous mutations and responds to cancellation', async () => {
    const feed = document.createElement('div'); document.body.append(feed);
    const mutations = setInterval(() => feed.replaceChildren(document.createElement('div')), 30);
    const done = waitForViewportRender(feed, () => false);
    await vi.advanceTimersByTimeAsync(1040);
    await done;
    clearInterval(mutations);
    let cancelled = false;
    const pending = waitForViewportRender(feed, () => cancelled);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(40);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
