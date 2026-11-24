/** @vitest-environment jsdom */
/**
 * Tests edgeNavigation functionality including column-reverse edge math, top-band detection, and retry settle loops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelAbsoluteEdgeJump, executeAbsoluteEdgeJump } from '@/navigation/jump/edgeNavigation';
import { getActivePlatform } from '@/platforms';

describe('edgeNavigation', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, host: 'chatgpt.com' },
      writable: true,
    });
    document.body.innerHTML = '';

    container = document.createElement('div');
    Object.defineProperty(container, 'scrollHeight', {
      value: 2000,
      configurable: true,
    });
    Object.defineProperty(container, 'clientHeight', {
      value: 800,
      configurable: true,
    });
    container.scrollTop = 500;
    document.body.appendChild(container);
  });

  afterEach(() => {
    cancelAbsoluteEdgeJump();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('executeAbsoluteEdgeJump', () => {
    it('scrolls to 0 on standard layout top jump', () => {
      container.style.flexDirection = 'column';

      executeAbsoluteEdgeJump('top', { container });
      expect(container.scrollTop).toBe(0);
    });

    it('scrolls to maxScrollTop on standard layout bottom jump', () => {
      container.style.flexDirection = 'column';

      executeAbsoluteEdgeJump('bottom', { container });
      expect(container.scrollTop).toBe(1200); // 2000 - 800
    });

    it('uses the host scroll controller so a delayed compensation sees the new bottom', async () => {
      container.style.flexDirection = 'column';
      let hostDistance = 700;
      const native = vi.spyOn(getActivePlatform().navigation, 'scrollToPosition').mockImplementation((element, top) => {
        element.scrollTop = top;
        hostDistance = element.scrollHeight - element.clientHeight - top;
        return true;
      });

      executeAbsoluteEdgeJump('bottom', { container });
      expect(native).toHaveBeenCalledWith(container, 1200);
      expect(hostDistance).toBe(0);
      container.scrollTop = container.scrollHeight - container.clientHeight - hostDistance;
      await vi.advanceTimersByTimeAsync(1600);
      expect(container.scrollTop).toBe(1200);
      expect(native).toHaveBeenCalledTimes(1);
    });

    it('does not fight a host that displaces the physical fallback', async () => {
      container.style.flexDirection = 'column';
      const native = vi.spyOn(getActivePlatform().navigation, 'scrollToPosition').mockImplementation((element, top) => {
        element.scrollTop = top;
        return true;
      });
      executeAbsoluteEdgeJump('bottom', { container });
      for (let i = 0; i < 3; i++) {
        container.scrollTop = 900;
        await vi.advanceTimersByTimeAsync(1500);
      }
      await vi.advanceTimersByTimeAsync(10000);
      expect(native).toHaveBeenCalledTimes(1);
      expect(container.scrollTop).toBe(900);
    });

    it('navigates to the final turn before scrolling to the actual bottom', async () => {
      const cancel = vi.fn();
      let finish!: (value: 'found') => void;
      const native = vi.spyOn(getActivePlatform().navigation, 'navigateToMessage').mockReturnValue({
        cancel, finished: new Promise(resolve => { finish = resolve; }),
      });
      const physical = vi.spyOn(getActivePlatform().navigation, 'scrollToPosition');
      executeAbsoluteEdgeJump('bottom', { container, lastPromptId: 'last-user-message' });
      expect(native).toHaveBeenCalledExactlyOnceWith(container, 'last-user-message', 'bottom');
      expect(container.scrollTop).toBe(500);
      expect(physical).not.toHaveBeenCalled();
      finish('found'); await Promise.resolve();
    });

    it('cancels the final-turn request when another navigation begins', () => {
      const cancel = vi.fn();
      vi.spyOn(getActivePlatform().navigation, 'navigateToMessage').mockReturnValue({
        cancel, finished: new Promise(() => {}),
      });
      executeAbsoluteEdgeJump('bottom', { container, lastPromptId: 'last-user-message' });
      cancelAbsoluteEdgeJump();
      expect(cancel).toHaveBeenCalledOnce();
    });

    it('scrolls to -maxScrollTop on column-reverse layout top jump', () => {
      container.style.flexDirection = 'column-reverse';

      executeAbsoluteEdgeJump('top', { container });
      expect(container.scrollTop).toBe(-1200); // -(2000 - 800)
    });

    it('scrolls to 0 on column-reverse layout bottom jump', () => {
      container.style.flexDirection = 'column-reverse';

      executeAbsoluteEdgeJump('bottom', { container });
      expect(container.scrollTop).toBe(0);
    });

    it('cancels loop immediately when isCancelled returns true', async () => {
      container.style.flexDirection = 'column';
      let cancelled = false;

      executeAbsoluteEdgeJump('top', {
        container,
        isCancelled: () => cancelled,
      });

      expect(container.scrollTop).toBe(0);
      cancelled = true;

      await vi.advanceTimersByTimeAsync(1600);
      // Loop should have exited without further actions
    });

    it('notifies onFirstPromptVisible when first prompt reaches top band (within 200px of container top)', async () => {
      container.style.flexDirection = 'column';
      const promptEl = document.createElement('div');
      promptEl.setAttribute('data-chatgpt-search-unit-key', 'first-msg:user');
      promptEl.setAttribute('data-chatgpt-search-message-ids', 'first-msg');
      document.body.appendChild(promptEl);

      container.getBoundingClientRect = vi.fn(
        () => ({ top: 100, bottom: 900 } as DOMRect)
      );
      promptEl.getBoundingClientRect = vi.fn(
        () => ({ top: 120, bottom: 200 } as DOMRect)
      );

      const onFirstPromptVisible = vi.fn();

      executeAbsoluteEdgeJump('top', {
        container,
        firstPromptId: 'first-msg',
        onFirstPromptVisible,
      });

      await vi.advanceTimersByTimeAsync(1600);

      expect(onFirstPromptVisible).toHaveBeenCalledWith(promptEl);
    });

    it('does not notify onFirstPromptVisible when first prompt is outside the top band (> 200px)', async () => {
      container.style.flexDirection = 'column';
      const promptEl = document.createElement('div');
      promptEl.setAttribute('data-chatgpt-search-unit-key', 'first-msg:user');
      promptEl.setAttribute('data-chatgpt-search-message-ids', 'first-msg');
      document.body.appendChild(promptEl);

      container.getBoundingClientRect = vi.fn(
        () => ({ top: 100, bottom: 900 } as DOMRect)
      );
      promptEl.getBoundingClientRect = vi.fn(
        () => ({ top: 400, bottom: 500 } as DOMRect) // 300px > 200px
      );

      const onFirstPromptVisible = vi.fn();

      executeAbsoluteEdgeJump('top', {
        container,
        firstPromptId: 'first-msg',
        onFirstPromptVisible,
      });

      await vi.advanceTimersByTimeAsync(1600);

      expect(onFirstPromptVisible).not.toHaveBeenCalled();
    });

    it('does not notify onFirstPromptVisible when first prompt is not mounted', async () => {
      container.style.flexDirection = 'column';
      const onFirstPromptVisible = vi.fn();

      executeAbsoluteEdgeJump('top', {
        container,
        firstPromptId: 'missing-msg',
        onFirstPromptVisible,
      });

      await vi.advanceTimersByTimeAsync(1600);

      expect(onFirstPromptVisible).not.toHaveBeenCalled();
    });

    it('settles cleanly on column-reverse bottom jump when scrollTop reaches 0', async () => {
      container.style.flexDirection = 'column-reverse';

      executeAbsoluteEdgeJump('bottom', { container });
      expect(container.scrollTop).toBe(0);

      await vi.advanceTimersByTimeAsync(1600);
      expect(container.scrollTop).toBe(0);
    });

    it('does not repeatedly pull back a displaced bottom in column-reverse layout', async () => {
      container.style.flexDirection = 'column-reverse';

      executeAbsoluteEdgeJump('bottom', { container });
      expect(container.scrollTop).toBe(0);

      // Virtualizer or scroll-anchoring shifts scrollTop away from 0 during settle
      container.scrollTop = -300;

      await vi.advanceTimersByTimeAsync(1600);
      expect(container.scrollTop).toBe(-300);
      await vi.advanceTimersByTimeAsync(1600);
      expect(container.scrollTop).toBe(-300);
    });


    it('does not pull the user back to the bottom after an upward wheel gesture', async () => {
      container.style.flexDirection = 'column';
      executeAbsoluteEdgeJump('bottom', { container });
      expect(container.scrollTop).toBe(1200);

      container.scrollTop = 850;
      container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
      await vi.advanceTimersByTimeAsync(3100);
      expect(container.scrollTop).toBe(850);
    });

    it('does not pull the user back in column-reverse after wheel input', async () => {
      container.style.flexDirection = 'column-reverse';
      executeAbsoluteEdgeJump('bottom', { container });
      expect(container.scrollTop).toBe(0);

      container.scrollTop = -350;
      container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
      await vi.advanceTimersByTimeAsync(3100);
      expect(container.scrollTop).toBe(-350);
    });

    it('cancels top-edge retries on a touch gesture', async () => {
      container.style.flexDirection = 'column';
      let height = 2000;
      Object.defineProperty(container, 'scrollHeight', {
        get: () => height,
        configurable: true,
      });
      executeAbsoluteEdgeJump('top', { container });
      expect(container.scrollTop).toBe(0);

      height = 2200; // Normally triggers another top-edge assertion.
      container.scrollTop = 250;
      container.dispatchEvent(new Event('touchmove', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(3100);
      expect(container.scrollTop).toBe(250);
    });

    it('cancels on a keyboard scroll gesture outside editable controls', async () => {
      container.style.flexDirection = 'column';
      executeAbsoluteEdgeJump('bottom', { container });
      container.scrollTop = 750;
      document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp' }));
      await vi.advanceTimersByTimeAsync(1600);
      expect(container.scrollTop).toBe(750);
    });

    it('does not repeat a fallback physical write after host scroll changes', async () => {
      container.style.flexDirection = 'column';
      executeAbsoluteEdgeJump('bottom', { container });
      container.scrollTop = 900;
      container.dispatchEvent(new Event('scroll'));
      document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
      await vi.advanceTimersByTimeAsync(1600);
      expect(container.scrollTop).toBe(900);
    });

    it('removes interruption listeners when the jump settles', async () => {
      container.style.flexDirection = 'column';
      const removeSpy = vi.spyOn(container, 'removeEventListener');
      executeAbsoluteEdgeJump('bottom', { container });
      await vi.advanceTimersByTimeAsync(1600);
      expect(removeSpy).toHaveBeenCalledWith('wheel', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('touchmove', expect.any(Function));
      removeSpy.mockRestore();
    });

    it('does not oscillate after a host displacement in standard layout', async () => {
      container.style.flexDirection = 'column';

      executeAbsoluteEdgeJump('bottom', { container });
      expect(container.scrollTop).toBe(1200);

      // Displaced during settle delay
      container.scrollTop = 900;

      await vi.advanceTimersByTimeAsync(1600);
      expect(container.scrollTop).toBe(900);
      await vi.advanceTimersByTimeAsync(1600);
      expect(container.scrollTop).toBe(900);
    });
  });
});
