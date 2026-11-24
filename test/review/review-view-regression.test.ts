/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest';
import { navigatorController } from '@/navigation/navigatorController';
import { sidebarController } from '@/features/sidebar/sidebarController';
import { initializePromptLibrary } from '@/features/myPrompts/promptLibrary';
import { dispatchTrustedPageHookMessage } from '@/navigation/pageHookMessageTransport';
import type { PromptStore } from '@/features/myPrompts/promptStore';
import type { PromptUsageStore } from '@/features/myPrompts/promptUsageStore';
it('R16 a captured conversation response cannot overwrite the active Tips panel', async () => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: {
      host: 'chatgpt.com',
      hostname: 'chatgpt.com',
      origin: 'https://chatgpt.com',
      pathname: '/c/review-view-route',
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML =
    '<div id="luna-toc-sidebar"><div id="navigator-title"></div><button id="search-toggle-btn"></button><input id="navigator-search"><button id="toggle-view-mode-btn"></button><div id="myprompts-toolbar-container"></div><div id="luna-toc-status"></div><div id="navigator-list"></div></div>';
  initializePromptLibrary({
    promptsStore: {
      getAll: async () => [
        {
          id: 'tip1',
          ownerId: 'owner-A',
          title: 'saved-tip-title',
          content: 'saved-tip-body',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    } as unknown as PromptStore,
    promptUsageStore: {} as PromptUsageStore,
    insertIntoChatGPTInput() {},
  });
  navigatorController.init();
  sidebarController.init();
  sidebarController.setViewMode('myPrompts');
  await new Promise((r) => setTimeout(r, 0));
  expect(document.getElementById('navigator-list')!.textContent).toContain('saved-tip-title');
  dispatchTrustedPageHookMessage({
    type: 'CHATGPT_CONVERSATION_DATA',
    routeKey: 'review-view-route',
    payload: {
      messages: [
        {
          id: 'user-1',
          author: { role: 'user' },
          content: { parts: ['conversation-question'] },
          create_time: 1,
        },
      ],
    },
  });
  expect(sidebarController.isMyPromptsView()).toBe(true);
  expect(document.getElementById('navigator-list')!.textContent).toContain('saved-tip-title');
});
