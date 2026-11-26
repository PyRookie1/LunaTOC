import { subscribeTrustedPageHookMessage } from '@/navigation/pageHookMessageTransport';
import { TOC_REFRESH_CANCEL, TOC_REFRESH_REQUEST, TOC_REFRESH_RESULT, TOC_REFRESH_TIMEOUT_MS } from '@/navigation/refresh/refreshProtocol';
import type { ConversationSnapshot } from '@/navigation/state/activeBranch';

let requestCounter = 1_100_000_000;

/** Independent, no-cache refresh; cancellation retires only this capture waiter. */
export function readCaptureSnapshot(routeKey: string, signal: AbortSignal): Promise<ConversationSnapshot> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Task ended', 'AbortError')); return; }
    const requestId = requestCounter++;
    let done = false;
    const finish = (payload: ConversationSnapshot | null, error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', abort);
      if (error || !payload) reject(error ?? new Error('unavailable'));
      else resolve(payload);
    };
    const cancel = (): void => window.postMessage({ type: TOC_REFRESH_CANCEL, routeKey, requestId, purpose: 'capture' }, location.origin);
    const abort = (): void => { cancel(); finish(null, new DOMException('Task ended', 'AbortError')); };
    const unsubscribe = subscribeTrustedPageHookMessage(event => {
      const data = event.data;
      if (data?.type === TOC_REFRESH_RESULT && data.routeKey === routeKey && data.requestId === requestId) {
        finish(data.payload ?? null);
      }
    });
    const timer = setTimeout(() => { cancel(); finish(null, new Error('timeout')); }, TOC_REFRESH_TIMEOUT_MS + 1_000);
    signal.addEventListener('abort', abort, { once: true });
    window.postMessage({ type: TOC_REFRESH_REQUEST, routeKey, requestId, purpose: 'capture' }, location.origin);
  });
}
