/** @vitest-environment jsdom */
import { act, createContext, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findNativeMessageNavigation, type NativeTurnList } from '@/pageHook/nativeMessageNavigation';
import { installChatGptNativeScrollBridge, type ThreadScrollController } from '@/pageHook/nativeScrollBridge';
import { navigateChatGptMessageNatively } from '@/platforms/chatgpt/nativeScrollClient';

const rows = Array.from({ length: 120 }, (_, index) => ({
  turnKey: `turn-${index}`, turn: { messageIds: [`message-${index}`] },
}));
let feed: HTMLDivElement;
let root: Root;
let dispose: () => void;
let api: NativeTurnList;
let controller: ThreadScrollController;
let pending: Array<{ key: string; signal: AbortSignal; complete(): void }>;
let cachedDistance: number;

function VirtualRows(_props: { rows: typeof rows; getRowKey: (row: typeof rows[number]) => string }) {
  return <div data-turn-key="turn-119" />;
}
function SnapshotOwner() {
  // The real host keeps the list API in an external-store hook snapshot.
  useSyncExternalStore(() => () => {}, () => api);
  return <VirtualRows rows={rows} getRowKey={row => row.turnKey} />;
}

beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  pending = []; cachedDistance = 0;
  api = {
    getRowElement: key => feed.querySelector(`[data-turn-key="${key}"]`),
    getEntryGeometry: () => ({ startPx: 0, endPx: 100 }),
    scrollToKey: vi.fn((key, target, { signal }) => new Promise<void>(resolve => {
      pending.push({ key, signal, complete: () => {
        if (signal.aborted) return;
        feed.querySelector(`[data-turn-key="${key}"]`)?.remove();
        const row = document.createElement('div'); row.dataset.turnKey = key;
        feed.scrollTop = 4990; // Host align:'top' landing before LunaTOC's safety-offset correction.
        const prompt = document.createElement('div');
        prompt.setAttribute('data-chatgpt-search-unit-key', `${key}:user`);
        prompt.setAttribute('data-chatgpt-search-message-ids', rows.find(row => row.turnKey === key)!.turn.messageIds.join(' '));
        prompt.getBoundingClientRect = () => ({ top: 5000 - feed.scrollTop, bottom: 5050 - feed.scrollTop, height: 50 } as DOMRect);
        row.append(prompt); feed.append(row);
        expect(target(row)).toBe(prompt);
        resolve();
      } });
    })),
  };
  controller = {
    getScrollElement: () => feed, getLastScrollDistanceFromBottomPx: () => cachedDistance,
    holdViewport: vi.fn(),
    scrollToDistanceFromBottomPx: vi.fn(distance => {
      feed.scrollTop = feed.scrollHeight - feed.clientHeight - distance;
      cachedDistance = distance;
    }),
  };
  const Context = createContext(controller);
  const host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Context.Provider value={controller}>
    <div className="thread-scroll-container" ref={element => { if (element) feed = element; }}><SnapshotOwner /></div>
  </Context.Provider>));
  feed.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 } as DOMRect);
  Object.defineProperties(feed, {
    clientHeight: { value: 600, configurable: true },
    scrollHeight: { value: 50000, configurable: true },
  });
  feed.scrollTo = vi.fn();
  dispose = installChatGptNativeScrollBridge();
});
afterEach(async () => {
  dispose(); await act(async () => root.unmount()); document.body.replaceChildren();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('semantic native message navigation', () => {
  it('presents a legacy native landing immediately without waiting for a snapshot or verification window', async () => {
    const snapshot = vi.fn(); Object.defineProperty(feed, 'startViewTransition', { value: snapshot });
    const navigation = navigateChatGptMessageNatively(feed, 'message-4')!;
    const verified = vi.fn(); void navigation.finished.then(verified);
    expect(api.scrollToKey).toHaveBeenCalledOnce();
    pending[0].complete(); await vi.advanceTimersByTimeAsync(0);
    expect(await navigation.ready).toBe(true);
    expect(feed.scrollTop).toBe(4900);
    expect(feed.querySelector('[data-chatgpt-search-message-ids="message-4"]')?.getBoundingClientRect().top).toBe(100);
    expect(snapshot).not.toHaveBeenCalled(); expect(verified).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1300);
    expect(await navigation.finished).toBe('found');
  });

  it('uses the instant anchor through both worlds and stops late compensation before a wrong physical write', async () => {
    const layout = document.createElement('div'); layout.style.height = '50000px';
    const flow = document.createElement('div'), wrapper = document.createElement('div');
    wrapper.setAttribute('data-virtualized-turn', '');
    const seed = document.createElement('div'); seed.dataset.turnKey = 'turn-118';
    wrapper.append(seed); flow.append(wrapper); layout.append(flow); feed.append(layout);
    layout.getBoundingClientRect = () => ({ top: -feed.scrollTop, height: 50000 } as DOMRect);
    const row = document.createElement('div'); row.dataset.turnKey = 'turn-4';
    const prompt = document.createElement('div');
    prompt.setAttribute('data-chatgpt-search-unit-key', 'turn-4:user');
    prompt.setAttribute('data-chatgpt-search-message-ids', 'message-4');
    row.getBoundingClientRect = () => ({ top: 5000 - feed.scrollTop, height: 1000 } as DOMRect);
    prompt.getBoundingClientRect = () => ({ top: 5000 - feed.scrollTop, bottom: 5050 - feed.scrollTop, height: 50 } as DOMRect);
    row.append(prompt); flow.append(row);
    const positions: number[] = [];
    controller.scrollToDistanceFromBottomPx = vi.fn(distance => { feed.scrollTop = 49400 - distance; positions.push(feed.scrollTop); });
    controller.getLastScrollDistanceFromBottomPx = () => 49400 - feed.scrollTop;
    const compensate = vi.fn((distance: number) => { feed.scrollTop = 49400 - distance; positions.push(feed.scrollTop); });
    const owned = Object.assign(controller, { compensateScrollToDistanceFromBottomPx: compensate });
    const snapshot = vi.fn(); Object.defineProperty(feed, 'startViewTransition', { value: snapshot });
    const navigation = navigateChatGptMessageNatively(feed, 'message-4')!;
    expect(feed.scrollTop).toBe(4880); // No time or frame has advanced.
    expect(await navigation.ready).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(await navigation.finished).toBe('found');
    owned.compensateScrollToDistanceFromBottomPx(100);
    expect(positions).toEqual([4900, 4900]); expect(compensate).not.toHaveBeenCalled();
    expect(api.scrollToKey).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled();
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    expect(owned.compensateScrollToDistanceFromBottomPx).toBe(compensate);
  });

  it('discovers an unmounted message in the actual React snapshot and row props', () => {
    expect(findNativeMessageNavigation(feed, 'message-4')).toEqual({ api, turnKey: 'turn-4' });
    expect(feed.querySelector('[data-turn-key="turn-4"]')).toBeNull();
    expect(findNativeMessageNavigation(feed, 'unknown')).toBeNull();
  });

  it('hands off repeated jumps beyond the mounted window without DOM scroll writes', async () => {
    for (const index of [0, 1, 2, 3, 4, 95, 93, 101, 98, 96]) {
      const navigation = navigateChatGptMessageNatively(feed, `message-${index}`);
      expect(navigation).not.toBeNull();
      const call = pending.at(-1)!;
      expect(call.key).toBe(`turn-${index}`);
      // Completion may take several render/measurement passes.
      await vi.advanceTimersByTimeAsync(1200);
      call.complete(); await vi.advanceTimersByTimeAsync(2001);
      expect(await navigation!.finished).toBe('found');
    }
    expect(feed.scrollTo).not.toHaveBeenCalled();
  });

  it('cancels the old native render request before a rapid replacement', async () => {
    const first = navigateChatGptMessageNatively(feed, 'message-4')!;
    first.cancel();
    const second = navigateChatGptMessageNatively(feed, 'message-95')!;
    expect(pending[0].signal.aborted).toBe(true);
    pending[0].complete(); pending[1].complete();
    await vi.advanceTimersByTimeAsync(2001);
    expect(await first.finished).toBe('cancelled');
    expect(await second.finished).toBe('found');
  });

  it('releases the native render pin on manual wheel input and on timeout', async () => {
    const first = navigateChatGptMessageNatively(feed, 'message-4')!;
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 30 }));
    expect(await first.finished).toBe('cancelled');
    expect(pending[0].signal.aborted).toBe(true);
    const second = navigateChatGptMessageNatively(feed, 'message-95')!;
    await vi.advanceTimersByTimeAsync(15000);
    expect(await second.finished).toBe('failed');
    expect(pending[1].signal.aborted).toBe(true);
  });

  it('finishes a stable landing sooner while still catching eviction near the end of the shorter watch', async () => {
    const first = navigateChatGptMessageNatively(feed, 'message-4')!;
    pending[0].complete(); await vi.advanceTimersByTimeAsync(1300);
    expect(await first.finished).toBe('found');
    const second = navigateChatGptMessageNatively(feed, 'message-95')!;
    const finished = vi.fn(); void second.finished.then(finished);
    pending[1].complete(); await vi.advanceTimersByTimeAsync(1100);
    expect(finished).not.toHaveBeenCalled();
    feed.querySelector('[data-turn-key="turn-95"]')!.remove();
    await vi.advanceTimersByTimeAsync(600);
    expect(pending).toHaveLength(3);
    expect(finished).not.toHaveBeenCalled();
    pending[2].complete(); await vi.advanceTimersByTimeAsync(800);
    expect(await second.finished).toBe('found');
  });

  it('recovers the D7 late-eviction pattern with a second semantic pass, without pixel writes', async () => {
    const navigation = navigateChatGptMessageNatively(feed, 'message-4')!;
    const completed = vi.fn(); void navigation.finished.then(completed);
    pending[0].complete(); await vi.advanceTimersByTimeAsync(1000);
    expect(completed).not.toHaveBeenCalled();
    feed.querySelector('[data-turn-key="turn-4"]')!.remove();
    Object.defineProperty(feed, 'scrollHeight', { value: 56000, configurable: true });
    await vi.advanceTimersByTimeAsync(200);
    Object.defineProperty(feed, 'scrollHeight', { value: 62000, configurable: true });
    await vi.advanceTimersByTimeAsync(200);
    Object.defineProperty(feed, 'scrollHeight', { value: 68000, configurable: true });
    await vi.advanceTimersByTimeAsync(200);
    Object.defineProperty(feed, 'scrollHeight', { value: 74000, configurable: true });
    await vi.advanceTimersByTimeAsync(700);
    expect(pending).toHaveLength(2);
    expect(completed).not.toHaveBeenCalled();
    pending[1].complete(); await vi.advanceTimersByTimeAsync(800);
    expect(await navigation.finished).toBe('found');
    expect(api.scrollToKey).toHaveBeenCalledTimes(2);
    expect(controller.holdViewport).toHaveBeenCalledTimes(2);
    expect(feed.scrollTo).not.toHaveBeenCalled();
  });

  it('reacquires a visible target whose top drifted into the preceding answer', async () => {
    const navigation = navigateChatGptMessageNatively(feed, 'message-4')!;
    pending[0].complete(); await vi.advanceTimersByTimeAsync(200);
    const prompt = feed.querySelector<HTMLElement>('[data-chatgpt-search-message-ids="message-4"]')!;
    prompt.getBoundingClientRect = () => ({ top: 400, bottom: 450, height: 50 } as DOMRect);
    const completed = vi.fn(); void navigation.finished.then(completed);
    await vi.advanceTimersByTimeAsync(700);
    expect(pending).toHaveLength(2);
    expect(completed).not.toHaveBeenCalled();
    pending[1].complete(); await vi.advanceTimersByTimeAsync(1200);
    expect(await navigation.finished).toBe('found');
  });

  it('stops reacquisition after manual input during the measurement watch', async () => {
    const navigation = navigateChatGptMessageNatively(feed, 'message-4')!;
    pending[0].complete(); await vi.advanceTimersByTimeAsync(700);
    expect(await navigation.ready).toBe(true);
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 30 }));
    expect(await navigation.finished).toBe('cancelled');
    feed.querySelector('[data-turn-key="turn-4"]')!.remove();
    await vi.advanceTimersByTimeAsync(3000);
    expect(pending).toHaveLength(1);
  });

  it('reports failure after bounded reacquisition when every host completion loses the target', async () => {
    const navigation = navigateChatGptMessageNatively(feed, 'message-4')!;
    for (let attempt = 0; attempt < 3; attempt++) {
      pending[attempt].complete(); await vi.advanceTimersByTimeAsync(100);
      feed.querySelector('[data-turn-key="turn-4"]')!.remove();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(await navigation.finished).toBe('failed');
    expect(pending).toHaveLength(3);
  });

  it('rejects an API that belongs to a different conversation feed', () => {
    api.getRowElement = () => document.createElement('div');
    expect(navigateChatGptMessageNatively(feed, 'message-4')).toBeNull();
    expect(api.scrollToKey).not.toHaveBeenCalled();
  });
});
