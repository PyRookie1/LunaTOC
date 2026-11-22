/** Use the thread controller in MAIN, where React's DOM bindings are visible. */
import { CHATGPT_FEED_SELECTOR, NATIVE_NAVIGATION_COMPLETE, NATIVE_NAVIGATION_PROGRESS, NATIVE_SCROLL_REQUEST, NATIVE_SCROLL_RESPONSE } from '@/platforms/chatgpt/nativeScrollProtocol';
import { findNativeMessageNavigation } from './nativeMessageNavigation';
import { settleNativeMessage } from './settleNativeMessage';
import { createInstantMessageNavigation, type InstantMessageNavigation } from './instantMessageNavigation';

export interface ThreadScrollController {
  getScrollElement(): HTMLElement | null;
  getLastScrollDistanceFromBottomPx(): number;
  holdViewport(): void;
  scrollToDistanceFromBottomPx(distance: number, behavior: 'instant', source: 'user'): void;
}

interface Fiber {
  return?: Fiber | null;
  memoizedProps?: { value?: unknown };
  pendingProps?: { value?: unknown };
  dependencies?: { firstContext?: { memoizedValue?: unknown; next?: unknown } | null };
}

/** Bounded, read-only lookup. Never accept a controller for another feed. */
export function findThreadScrollController(container: HTMLElement): ThreadScrollController | null {
  const bindings = container as unknown as Record<string, unknown>;
  const key = Object.getOwnPropertyNames(container).find(name =>
    name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$')
  );
  let fiber = key ? bindings[key] as Fiber | null : null;
  const matches = (value: unknown): value is ThreadScrollController => {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<ThreadScrollController>;
    return typeof candidate.getScrollElement === 'function' &&
      typeof candidate.getLastScrollDistanceFromBottomPx === 'function' &&
      typeof candidate.holdViewport === 'function' &&
      typeof candidate.scrollToDistanceFromBottomPx === 'function' &&
      candidate.getScrollElement() === container;
  };
  for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return ?? null) {
    for (const value of [fiber.memoizedProps?.value, fiber.pendingProps?.value]) {
      if (matches(value)) return value;
    }
    let context = fiber.dependencies?.firstContext;
    for (let count = 0; context && count < 20; count++) {
      if (matches(context.memoizedValue)) return context.memoizedValue;
      context = context.next as typeof context;
    }
  }
  return null;
}

export function installChatGptNativeScrollBridge(): () => void {
  const active = new Map<HTMLElement, { requestId: string; abort: AbortController }>();
  const anchors = new Map<HTMLElement, { requestId: string; navigation: InstantMessageNavigation }>();
  const releaseAnchor = (container: HTMLElement): void => {
    anchors.get(container)?.navigation.dispose(); anchors.delete(container);
  };
  const listener = (event: Event): void => {
    const container = event.target;
    if (!(container instanceof HTMLElement) || !container.isConnected || !container.matches(CHATGPT_FEED_SELECTOR)) return;
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== 'string' || detail.length > 2048) return;
    let data: { requestId?: unknown; operation?: unknown; top?: unknown; messageId?: unknown; edge?: unknown };
    try { data = JSON.parse(detail); } catch { return; }
    if (typeof data?.requestId !== 'string' || !/^luna-scroll-\d+$/.test(data.requestId)) return;
    let handled = false;
    let reason = 'controller-not-found';
    let distance: number | undefined;
    let cachedDistance: number | undefined;
    let actualDistance: number | undefined;
    try {
      const controller = findThreadScrollController(container);
      if (data.operation === 'cancel') {
        const previous = active.get(container);
        if (previous?.requestId === data.requestId) {
          previous.abort.abort(); active.delete(container);
        }
        if (anchors.get(container)?.requestId === data.requestId) releaseAnchor(container);
        handled = true; reason = 'native-navigation-cancelled';
      } else if (data.operation === 'navigate' && typeof data.messageId === 'string' &&
        data.messageId.length > 0 && data.messageId.length <= 256 && (data.edge === 'top' || data.edge === 'bottom')) {
        const native = findNativeMessageNavigation(container, data.messageId);
        reason = 'native-turn-list-or-message-not-found';
        if (native && controller) {
          releaseAnchor(container);
          active.get(container)?.abort.abort();
          const abort = new AbortController();
          const requestId = data.requestId;
          const messageId = data.messageId;
          const edge = data.edge;
          active.set(container, { requestId, abort });
          const complete = (success: boolean): void => {
            if (active.get(container)?.abort !== abort) return;
            active.delete(container);
            container.dispatchEvent(new CustomEvent(NATIVE_NAVIGATION_COMPLETE, {
              detail: JSON.stringify({ requestId, success: success && !abort.signal.aborted }),
            }));
          };
          let anchor: InstantMessageNavigation | null = null;
          try {
            const onReady = (): void => {
              if (active.get(container)?.abort !== abort && (!anchor || anchors.get(container)?.navigation !== anchor)) return;
              container.dispatchEvent(new CustomEvent(NATIVE_NAVIGATION_PROGRESS, {
                detail: JSON.stringify({ requestId, phase: 'native-ready' }),
              }));
            };
            anchor = createInstantMessageNavigation({
              container, controller, api: native.api, turnKey: native.turnKey, messageId, edge,
              signal: abort.signal, onReady,
              onRelease: () => { if (anchors.get(container)?.navigation === anchor) anchors.delete(container); },
            });
            if (anchor) {
              anchors.set(container, { requestId, navigation: anchor });
              void anchor.run().then(complete, () => { abort.abort(); complete(false); });
              handled = true; reason = 'native-instant-anchor-accepted';
            } else {
              // Compatibility path: render the first landing immediately.
              // Verification runs in the background, without a snapshot gate.
              void settleNativeMessage({
                container, api: native.api, turnKey: native.turnKey, messageId, edge,
                signal: abort.signal,
                prepare: () => controller.holdViewport(),
                scrollToDistanceFromBottomPx: distance =>
                  controller.scrollToDistanceFromBottomPx(distance, 'instant', 'user'),
                onReady,
              }).then(result => complete(result.success), () => { abort.abort(); complete(false); });
              handled = true; reason = 'native-message-navigation-accepted';
            }
          } catch {
            abort.abort(); active.delete(container); reason = 'native-message-navigation-error';
          }
        }
      } else if (controller && data.operation === 'prepare') {
        releaseAnchor(container);
        controller.holdViewport();
        handled = true; reason = 'native-prepared';
      } else if (controller && data.operation === 'scroll' && typeof data.top === 'number' && Number.isFinite(data.top)) {
        releaseAnchor(container);
        const range = Math.max(0, container.scrollHeight - container.clientHeight);
        const reverse = getComputedStyle(container).flexDirection === 'column-reverse';
        distance = reverse ? Math.max(0, Math.min(range, -data.top))
          : range - Math.max(0, Math.min(range, data.top));
        // 'user' is essential: it notifies virtual-window listeners as well
        // as updating the cached distance that measurement compensation reads.
        controller.scrollToDistanceFromBottomPx(distance, 'instant', 'user');
        cachedDistance = controller.getLastScrollDistanceFromBottomPx();
        actualDistance = reverse ? Math.max(0, -container.scrollTop)
          : Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop);
        handled = Number.isFinite(cachedDistance) && Math.abs(cachedDistance - actualDistance) <= 2;
        reason = handled ? 'native-state-updated' : 'native-state-not-updated';
      }
    } catch { reason = 'native-controller-error'; }
    container.dispatchEvent(new CustomEvent(NATIVE_SCROLL_RESPONSE, {
      detail: JSON.stringify({ requestId: data.requestId, handled, reason, distance, cachedDistance, actualDistance }),
    }));
  };
  document.addEventListener(NATIVE_SCROLL_REQUEST, listener, true);
  return () => {
    document.removeEventListener(NATIVE_SCROLL_REQUEST, listener, true);
    for (const pending of active.values()) pending.abort.abort();
    active.clear();
    for (const anchor of anchors.values()) anchor.navigation.dispose();
    anchors.clear();
  };
}
