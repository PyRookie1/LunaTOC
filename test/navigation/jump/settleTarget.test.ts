/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleTarget } from '@/navigation/jump/settleTarget';
vi.mock('@/platforms', () => ({
  getActivePlatform: () => ({ navigation: { promptScrollMarginTopPx: 120 } }),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); });

function fixture() {
  const container = document.createElement('div');
  const target = document.createElement('div');
  Object.defineProperties(container, { clientHeight: { value: 600 }, scrollHeight: { value: 3000 } });
  container.getBoundingClientRect = () => ({ top: 100, bottom: 700 } as DOMRect);
  target.getBoundingClientRect = () => ({ top: 500 - container.scrollTop, bottom: 550 - container.scrollTop, height: 50 } as DOMRect);
  container.append(target);
  document.body.append(container);
  const onSettled = vi.fn();
  const onInterrupted = vi.fn();
  const options = { container, resolveTarget: () => target, edge: 'top' as const, topOffset: 16, isCancelled: () => false, onSettled, onInterrupted };
  return { container, target, options, onSettled, onInterrupted };
}

describe('landing settlement', () => {
  it('sets scroll-margin-top and lands below the ChatGPT top fade', () => {
    const { container, target, options } = fixture();
    settleTarget(options);
    expect(target.style.scrollMarginTop).toBe('120px');
    expect(container.scrollTop).toBe(280);
  });

  it.each(['wheel', 'touchstart', 'pointerdown'])('stops correcting immediately on %s', (type) => {
    const { container, options, onSettled, onInterrupted } = fixture();
    settleTarget(options);
    container.dispatchEvent(new Event(type));
    container.scrollTop = 900;
    vi.advanceTimersByTime(2000);
    expect(container.scrollTop).toBe(900);
    expect(onInterrupted).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('cancels on a scroll key but leaves typing alone', () => {
    const { container, options, onInterrupted } = fixture();
    const input = document.createElement('textarea');
    document.body.append(input);
    settleTarget(options);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(onInterrupted).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }));
    container.scrollTop = 900;
    vi.advanceTimersByTime(2000);
    expect(container.scrollTop).toBe(900);
    expect(onInterrupted).toHaveBeenCalledOnce();
  });

  it('does not write after a newer navigation cancels the landing', () => {
    const { container, options, onSettled } = fixture();
    let cancelled = false;
    settleTarget({ ...options, isCancelled: () => cancelled });
    cancelled = true;
    container.scrollTop = 1000;
    vi.advanceTimersByTime(2000);
    expect(container.scrollTop).toBe(1000);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('reports failure after its fixed budget when the host keeps overriding the position', () => {
    const { container, options, onSettled } = fixture();
    const host = setInterval(() => { container.scrollTop = 2400; }, 40);
    settleTarget(options);
    vi.advanceTimersByTime(1600);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false);
    clearInterval(host);
    container.scrollTop = 900;
    vi.advanceTimersByTime(2000);
    expect(container.scrollTop).toBe(900);
  });

  it('waits for a temporarily unmounted target', () => {
    const { target, options, onSettled } = fixture();
    let mounted = false;
    settleTarget({ ...options, resolveTarget: () => mounted ? target : null });
    vi.advanceTimersByTime(400);
    mounted = true;
    vi.advanceTimersByTime(1200);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('aligns the selected answer bottom using the feed height', () => {
    const { container, options, onSettled } = fixture();
    container.scrollTop = 100;
    settleTarget({ ...options, edge: 'bottom' });
    vi.advanceTimersByTime(1600);
    expect(container.scrollTop).toBe(0); // the answer fits at the physical top boundary
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
  });
});
