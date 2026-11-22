/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBoldFixLifecycle,
  type BoldFixLifecycle,
  type BoldFixLifecycleSettings,
} from '@/features/boldFix/boldFixLifecycle';
import { CHATGPT_MESSAGE_TYPES } from '@/platforms/chatgpt/messages';

type PageHookSubscriber = (event: MessageEvent) => void;

let lifecycle: BoldFixLifecycle | null = null;

function mountThread(markup: string): HTMLElement {
  document.body.innerHTML = '<main id="thread">' + markup + '</main>';
  const thread = document.querySelector<HTMLElement>('#thread');
  if (!thread) throw new Error('Test thread was not mounted');
  return thread;
}

function createLifecycleHarness(settings?: BoldFixLifecycleSettings): {
  lifecycle: BoldFixLifecycle;
  emitRouteChanged(): void;
} {
  let subscriber: PageHookSubscriber | null = null;
  const subscribe = (listener: PageHookSubscriber): (() => void) => {
    subscriber = listener;
    return () => {
      subscriber = null;
    };
  };
  const instance = createBoldFixLifecycle(document, subscribe, settings);
  lifecycle = instance;

  return {
    lifecycle: instance,
    emitRouteChanged(): void {
      if (!subscriber) throw new Error('Page-hook subscriber is not registered');
      subscriber(new MessageEvent('message', {
        data: { type: CHATGPT_MESSAGE_TYPES.routeChanged },
        origin: window.location.origin,
        source: window,
      }));
    },
  };
}

afterEach(() => {
  lifecycle?.stop();
  lifecycle = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('boldFixLifecycle', () => {
  it('performs the initial full conversation scan when started', () => {
    const thread = mountThread(
      '<div data-message-author-role="assistant"><p>before **bold text** after</p></div>'
    );

    const harness = createLifecycleHarness();

    expect(harness.lifecycle.controller.running).toBe(true);
    expect(thread.querySelector('strong[data-chatgpt-md-fix="bold"]')?.textContent)
      .toBe('bold text');
  });

  it('honors the saved setting and restores or reapplies the current conversation on toggle', async () => {
    const thread = mountThread(
      '<div data-message-author-role="assistant"><p>before **bold text** after</p></div>'
    );
    const settingsEvents: { listener?: (enabled: boolean) => void } = {};
    const settings: BoldFixLifecycleSettings = {
      readEnabled: async () => false,
      subscribeEnabled: (listener) => {
        settingsEvents.listener = listener;
        return () => { delete settingsEvents.listener; };
      },
    };
    const harness = createLifecycleHarness(settings);

    await vi.waitFor(() => {
      expect(harness.lifecycle.controller.running).toBe(false);
    });
    expect(thread.querySelector('strong[data-chatgpt-md-fix="bold"]')).toBeNull();

    settingsEvents.listener?.(true);
    expect(harness.lifecycle.controller.running).toBe(true);
    expect(thread.querySelector('strong[data-chatgpt-md-fix="bold"]')?.textContent)
      .toBe('bold text');

    settingsEvents.listener?.(false);
    expect(harness.lifecycle.controller.running).toBe(false);
    expect(thread.querySelector('[data-chatgpt-md-fix]')).toBeNull();
    expect(thread.querySelector('p')?.textContent).toBe('before **bold text** after');

    settingsEvents.listener?.(true);
    expect(harness.lifecycle.controller.running).toBe(true);
    expect(thread.querySelector('strong[data-chatgpt-md-fix="bold"]')?.textContent)
      .toBe('bold text');

    harness.lifecycle.stop();
    expect(settingsEvents.listener).toBeUndefined();
  });

  it('runs a debounced full scan after trusted SPA route changes', async () => {
    mountThread('<div data-message-author-role="assistant"><p>**first**</p></div>');
    const harness = createLifecycleHarness();
    const scanAll = vi.spyOn(harness.lifecycle.controller, 'scanAll');

    harness.emitRouteChanged();
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    harness.emitRouteChanged();

    await vi.waitFor(() => {
      expect(scanAll).toHaveBeenCalledTimes(1);
    }, { timeout: 1_000 });
  });

  it('runs a full scan after browser back/forward navigation', async () => {
    mountThread('<div data-message-author-role="assistant"><p>**first**</p></div>');
    const harness = createLifecycleHarness();
    const scanAll = vi.spyOn(harness.lifecycle.controller, 'scanAll');

    window.dispatchEvent(new PopStateEvent('popstate'));

    await vi.waitFor(() => {
      expect(scanAll).toHaveBeenCalledTimes(1);
    }, { timeout: 1_000 });
  });

  it('ignores ordinary page window messages and restores the DOM when stopped', async () => {
    const thread = mountThread(
      '<div data-message-author-role="assistant"><p>before **bold text** after</p></div>'
    );
    const harness = createLifecycleHarness();
    const scanAll = vi.spyOn(harness.lifecycle.controller, 'scanAll');

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: CHATGPT_MESSAGE_TYPES.routeChanged },
      origin: window.location.origin,
      source: window,
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 300));

    expect(scanAll).not.toHaveBeenCalled();
    expect(thread.querySelector('strong[data-chatgpt-md-fix="bold"]')).not.toBeNull();

    harness.lifecycle.stop();

    expect(harness.lifecycle.controller.running).toBe(false);
    expect(thread.querySelector('[data-chatgpt-md-fix]')).toBeNull();
    expect(thread.querySelector('p')?.textContent).toBe('before **bold text** after');
  });

  it('cancels pending route scans and unsubscribes when stopped', async () => {
    mountThread('<div data-message-author-role="assistant"><p>**first**</p></div>');
    const harness = createLifecycleHarness();
    const scanAll = vi.spyOn(harness.lifecycle.controller, 'scanAll');

    harness.emitRouteChanged();
    harness.lifecycle.stop();

    await new Promise((resolve) => window.setTimeout(resolve, 300));

    expect(scanAll).not.toHaveBeenCalled();
    expect(harness.lifecycle.controller.running).toBe(false);
  });
});
