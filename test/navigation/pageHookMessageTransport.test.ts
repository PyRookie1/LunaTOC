/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigatorController } from '@/navigation/navigatorController';
import { dispatchTrustedPageHookMessage } from '@/navigation/pageHookMessageTransport';
import { getActivePlatform } from '@/platforms';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isolated conversation receiver', () => {
  it('ignores a same-origin forged page message but accepts data through the port dispatcher', () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        host: 'chatgpt.com',
        pathname: '/c/test-forged-page-message',
      },
    });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    document.body.innerHTML = [
      '<div id="navigator-list"></div>',
      '<div class="navigator-hint"></div>',
      '<div id="sidebar-status-band"></div>',
      '<div id="luna-toc-status"></div>',
    ].join('');
    navigatorController.init();
    navigatorController.attach();

    const type = getActivePlatform().pageHook.messages.conversationData;
    const forged = {
      type, routeKey: 'test-forged-page-message',
      payload: { messages: [
        { id: 'forged-user', author: { role: 'user' },
          content: { parts: ['Forged page text'] }, create_time: 1 },
      ] },
    };
    const list = document.getElementById('navigator-list')!;

    // event.source and event.origin are both correct: these checks alone
    // cannot distinguish a real page-hook message from a page-script forgery.
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: forged,
    }));
    expect(list.textContent).not.toContain('Forged page text');

    dispatchTrustedPageHookMessage({
      type,
      routeKey: 'test-forged-page-message',
      payload: { messages: [
        { id: 'trusted-user', author: { role: 'user' },
          content: { parts: ['Real captured prompt'] }, create_time: 2 },
      ] },
    });
    expect(list.textContent).toContain('Real captured prompt');

    // A forged refresh completion must not replace a legitimate outline.
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: { ...forged, payload: { messages: [] } },
    }));
    expect(list.textContent).toContain('Real captured prompt');
  });
});
