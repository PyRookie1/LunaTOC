import { CHATGPT_PROMPT_TOP_OFFSET_PX, measureNativeMessageLanding } from '@/platforms/chatgpt/nativeMessageLanding';
import { findNativeMessageTarget, type NativeTurnList } from './nativeMessageNavigation';
import type { ThreadScrollController } from './nativeScrollBridge';

type CompensatingController = ThreadScrollController & {
  compensateScrollToDistanceFromBottomPx(distance: number, cause?: unknown): void;
};
export interface InstantMessageNavigation { run(): Promise<boolean>; dispose(): void }

function findLayoutRoot(container: HTMLElement, api: NativeTurnList): HTMLElement | null {
  for (const row of Array.from(container.querySelectorAll<HTMLElement>('[data-turn-key]')).slice(0, 40)) {
    const key = row.dataset.turnKey;
    if (!key || api.getRowElement(key) !== row) continue;
    const root = row.closest('[data-virtualized-turn]')?.parentElement?.parentElement;
    if (root && root !== container && container.contains(root) && parseFloat(root.style.height) > 0) return root;
  }
  return null;
}

/**
 * A TOC click establishes a semantic reading anchor. Rebase host compensation
 * before it writes pixels, rather than jumping back after the wrong write.
 * The lease belongs to this feed/controller and ends on the next user action.
 */
export function createInstantMessageNavigation(options: {
  container: HTMLElement; controller: ThreadScrollController; api: NativeTurnList;
  turnKey: string; messageId: string; edge: 'top' | 'bottom'; signal: AbortSignal;
  onReady(): void; onRelease?(): void;
}): InstantMessageNavigation | null {
  const { container, api, turnKey, messageId, edge, signal } = options;
  const controller = options.controller as CompensatingController;
  const compensation = Object.getOwnPropertyDescriptor(controller, 'compensateScrollToDistanceFromBottomPx');
  const scroll = Object.getOwnPropertyDescriptor(controller, 'scrollToDistanceFromBottomPx');
  if (edge !== 'top' || !container.isConnected || controller.getScrollElement() !== container ||
      getComputedStyle(container).flexDirection === 'column-reverse' ||
      typeof compensation?.value !== 'function' || !compensation.configurable ||
      typeof scroll?.value !== 'function' || !scroll.configurable) return null;
  const root = findLayoutRoot(container, api);
  if (!root) return null;

  let task: Promise<boolean> | null = null;
  let release = (): void => {};
  return {
    dispose: () => release(),
    run: () => task ??= new Promise<boolean>(resolve => {
      const nativeAbort = new AbortController();
      const nativeCompensate = controller.compensateScrollToDistanceFromBottomPx;
      const nativeScroll = controller.scrollToDistanceFromBottomPx;
      let released = false, finished = false, writing = false, armed = false, nativePending = false;
      let rowOffset = 0, lastTop = container.scrollTop, lastRange = container.scrollHeight - container.clientHeight;
      let observedRow: HTMLElement | null = null;
      let raf: number | null = null;
      let mutations: MutationObserver | null = null;
      let resize: ResizeObserver | null = null;
      const finish = (success: boolean): void => {
        if (finished) return;
        finished = true;
        resolve(success);
      };
      const releaseLease = (): void => {
        if (released) return;
        released = true;
        nativeAbort.abort();
        if (raf !== null) cancelAnimationFrame(raf);
        mutations?.disconnect(); resize?.disconnect();
        signal.removeEventListener('abort', abort);
        for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown']) window.removeEventListener(type, interrupt, true);
        container.removeEventListener('scroll', externalScroll);
        // Do not remove another participant's replacement.
        if (controller.compensateScrollToDistanceFromBottomPx === compensate) {
          try { Object.defineProperty(controller, 'compensateScrollToDistanceFromBottomPx', compensation); }
          catch { /* A frozen wrapper remains a released pass-through. */ }
        }
        if (controller.scrollToDistanceFromBottomPx === scrollTo) {
          try { Object.defineProperty(controller, 'scrollToDistanceFromBottomPx', scroll); }
          catch { /* A frozen wrapper remains a released pass-through. */ }
        }
        options.onRelease?.();
        finish(false);
      };
      release = () => releaseLease();
      const abort = (): void => releaseLease();
      const interrupt = (): void => releaseLease();
      const externalScroll = (): void => {
        // Programmatic browser/search scrolls must also be able to take over.
        const range = container.scrollHeight - container.clientHeight;
        if (!writing && armed && Math.abs(range - lastRange) <= 2 && Math.abs(container.scrollTop - lastTop) > 3) {
          releaseLease();
        }
      };
      const live = (): { row: HTMLElement; target: HTMLElement } | null => {
        const row = api.getRowElement(turnKey);
        const target = row && container.contains(row) ? findNativeMessageTarget(row, messageId, edge) : null;
        return row && target?.isConnected ? { row, target } : null;
      };
      const destination = (): number | null => {
        if (!container.isConnected || !root.isConnected || controller.getScrollElement() !== container) return null;
        const feed = container.getBoundingClientRect();
        const scale = container.offsetHeight > 0 ? feed.height / container.offsetHeight : 1;
        if (!Number.isFinite(scale) || scale <= 0 || container.clientHeight <= 0) return null;
        const current = live();
        let delta: number;
        if (current) {
          rowOffset = (current.target.getBoundingClientRect().top - current.row.getBoundingClientRect().top) / scale;
          delta = (current.target.getBoundingClientRect().top - feed.top) / scale - container.clientTop - CHATGPT_PROMPT_TOP_OFFSET_PX;
          if (observedRow !== current.row) {
            if (observedRow) resize?.unobserve(observedRow);
            observedRow = current.row; resize?.observe(current.row);
          }
        } else {
          const geometry = api.getEntryGeometry(turnKey) as { startPx?: unknown } | null;
          if (typeof geometry?.startPx !== 'number' || !Number.isFinite(geometry.startPx)) return null;
          delta = (root.getBoundingClientRect().top - feed.top) / scale + geometry.startPx + rowOffset - container.clientTop - CHATGPT_PROMPT_TOP_OFFSET_PX;
        }
        const range = Math.max(0, container.scrollHeight - container.clientHeight);
        return range - Math.max(0, Math.min(range, container.scrollTop + delta));
      };
      const write = (distance: number): void => {
        writing = true;
        try {
          // This updates the host cache and notifies its virtual-window listeners.
          nativeScroll.call(controller, distance, 'instant', 'user');
          lastTop = container.scrollTop; lastRange = container.scrollHeight - container.clientHeight;
          const cached = controller.getLastScrollDistanceFromBottomPx();
          if (!Number.isFinite(cached) || Math.abs(cached - Math.max(0, lastRange - lastTop)) > 2) {
            throw new Error('native-state-stale');
          }
        } finally { writing = false; }
      };
      function compensate(this: CompensatingController, distance: number, cause?: unknown): void {
        if (released || !armed) return nativeCompensate.call(this, distance, cause);
        if (writing) return;
        try {
          const anchored = destination();
          if (anchored === null) { releaseLease(); return nativeCompensate.call(this, distance, cause); }
          // Correct the proposal before any host scroll write. Do not first
          // apply the old-layout distance and then visibly undo that move.
          write(anchored);
        } catch { releaseLease(); nativeCompensate.call(this, distance, cause); }
      }
      function scrollTo(this: CompensatingController, ...args: Parameters<ThreadScrollController['scrollToDistanceFromBottomPx']>): void {
        const mounting = nativePending && !released;
        if (!writing && !nativePending) releaseLease();
        nativeScroll.apply(this, args);
        if (mounting) {
          // The browser delivers this native scroll event after the Promise
          // microtask. It is our mount, not a later external takeover.
          lastTop = container.scrollTop; lastRange = container.scrollHeight - container.clientHeight;
        }
      }
      const refresh = (): void => {
        if (released || writing || !armed) return;
        try {
          const distance = destination();
          if (distance === null) { releaseLease(); return; }
          const actual = Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop);
          if (Math.abs(distance - actual) > 1 || Math.abs(controller.getLastScrollDistanceFromBottomPx() - actual) > 2) {
            write(distance);
          }
          const current = live();
          if (!finished && !nativePending && measureNativeMessageLanding(container, current?.target ?? null).aligned) {
            options.onReady();
            finish(true);
          }
        } catch { releaseLease(); }
      };
      const awaitMounted = (): void => {
        raf = null;
        if (released || finished) return;
        refresh();
        if (!finished && !released) raf = requestAnimationFrame(awaitMounted);
      };
      try {
        Object.defineProperty(controller, 'compensateScrollToDistanceFromBottomPx', { ...compensation, value: compensate });
        Object.defineProperty(controller, 'scrollToDistanceFromBottomPx', { ...scroll, value: scrollTo });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown']) window.addEventListener(type, interrupt, { capture: true, passive: true });
        container.addEventListener('scroll', externalScroll, { passive: true });
        mutations = new MutationObserver(refresh);
        mutations.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
        if (typeof ResizeObserver !== 'undefined') {
          resize = new ResizeObserver(refresh); resize.observe(container); resize.observe(root);
        }
        const mounted = live();
        // Holding an already aligned viewport can ask the host to rebuild the
        // turn window, briefly removing an answer that is already on screen.
        if (!mounted || !measureNativeMessageLanding(container, mounted.target).aligned) {
          controller.holdViewport();
        }
        if (mounted) {
          armed = true; refresh();
          if (!finished && !released) raf = requestAnimationFrame(awaitMounted);
        } else {
          nativePending = true;
          void api.scrollToKey(turnKey, row => {
            const target = findNativeMessageTarget(row, messageId, edge);
            if (target && !released) armed = true;
            return target;
          }, { align: 'top', signal: nativeAbort.signal }).then(() => {
            nativePending = false;
            if (released) return;
            armed = true; refresh();
            if (!finished && !released) raf = requestAnimationFrame(awaitMounted);
          }, () => releaseLease());
        }
      } catch { releaseLease(); }
    }),
  };
}
