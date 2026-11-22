/**
 * Connects the bold-repair controller to ChatGPT's SPA navigation lifecycle.
 *
 * Route changes are received through LunaTOC's existing MAIN-world MessagePort
 * bridge. Browser back/forward navigation is covered by popstate as well.
 */
import { CHATGPT_MESSAGE_TYPES } from '@/platforms/chatgpt/messages';
import { subscribeTrustedPageHookMessage } from '@/navigation/pageHookMessageTransport';
import {
  createBoldFixController,
  type BoldFixController,
} from './boldFixController';

const ROUTE_SCAN_DEBOUNCE_MS = 250;

type PageHookSubscriber = (subscriber: (event: MessageEvent) => void) => () => void;

export interface BoldFixLifecycle {
  readonly controller: BoldFixController;
  /** Stops route listeners, cancels pending scans and restores the original DOM. */
  stop(): void;
}

/**
 * Creates and starts the bold-repair lifecycle for one document.
 *
 * The controller performs the initial full scan and keeps its MutationObserver
 * active for streamed or lazily-mounted messages. A route transition schedules
 * another full scan after ChatGPT has had time to replace the conversation DOM.
 * The subscriber is injectable so the lifecycle can be tested without a live
 * MAIN-world MessagePort.
 */
export function createBoldFixLifecycle(
  doc: Document = document,
  subscribe: PageHookSubscriber = subscribeTrustedPageHookMessage
): BoldFixLifecycle {
  const view = doc.defaultView;
  if (!view) {
    throw new Error('Bold repair lifecycle requires a document with a browsing context.');
  }

  const controller = createBoldFixController(doc);
  let stopped = false;
  let routeScanTimer: number | null = null;

  const scheduleFullScan = (): void => {
    if (stopped) return;
    if (routeScanTimer !== null) {
      view.clearTimeout(routeScanTimer);
    }
    routeScanTimer = view.setTimeout(() => {
      routeScanTimer = null;
      if (!stopped) controller.scanAll();
    }, ROUTE_SCAN_DEBOUNCE_MS);
  };

  const handlePageHookMessage = (event: MessageEvent): void => {
    if (event.source !== view || event.origin !== view.location.origin) return;
    const message = event.data as { type?: unknown } | null;
    if (message?.type === CHATGPT_MESSAGE_TYPES.routeChanged) {
      scheduleFullScan();
    }
  };

  const handlePopState = (): void => {
    scheduleFullScan();
  };

  const unsubscribe = subscribe(handlePageHookMessage);
  view.addEventListener('popstate', handlePopState);
  controller.start();

  return {
    controller,
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (routeScanTimer !== null) {
        view.clearTimeout(routeScanTimer);
        routeScanTimer = null;
      }
      unsubscribe();
      view.removeEventListener('popstate', handlePopState);
      controller.stop();
    },
  };
}

let defaultLifecycle: BoldFixLifecycle | null = null;

/** Initializes the one document-scoped controller used by the content script. */
export function initializeBoldFixLifecycle(): BoldFixLifecycle {
  if (!defaultLifecycle) {
    defaultLifecycle = createBoldFixLifecycle(document);
  }
  return defaultLifecycle;
}
