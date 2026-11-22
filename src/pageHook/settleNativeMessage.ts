import { measureNativeMessageLanding } from '@/platforms/chatgpt/nativeMessageLanding';
import { findNativeMessageTarget, type NativeTurnList } from './nativeMessageNavigation';

/** Cancellation must release even a host Promise that never resolves on abort. */
async function untilAbort(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  let abort!: () => void;
  const cancelled = new Promise<void>(resolve => { abort = resolve; });
  signal.addEventListener('abort', abort, { once: true });
  try { if (!signal.aborted) await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

function tick(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = (): void => {
      window.clearTimeout(timer); signal.removeEventListener('abort', finish); resolve();
    };
    const timer = window.setTimeout(finish, 100);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/**
 * A native Promise can complete before neighboring turns finish measuring.
 * Reacquire through the same semantic API only after observed drift/eviction;
 * never fight the host with pixel writes or continuously repin a correct row.
 */
export async function settleNativeMessage(options: {
  container: HTMLElement; api: NativeTurnList; turnKey: string; messageId: string;
  edge: 'top' | 'bottom'; signal: AbortSignal;
  prepare(): void;
  /** First correct landing can be presented while background verification continues. */
  onReady?(): void;
}): Promise<{ success: boolean; attempts: number; reason: string }> {
  const { container, api, turnKey, messageId, edge, signal } = options;
  const started = performance.now();
  let firstCompletion: number | null = null;
  let lastCompletion = started;
  let lastChange = started;
  let attempts = 0;
  let previous: ReturnType<typeof measureNativeMessageLanding> | null = null;
  let previousTarget: HTMLElement | null = null;
  let notifiedReady = false;
  const jump = async (): Promise<void> => {
    attempts++;
    options.prepare();
    await untilAbort(api.scrollToKey(turnKey, row => findNativeMessageTarget(row, messageId, edge),
      { align: 'top', signal }), signal);
    lastCompletion = performance.now();
    firstCompletion ??= lastCompletion;
    lastChange = lastCompletion;
    previous = null;
  };
  const finish = (success: boolean, reason: string) => {
    return { success, attempts, reason };
  };
  await jump();
  while (!signal.aborted && performance.now() - started < 13000) {
    if (!container.isConnected) return finish(false, 'feed-disconnected');
    const row = api.getRowElement(turnKey);
    const target = row && container.contains(row) ? findNativeMessageTarget(row, messageId, edge) : null;
    const state = measureNativeMessageLanding(container, target);
    const now = performance.now();
    const changed = !previous || target !== previousTarget ||
      (['topDelta', 'scrollTop', 'scrollHeight', 'clientHeight', 'targetHeight'] as const).some(key => {
        const before = previous![key], after = state[key];
        return before === null || after === null ? before !== after : Math.abs(before - after) > 1;
      });
    if (changed) lastChange = now;
    previous = state; previousTarget = target;
    if (state.aligned && !notifiedReady) {
      notifiedReady = true;
      options.onReady?.();
    }
    // Keep watching beyond the observed ~1.1s delayed eviction after native
    // completion. Geometry changes extend this through a separate quiet window.
    if (state.aligned && now - firstCompletion! >= 1200 && now - lastChange >= 600) return finish(true, 'aligned-and-stable');
    if (!state.aligned && now - lastChange >= 300 && now - lastCompletion >= 400) {
      if (attempts >= 3) return finish(false, 'native-reacquire-limit');
      await jump();
    }
    await tick(signal);
  }
  return finish(false, signal.aborted ? 'cancelled' : 'native-settle-timeout');
}
