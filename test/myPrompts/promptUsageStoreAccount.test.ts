/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPromptUsageStore } from '@/features/myPrompts/promptUsageStore';
import { PROMPT_USAGE_COMMIT_TYPE } from '@/features/myPrompts/promptUsageWriteCoordinator';
import { setActiveConversationOwner } from '@/navigation/lifecycle/conversationOwner';
import { PROMPT_STORAGE_KEY } from '@/features/myPrompts/promptWriteCoordinator';

const prompts = [
  { id: 'mine', ownerId: 'account-1', title: 'Mine', content: 'content', createdAt: 1, updatedAt: 1 },
  { id: 'theirs', ownerId: 'account-2', title: 'Theirs', content: 'content', createdAt: 2, updatedAt: 2 },
];
const usage = {
  mine: { usageCount: 3, lastUsedAt: 5 },
  theirs: { usageCount: 8, lastUsedAt: 6 },
};

beforeEach(() => {
  setActiveConversationOwner('account-1');
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'lunatoc-extension',
      lastError: null,
      sendMessage: vi.fn((_request: unknown, callback: (response: unknown) => void) =>
        callback({ ok: true, usage })),
    },
    storage: {
      local: {
        get: vi.fn((
          keys: string | string[],
          callback?: (result: Record<string, unknown>) => void
        ) => {
          const result = Array.isArray(keys) || keys === PROMPT_STORAGE_KEY
            ? { [PROMPT_STORAGE_KEY]: prompts }
            : { 'lunaToc:promptUsageV1': usage };
          if (callback) { callback(result); return; }
          return Promise.resolve(result);
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setActiveConversationOwner(null);
});

describe('account-bound prompt usage visibility', () => {
  it('shows statistics only for prompts owned by the verified account', async () => {
    const store = createPromptUsageStore();
    expect(await store.getAll()).toEqual({ mine: usage.mine });
    setActiveConversationOwner('account-2');
    expect(await store.getAll()).toEqual({ theirs: usage.theirs });
    setActiveConversationOwner(null);
    expect(await store.getAll()).toEqual({});
  });

  it('rejects usage writes without account verification', async () => {
    const store = createPromptUsageStore();
    setActiveConversationOwner(null);
    await expect(store.recordUse('mine')).rejects.toThrow('not verified');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('adds the verified owner to every usage write request', async () => {
    const store = createPromptUsageStore();
    await store.recordUse('mine');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: PROMPT_USAGE_COMMIT_TYPE, action: 'record-use', promptId: 'mine', ownerId: 'account-1' },
      expect.any(Function),
    );
  });
});
