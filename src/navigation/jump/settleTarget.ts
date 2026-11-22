/** Verify a landing against live DOM geometry while the host virtualizer settles. */
import { getActivePlatform } from '@/platforms';
export interface SettleTargetOptions {
  container: HTMLElement;
  resolveTarget: () => HTMLElement | null;
  edge: 'top' | 'bottom';
  topOffset: number;
  isCancelled: () => boolean;
  onSettled: (found: boolean) => void;
  onInterrupted?: () => void;
  /** Return to virtual loading when a previously found target is evicted. */
  onTargetMissing?: () => void;
}

const CHECK_INTERVAL_MS = 80;
const CHECK_COUNT = 20;
const POSITION_TOLERANCE_PX = 4;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** Explicit instant writes cannot inherit the host's CSS smooth scrolling. */
export function scrollInstantly(container: HTMLElement, top: number): void {
  if (getActivePlatform().navigation.scrollToPosition?.(container, top)) return;
  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top, behavior: 'instant' });
  } else {
    container.scrollTop = top;
  }
}

export function settleTarget(options: SettleTargetOptions): () => void {
  const { container } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checks = 0;
  let missingChecks = 0;

  function stop(): void {
    stopped = true;
    clearTimeout(timer);
    container.removeEventListener('wheel', interrupt);
    container.removeEventListener('touchstart', interrupt);
    container.removeEventListener('pointerdown', interrupt);
    document.removeEventListener('keydown', onKeyDown, true);
  }
  function interrupt(): void {
    stop();
    options.onInterrupted?.();
  }
  function onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
        !SCROLL_KEYS.has(event.key)) return;
    if (event.target instanceof Element && event.target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], ' +
      '#luna-toc-sidebar, #luna-toc-react-host'
    )) return;
    interrupt();
  }
  function check(): void {
    if (stopped) return;
    if (options.isCancelled()) { stop(); return; }
    const target = options.resolveTarget();
    const connected = container.isConnected && target?.isConnected && container.contains(target);
    missingChecks = connected ? 0 : missingChecks + 1;
    if (container.isConnected && missingChecks >= 2 && options.onTargetMissing) {
      stop();
      options.onTargetMissing();
      return;
    }
    let positioned = false;
    if (connected) {
      const bounds = container.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      const delta = options.edge === 'top'
        ? rect.top - bounds.top - container.clientTop - options.topOffset
        : rect.bottom - bounds.top - container.clientTop - container.clientHeight;
      const range = Math.max(0, container.scrollHeight - container.clientHeight);
      const reverse = getComputedStyle(container).flexDirection === 'column-reverse';
      const desired = container.scrollTop + delta;
      const top = reverse
        ? Math.max(-range, Math.min(0, desired))
        : Math.max(0, Math.min(range, desired));
      // Clamping also accepts legitimate landings at either physical boundary.
      const visible = container.clientHeight > 0 && rect.height > 0 &&
        rect.bottom > bounds.top + container.clientTop &&
        rect.top < bounds.top + container.clientTop + container.clientHeight;
      positioned = visible && Math.abs(top - container.scrollTop) <= POSITION_TOLERANCE_PX;
      if (!positioned) {
        scrollInstantly(container, top);
      }
    }
    // Keep observing for the full budget: an initially correct position can
    // still be overwritten by a later virtualizer measurement or bottom snap.
    if (++checks > CHECK_COUNT || !container.isConnected) {
      stop();
      options.onSettled(positioned);
      return;
    }
    timer = setTimeout(check, CHECK_INTERVAL_MS);
  }
  container.addEventListener('wheel', interrupt, { passive: true });
  container.addEventListener('touchstart', interrupt, { passive: true });
  container.addEventListener('pointerdown', interrupt, { passive: true });
  document.addEventListener('keydown', onKeyDown, true);
  check();
  return stop;
}
