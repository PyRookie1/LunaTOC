/**
 * Isolated-world TOC receiver. Page scripts can post window messages but
 * ordinary window messages never reach the conversation state.
 *
 * The initial MessagePort exchange is best-effort, not authentication of
 * arbitrary JavaScript running in the page's MAIN world.
 */
import { PAGE_HOOK_PORT_READY, PAGE_HOOK_PORT_REQUEST } from '@/pageHook/messageTransport';

type Listener = (message: Record<string, unknown>) => void;
const subscribers = new Set<Listener>();
let connected = false;
let started = false;

export function dispatchTrustedPageHookMessage(message: unknown): void {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  for (const subscriber of subscribers) subscriber(message as Record<string, unknown>);
}

export function subscribeTrustedPageHookMessage(subscriber: Listener): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function connectPageHookMessageTransport(): void {
  if (started) return;
  started = true;
  const requestId = crypto.randomUUID();
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  let attempts = 0;

  const onReady = (event: MessageEvent): void => {
    if (connected || event.source !== window || event.origin !== location.origin) return;
    const data = event.data as { type?: unknown; requestId?: unknown } | null;
    if (data?.type !== PAGE_HOOK_PORT_READY || data.requestId !== requestId ||
        event.ports.length !== 1) return;
    const port = event.ports[0];
    connected = true;
    window.removeEventListener('message', onReady);
    if (retryTimer !== undefined) clearInterval(retryTimer);
    port.onmessage = (incoming: MessageEvent) => {
      dispatchTrustedPageHookMessage(incoming.data);
    };
    port.start();
  };
  window.addEventListener('message', onReady);

  const requestPort = (): void => {
    if (connected || attempts >= 100) {
      if (retryTimer !== undefined) clearInterval(retryTimer);
      return;
    }
    attempts += 1;
    window.postMessage({ type: PAGE_HOOK_PORT_REQUEST, requestId }, location.origin);
  };
  requestPort();
  retryTimer = setInterval(requestPort, 100);
}
