/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createInstantMessageNavigation, type InstantMessageNavigation } from '@/pageHook/instantMessageNavigation';
import type { NativeTurnList } from '@/pageHook/nativeMessageNavigation';
import type { ThreadScrollController } from '@/pageHook/nativeScrollBridge';

type Controller = ThreadScrollController & { compensateScrollToDistanceFromBottomPx(distance: number, cause?: unknown): void };
let feed: HTMLDivElement, layout: HTMLDivElement, row: HTMLDivElement, prompt: HTMLDivElement;
let controller: Controller, api: NativeTurnList, abort: AbortController, lease: InstantMessageNavigation | null;
let position: number, range: number, cached: number;
let physicalWrites: number[], paintOffsets: number[];
let originalCompensate: Controller['compensateScrollToDistanceFromBottomPx'];
let originalScroll: Controller['scrollToDistanceFromBottomPx'];
const onReady = vi.fn();
const rect = (top: number, height = 100) => ({ top, bottom: top + height, height } as DOMRect);

beforeEach(() => {
  vi.useFakeTimers(); onReady.mockClear(); lease = null;
  position = 5000; range = 19400; cached = range;
  physicalWrites = []; paintOffsets = []; abort = new AbortController();
  feed = document.createElement('div'); document.body.append(feed);
  layout = document.createElement('div'); layout.style.height = '20000px';
  const flow = document.createElement('div'), wrapper = document.createElement('div'), seed = document.createElement('div');
  seed.dataset.turnKey = 'seed'; wrapper.setAttribute('data-virtualized-turn', '');
  wrapper.append(seed); flow.append(wrapper); layout.append(flow); feed.append(layout);
  row = document.createElement('div'); row.dataset.turnKey = 'target';
  prompt = document.createElement('div');
  prompt.setAttribute('data-chatgpt-search-message-ids', 'message');
  prompt.setAttribute('data-chatgpt-search-unit-key', 'target:user');
  row.append(prompt); flow.append(row);
  feed.getBoundingClientRect = () => rect(0, 600);
  layout.getBoundingClientRect = () => rect(-feed.scrollTop, range + 600);
  row.getBoundingClientRect = () => rect(position - feed.scrollTop, 1000);
  prompt.getBoundingClientRect = () => rect(position + 20 - feed.scrollTop, 50);
  Object.defineProperties(feed, { clientHeight: { value: 600 }, scrollHeight: { get: () => range + 600 } });
  const physicalScroll = (distance: number) => {
    feed.scrollTop = range - distance; cached = distance;
    physicalWrites.push(feed.scrollTop);
    // Model the native cache listener updating the virtual window immediately.
    if (Math.abs(position - feed.scrollTop) < 1800) flow.append(row);
    else row.remove();
    paintOffsets.push(prompt.isConnected ? prompt.getBoundingClientRect().top : Infinity);
  };
  controller = {
    getScrollElement: () => feed, getLastScrollDistanceFromBottomPx: () => cached,
    holdViewport: vi.fn(), scrollToDistanceFromBottomPx: vi.fn(physicalScroll),
    compensateScrollToDistanceFromBottomPx: vi.fn(physicalScroll),
  };
  originalCompensate = controller.compensateScrollToDistanceFromBottomPx;
  originalScroll = controller.scrollToDistanceFromBottomPx;
  api = {
    getRowElement: key => key === 'seed' ? seed : row.isConnected ? row : null,
    getEntryGeometry: () => ({ startPx: position, endPx: position + 1000 }),
    scrollToKey: vi.fn(async (_key, target, { signal }) => {
      if (signal.aborted) return;
      flow.append(row); expect(target(row)).toBe(prompt);
      controller.scrollToDistanceFromBottomPx(range - position - 10, 'instant', 'user');
    }),
  };
});
afterEach(() => { lease?.dispose(); abort.abort(); vi.clearAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); });
function start() {
  lease = createInstantMessageNavigation({ container: feed, controller, api, turnKey: 'target',
    messageId: 'message', edge: 'top', signal: abort.signal, onReady });
  return lease!.run();
}

it('moves a mounted target synchronously with one native write and no animation or timer', async () => {
  const done = start();
  expect(feed.scrollTop).toBe(5010); // Before advancing any frame or awaiting the Promise.
  expect(physicalWrites).toEqual([5010]);
  expect(await done).toBe(true); expect(vi.getTimerCount()).toBe(0);
  expect(api.scrollToKey).not.toHaveBeenCalled();
  expect(onReady).toHaveBeenCalledOnce();
});

it('does not move or wait when the mounted message is already aligned', async () => {
  feed.scrollTop = 5010; cached = range - feed.scrollTop;
  expect(await start()).toBe(true);
  expect(physicalWrites).toEqual([]); expect(vi.getTimerCount()).toBe(0);
});

it('performs one semantic mount for an absent target and presents it without a fixed stability wait', async () => {
  row.remove(); const done = start();
  await Promise.resolve();
  expect(await done).toBe(true);
  expect(api.scrollToKey).toHaveBeenCalledOnce();
  expect(physicalWrites).toEqual([5010]); expect(paintOffsets).toEqual([10]);
  expect(vi.getTimerCount()).toBe(0);
  feed.dispatchEvent(new Event('scroll')); // Delivered after native completion.
  controller.compensateScrollToDistanceFromBottomPx(100, 'turn-resize');
  expect(originalCompensate).not.toHaveBeenCalled();
  expect(physicalWrites).toEqual([5010, 5010]);
});

it('rebases the late-compensation proposal before it can move the viewport or evict the target', async () => {
  expect(await start()).toBe(true);
  const oldDistance = cached;
  range += 4284;
  // D14 pattern: total height grows while the old cached distance is proposed.
  // Applying it first would move top from 5010 to 9294 and evict the target.
  controller.compensateScrollToDistanceFromBottomPx(oldDistance, 'turn-resize');
  expect(originalCompensate).not.toHaveBeenCalled();
  expect(physicalWrites).toEqual([5010, 5010]); expect(paintOffsets).toEqual([10, 10]);
  expect(row.isConnected).toBe(true);
  expect(cached).toBe(range - 5010);
  await vi.advanceTimersByTimeAsync(3000);
  expect(api.scrollToKey).not.toHaveBeenCalled();
  expect(physicalWrites).toEqual([5010, 5010]); // No delayed semantic recovery.
});

it('preserves the prompt screen coordinate when content above it grows', async () => {
  await start(); position += 350; range += 350;
  controller.compensateScrollToDistanceFromBottomPx(100, 'turn-resize');
  expect(physicalWrites).toEqual([5010, 5360]); expect(paintOffsets).toEqual([10, 10]);
  expect(originalCompensate).not.toHaveBeenCalled();
});

it('uses current semantic geometry to restore a row removed by a stale render window', async () => {
  await start(); row.remove();
  controller.compensateScrollToDistanceFromBottomPx(100, 'turn-resize');
  expect(row.isConnected).toBe(true);
  expect(physicalWrites).toEqual([5010, 5010]); expect(paintOffsets).toEqual([10, 10]);
  expect(api.scrollToKey).not.toHaveBeenCalled();
});

it('corrects DOM layout changes in the observer checkpoint without a delayed retry', async () => {
  await start(); position += 300; range += 300;
  layout.style.height = `${range + 600}px`;
  await Promise.resolve();
  expect(physicalWrites).toEqual([5010, 5310]); expect(prompt.getBoundingClientRect().top).toBe(10);
});

it('restores both native methods on manual input and permits the host to scroll normally', async () => {
  await start(); window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
  expect(controller.compensateScrollToDistanceFromBottomPx).toBe(originalCompensate);
  expect(controller.scrollToDistanceFromBottomPx).toBe(originalScroll);
  controller.compensateScrollToDistanceFromBottomPx(range - 9000);
  expect(feed.scrollTop).toBe(9000);
  layout.style.height = '21000px'; await Promise.resolve();
  expect(feed.scrollTop).toBe(9000);
});

it('yields to another native navigation and to a direct browser scroll', async () => {
  await start(); controller.scrollToDistanceFromBottomPx(range - 9000, 'instant', 'user');
  expect(feed.scrollTop).toBe(9000);
  expect(controller.compensateScrollToDistanceFromBottomPx).toBe(originalCompensate);
  row.parentElement?.append(row); // A new mounted click can establish a new lease.
  feed.append(row); await start();
  feed.scrollTop += 300; feed.dispatchEvent(new Event('scroll'));
  expect(controller.compensateScrollToDistanceFromBottomPx).toBe(originalCompensate);
});

it('restores the descriptors on abort without replacing an unrelated later wrapper', async () => {
  await start(); const other = vi.fn(); controller.scrollToDistanceFromBottomPx = other;
  abort.abort();
  expect(controller.compensateScrollToDistanceFromBottomPx).toBe(originalCompensate);
  expect(controller.scrollToDistanceFromBottomPx).toBe(other);
});

it('rejects unowned or unsupported controllers without changing methods', () => {
  layout.style.height = '';
  expect(createInstantMessageNavigation({ container: feed, controller, api, turnKey: 'target', messageId: 'message',
    edge: 'top', signal: abort.signal, onReady })).toBeNull();
  expect(controller.compensateScrollToDistanceFromBottomPx).toBe(originalCompensate);
});

it('aborts an unfinished native mount when the user takes over, even if its Promise never completes', async () => {
  row.remove(); let nativeSignal!: AbortSignal;
  api.scrollToKey = vi.fn((_key, _target, { signal }) => {
    nativeSignal = signal; return new Promise<void>(() => {});
  });
  const done = start();
  window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
  expect(await done).toBe(false); expect(nativeSignal.aborted).toBe(true);
  expect(controller.compensateScrollToDistanceFromBottomPx).toBe(originalCompensate);
  expect(vi.getTimerCount()).toBe(0); expect(physicalWrites).toEqual([]);
});

it('rejects a mismatched cache and releases the lease instead of declaring a stable landing', async () => {
  controller.getLastScrollDistanceFromBottomPx = () => -1;
  expect(await start()).toBe(false);
  expect(controller.compensateScrollToDistanceFromBottomPx).toBe(originalCompensate);
  expect(controller.scrollToDistanceFromBottomPx).toBe(originalScroll);
  expect(onReady).not.toHaveBeenCalled();
});
