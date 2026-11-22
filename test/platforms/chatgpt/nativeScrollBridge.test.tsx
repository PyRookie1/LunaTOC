/** @vitest-environment jsdom */
import { act, createContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findThreadScrollController, installChatGptNativeScrollBridge, type ThreadScrollController } from '@/pageHook/nativeScrollBridge';
import { prepareChatGptNativeScroll, scrollChatGptNatively } from '@/platforms/chatgpt/nativeScrollClient';
import { scrollInstantly } from '@/navigation/jump/settleTarget';
vi.mock('@/platforms', () => ({ getActivePlatform: () => ({ navigation: { scrollToPosition: scrollChatGptNatively } }) }));

let root: Root;
let host: HTMLDivElement;
let feed: HTMLDivElement;
let dispose: () => void;
let cachedDistance: number;
let controller: ThreadScrollController;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  cachedDistance = 0;
  host = document.createElement('div'); document.body.append(host);
  controller = {
    getScrollElement: () => feed,
    getLastScrollDistanceFromBottomPx: () => cachedDistance,
    holdViewport: vi.fn(),
    scrollToDistanceFromBottomPx: vi.fn((distance: number) => {
      feed.scrollTop = feed.scrollHeight - feed.clientHeight - distance;
      cachedDistance = distance;
    }),
  };
  const Context = createContext<ThreadScrollController | null>(null);
  root = createRoot(host);
  await act(async () => root.render(
    <Context.Provider value={controller}>
      <div className="thread-scroll-container" ref={element => { if (element) feed = element; }} />
    </Context.Provider>
  ));
  Object.defineProperties(feed, { scrollHeight: { value: 3000, configurable: true }, clientHeight: { value: 600 } });
  feed.scrollTop = 2400;
  dispose = installChatGptNativeScrollBridge();
});
afterEach(async () => {
  dispose();
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('native thread scroll bridge', () => {
  it('finds the matching controller through real React provider fibers', () => {
    expect(findThreadScrollController(feed)).toBe(controller);
    const other = document.createElement('div');
    expect(findThreadScrollController(other)).toBeNull();
  });

  it('updates the cached virtualizer distance using user navigation, without a second DOM write', () => {
    const domScroll = vi.fn(); feed.scrollTo = domScroll;
    expect(prepareChatGptNativeScroll(feed)).toBe(true);
    expect(controller.holdViewport).toHaveBeenCalledOnce();
    scrollInstantly(feed, 200);
    expect(controller.scrollToDistanceFromBottomPx).toHaveBeenCalledWith(2200, 'instant', 'user');
    expect(feed.scrollTop).toBe(200);
    expect(cachedDistance).toBe(2200);
    expect(domScroll).not.toHaveBeenCalled();
  });

  it('keeps successive target positions after delayed compensation reads the cached distance', async () => {
    for (const top of [2100, 1700, 1300, 900, 500, 200]) {
      scrollInstantly(feed, top);
      setTimeout(() => { feed.scrollTop = feed.scrollHeight - feed.clientHeight - cachedDistance; }, 500);
      await vi.advanceTimersByTimeAsync(600);
      expect(feed.scrollTop).toBe(top);
    }
  });

  it('rejects a controller whose owner changed during an SPA transition', () => {
    const other = document.createElement('div');
    controller.getScrollElement = () => other;
    expect(scrollChatGptNatively(feed, 200)).toBe(false);
    expect(feed.scrollTop).toBe(2400);
  });

  it('maps a reverse-layout offset to a positive distance from the bottom', () => {
    feed.style.flexDirection = 'column-reverse';
    feed.scrollTop = 0;
    controller.scrollToDistanceFromBottomPx = vi.fn((distance: number) => {
      feed.scrollTop = -distance;
      cachedDistance = distance;
    });
    expect(scrollChatGptNatively(feed, -200)).toBe(true);
    expect(controller.scrollToDistanceFromBottomPx).toHaveBeenCalledWith(200, 'instant', 'user');
    expect(feed.scrollTop).toBe(-200);
  });

  it('does not report success for an API that leaves its internal distance stale', () => {
    controller.scrollToDistanceFromBottomPx = vi.fn(() => { feed.scrollTop = 200; });
    expect(scrollChatGptNatively(feed, 200)).toBe(false);
    expect(cachedDistance).toBe(0);
  });

  it('falls back to DOM scrolling when no native provider is available', () => {
    const unrelated = document.createElement('div'); unrelated.className = 'thread-scroll-container';
    document.body.append(unrelated);
    unrelated.scrollTo = vi.fn();
    scrollInstantly(unrelated, 300);
    expect(unrelated.scrollTo).toHaveBeenCalledWith({ top: 300, behavior: 'instant' });
  });
});
