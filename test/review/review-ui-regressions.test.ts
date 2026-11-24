/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { initializePromptLibrary, renderMyPrompts } from '@/features/myPrompts/promptLibrary';
import { promptAutocompleteViewController } from '@/features/myPrompts/promptAutocompleteView';
import { promptEditorController } from '@/features/myPrompts/promptEditor';
import { promptContextMenuController } from '@/features/myPrompts/promptContextMenu';
import {
  setActiveConversationOwner,
  getActiveConversationOwner,
} from '@/navigation/lifecycle/conversationOwner';
import { dispatchTrustedPageHookMessage } from '@/navigation/pageHookMessageTransport';
import { initializeConversationLifecycle } from '@/navigation/lifecycle/conversationLifecycle';
import type { PromptStore, SavedPrompt } from '@/features/myPrompts/promptStore';
import type { PromptUsageStore } from '@/features/myPrompts/promptUsageStore';
const prompt: SavedPrompt = {
  id: 'private-tip',
  ownerId: 'owner-A',
  title: 'private-title',
  content: 'PRIVATE_PROMPT_BODY',
  createdAt: 1,
  updatedAt: 1,
};
afterEach(() => {
  promptAutocompleteViewController.close();
  promptEditorController.close();
  setActiveConversationOwner(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});
it('R10 synthetic page clicks cannot export private prompt bodies', async () => {
  setActiveConversationOwner('owner-A');
  initializePromptLibrary({
    promptsStore: { getAll: async () => [prompt] } as unknown as PromptStore,
    promptUsageStore: {} as PromptUsageStore,
    insertIntoChatGPTInput() {},
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const bodies: string[] = [];
  let readDone = Promise.resolve();
  const make = vi.fn((blob: Blob) => {
    const reader = new FileReader();
    readDone = new Promise<void>((resolve) => {
      reader.onload = () => {
        bodies.push(String(reader.result));
        resolve();
      };
    });
    reader.readAsText(blob);
    return 'blob:https://chatgpt.com/private-export';
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: make });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  document.body.addEventListener('click', (event) => {
    if ((event.target as Element)?.tagName === 'A') event.preventDefault();
  });
  document.body.innerHTML = '<div id="myprompts-toolbar-container"></div><div id="tips"></div>';
  await renderMyPrompts(document.getElementById('tips')!);
  document.getElementById('myprompt-export-btn')!.click();
  await new Promise((r) => setTimeout(r, 0));
  await readDone;
  expect(bodies).toEqual([]);
});
it('R11 account changes invalidate existing autocomplete and editor state', () => {
  setActiveConversationOwner('owner-A');
  promptAutocompleteViewController.show(
    [prompt],
    0,
    { left: 0, width: 200, anchorTop: 0, anchorBottom: 0, viewportHeight: 800 },
    () => {},
    () => {},
  );
  promptEditorController.open(prompt, async () => {});
  setActiveConversationOwner('owner-B');
  expect.soft(promptAutocompleteViewController.getSnapshot()).toBeNull();
  expect.soft(promptEditorController.getSnapshot()).toBeNull();
});
it('R12 port-delivered SPA route changes revalidate the account identity', async () => {
  const fetcher = vi.fn(async () => Response.json({ user: { id: 'owner-A' } }));
  vi.stubGlobal('fetch', fetcher);
  initializeConversationLifecycle();
  await new Promise((r) => setTimeout(r, 0));
  expect(getActiveConversationOwner()).toBe('owner-A');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
  fetcher.mockImplementation(async () => Response.json({ user: { id: 'owner-B' } }));
  dispatchTrustedPageHookMessage({ type: 'CHATGPT_ROUTE_CHANGED' });
  await new Promise((r) => setTimeout(r, 0));
  expect(getActiveConversationOwner()).toBe('owner-B');
});
it('R13 a clear-all confirmation for account A cannot delete account B', async () => {
  setActiveConversationOwner('owner-A');
  const handlers = vi.spyOn(EventTarget.prototype, 'addEventListener');
  const cleared: string[] = [];
  const clearAll = vi.fn(async () => {
    cleared.push(getActiveConversationOwner()!);
  });
  initializePromptLibrary({
    promptsStore: { getAll: async () => [prompt], clearAll } as unknown as PromptStore,
    promptUsageStore: {} as PromptUsageStore,
    insertIntoChatGPTInput() {},
  });
  const container = document.createElement('div');
  document.body.append(container);
  await renderMyPrompts(container);
  // Simulates the trusted context-menu event entering the application's handler.
  container.oncontextmenu!.call(container, {
    target: container,
    isTrusted: true,
    clientX: 1,
    clientY: 1,
    preventDefault() {},
  } as unknown as PointerEvent);
  promptContextMenuController.select('clear-all');
  await new Promise((r) => setTimeout(r, 0));
  expect(document.getElementById('myprompt-message-confirm')).not.toBeNull();
  const confirm = document.getElementById('myprompt-message-confirm')!;
  const index = handlers.mock.contexts.findIndex(
    (target, i) => target === confirm && handlers.mock.calls[i][0] === 'click',
  );
  setActiveConversationOwner('owner-B');
  // Enter the captured handler as a genuine user confirmation after account switch.
  (handlers.mock.calls[index][1] as EventListener).call(confirm, { isTrusted: true } as Event);
  await new Promise((r) => setTimeout(r, 0));
  expect(cleared).toEqual([]);
});
