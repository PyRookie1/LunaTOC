import { NATIVE_NAVIGATION_COMPLETE, NATIVE_NAVIGATION_PROGRESS, NATIVE_SCROLL_REQUEST, NATIVE_SCROLL_RESPONSE } from './nativeScrollProtocol';
import type { PlatformNavigationAdapter } from '../platformInterface';
import { measureNativeMessageLanding } from './nativeMessageLanding';

let requestSequence = 0;

function request(container: HTMLElement, operation: 'prepare' | 'scroll', top?: number): boolean {
  if (!container.isConnected) return false;
  const requestId = `luna-scroll-${++requestSequence}`;
  let handled = false;
  const receive = (event: Event): void => {
    if (event.target !== container) return;
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== 'string' || detail.length > 1000) return;
    try {
      const result = JSON.parse(detail);
      if (result.requestId !== requestId) return;
      handled = result.handled === true;
    } catch { /* Ignore unrelated page events. */ }
  };
  container.addEventListener(NATIVE_SCROLL_RESPONSE, receive);
  try {
    container.dispatchEvent(new CustomEvent(NATIVE_SCROLL_REQUEST, {
      bubbles: true, composed: true,
      detail: JSON.stringify({ requestId, operation, top }),
    }));
  } finally {
    container.removeEventListener(NATIVE_SCROLL_RESPONSE, receive);
  }

  return handled;
}

export function prepareChatGptNativeScroll(container: HTMLElement): boolean {
  return request(container, 'prepare');
}

/** True means the host updated both the physical offset and virtualizer state. */
export function scrollChatGptNatively(container: HTMLElement, top: number): boolean {
  return Number.isFinite(top) && request(container, 'scroll', top);
}

/** Resolve native readiness immediately; page-owned compensation may retain an anchor afterwards. */
export const navigateChatGptMessageNatively: NonNullable<PlatformNavigationAdapter['navigateToMessage']> = (container, messageId, edge = 'top') => {
  if (!container.isConnected) return null;
  const requestId = `luna-scroll-${++requestSequence}`;
  let accepted = false;
  let done = false;
  let resolveReady!: (shown: boolean) => void;
  const ready = new Promise<boolean>(complete => { resolveReady = complete; });
  let timeout: number | undefined;
  let verification: number | undefined;
  let resolve!: (result: 'found' | 'failed' | 'cancelled') => void;
  const finished = new Promise<'found' | 'failed' | 'cancelled'>(complete => { resolve = complete; });
  const abortHost = (): void => {
    container.dispatchEvent(new CustomEvent(NATIVE_SCROLL_REQUEST, {
      bubbles: true, composed: true, detail: JSON.stringify({ requestId, operation: 'cancel' }),
    }));
  };
  const cleanup = (): void => {
    window.clearTimeout(timeout); window.clearTimeout(verification);
    container.removeEventListener(NATIVE_SCROLL_RESPONSE, acknowledge);
    container.removeEventListener(NATIVE_NAVIGATION_COMPLETE, receive);
    container.removeEventListener(NATIVE_NAVIGATION_PROGRESS, progress);
    for (const name of ['wheel', 'pointerdown', 'touchstart', 'keydown']) {
      window.removeEventListener(name, interrupt, true);
    }
  };
  const finish = (result: 'found' | 'failed' | 'cancelled'): void => {
    if (done) return;
    done = true;
    cleanup();
    if (result !== 'found') abortHost();

    resolveReady(result === 'found');
    resolve(result);
  };
  const interrupt = (event: Event): void => {
    if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
    finish('cancelled');
  };
  const acknowledge = (event: Event): void => {
    if (event.target !== container) return;
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== 'string' || detail.length > 2048) return;
    try {
      const result = JSON.parse(detail);
      if (result.requestId !== requestId) return;
      accepted = result.handled === true;
    } catch { /* Ignore malformed page events. */ }
  };
  const receive = (event: Event): void => {
    if (event.target !== container || done) return;
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== 'string' || detail.length > 2048) return;
    try {
      const result = JSON.parse(detail);
      if (result.requestId !== requestId) return;
      if (result.success !== true) { finish('failed'); return; }
      window.clearTimeout(verification);
      // MAIN verifies the exact landing; final cross-world validation also
      // requires top alignment, not merely any overlap with the viewport.
      verification = window.setTimeout(() => {
        const target = Array.from(container.querySelectorAll<HTMLElement>('[data-chatgpt-search-unit-key$=":user"]'))
          .find(element => element.getAttribute('data-chatgpt-search-message-ids')?.split(/\s+/).includes(messageId));
        const range = Math.max(0, container.scrollHeight - container.clientHeight);
        const bottomTop = getComputedStyle(container).flexDirection === 'column-reverse' ? 0 : range;
        const landed = edge === 'bottom'
          ? Boolean(target && Math.abs(container.scrollTop - bottomTop) <= 2)
          : measureNativeMessageLanding(container, target ?? null).aligned;

        finish(landed ? 'found' : 'failed');
      }, 0);
    } catch { /* Ignore malformed page events. */ }
  };
  const progress = (event: Event): void => {
    if (event.target !== container || done) return;
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== 'string' || detail.length > 2048) return;
    try {
      const result = JSON.parse(detail);
      if (result.requestId === requestId) {
        if (result.phase === 'native-ready') resolveReady(true);
      }
    } catch { /* Ignore malformed page events. */ }
  };
  container.addEventListener(NATIVE_SCROLL_RESPONSE, acknowledge);
  container.addEventListener(NATIVE_NAVIGATION_COMPLETE, receive);
  container.addEventListener(NATIVE_NAVIGATION_PROGRESS, progress);
  container.dispatchEvent(new CustomEvent(NATIVE_SCROLL_REQUEST, {
    bubbles: true, composed: true,
    detail: JSON.stringify({ requestId, operation: 'navigate', messageId, edge }),
  }));
  container.removeEventListener(NATIVE_SCROLL_RESPONSE, acknowledge);

  if (!accepted) { done = true; cleanup(); resolveReady(false); resolve('failed'); return null; }
  timeout = window.setTimeout(() => finish('failed'), 15000);
  for (const name of ['wheel', 'pointerdown', 'touchstart', 'keydown']) {
    window.addEventListener(name, interrupt, { capture: true, passive: true });
  }
  return { ready, finished, cancel: () => finish('cancelled') };
};
