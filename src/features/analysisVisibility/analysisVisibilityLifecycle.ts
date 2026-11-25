/** Connects analysis visibility to the saved preference and ChatGPT SPA routes. */
import { CHATGPT_MESSAGE_TYPES } from '@/platforms/chatgpt/messages';
import { subscribeTrustedPageHookMessage } from '@/navigation/pageHookMessageTransport';
import { createAnalysisVisibilityController } from './analysisVisibilityController';
import { readAnalysisHideEnabled, subscribeAnalysisHideEnabled } from './analysisVisibilitySettings';

type SubscribeRoute = (listener: (event: MessageEvent) => void) => () => void;
export interface AnalysisVisibilitySettings {
  readEnabled(): Promise<boolean>;
  subscribeEnabled(listener: (enabled: boolean) => void): () => void;
}

export function createAnalysisVisibilityLifecycle(
  doc: Document = document,
  subscribe: SubscribeRoute = subscribeTrustedPageHookMessage,
  settings: AnalysisVisibilitySettings = {
    readEnabled: readAnalysisHideEnabled,
    subscribeEnabled: subscribeAnalysisHideEnabled,
  }
) {
  const view = doc.defaultView;
  if (!view) throw new Error('Analysis visibility requires a browsing context');
  const controller = createAnalysisVisibilityController(doc);
  let stopped = false;
  let storageChanged = false;
  let routeTimer: number | null = null;

  const apply = (enabled: boolean): void => {
    if (stopped) return;
    if (enabled) controller.start();
    else controller.stop();
  };
  const onRoute = (): void => {
    if (stopped || !controller.running) return;
    if (routeTimer !== null) view.clearTimeout(routeTimer);
    routeTimer = view.setTimeout(() => {
      routeTimer = null;
      if (!stopped) controller.scanAll();
    }, 250);
  };
  const onMessage = (event: MessageEvent): void => {
    if (event.source === view && event.origin === view.location.origin &&
        (event.data as { type?: unknown } | null)?.type === CHATGPT_MESSAGE_TYPES.routeChanged) onRoute();
  };
  const unsubscribeRoute = subscribe(onMessage);
  const unsubscribeSettings = settings.subscribeEnabled(enabled => {
    storageChanged = true;
    if (!enabled && routeTimer !== null) {
      view.clearTimeout(routeTimer);
      routeTimer = null;
    }
    apply(enabled);
  });
  view.addEventListener('popstate', onRoute);
  void settings.readEnabled().then(enabled => {
    if (!storageChanged) apply(enabled);
  }).catch(() => { /* Stay visible if storage is unavailable. */ });

  return {
    controller,
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (routeTimer !== null) view.clearTimeout(routeTimer);
      unsubscribeRoute();
      unsubscribeSettings();
      view.removeEventListener('popstate', onRoute);
      controller.stop();
    },
  };
}

let lifecycle: ReturnType<typeof createAnalysisVisibilityLifecycle> | null = null;
export function initializeAnalysisVisibilityLifecycle(): void {
  if (!lifecycle) lifecycle = createAnalysisVisibilityLifecycle();
}
