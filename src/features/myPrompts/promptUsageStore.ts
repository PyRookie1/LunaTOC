/**
 * Persists local usage statistics used to rank My Prompts autocomplete items.
 * Mutations are committed by the extension background to prevent lost updates
 * when multiple ChatGPT tabs record usage at the same time.
 */
import { getActiveConversationOwner } from '@/navigation/lifecycle/conversationOwner';
import { isPromptList, PROMPT_STORAGE_KEY } from './promptWriteCoordinator';
import {
  PROMPT_USAGE_COMMIT_TYPE,
  type PromptUsageCommitResponse,
} from './promptUsageWriteCoordinator';

const STORAGE_KEY = 'lunaToc:promptUsageV1';
export interface PromptUsage { usageCount: number; lastUsedAt: number; }
export type PromptUsageMap = Record<string, PromptUsage>;
export interface PromptUsageStore {
  getAll(): Promise<PromptUsageMap>;
  recordUse(promptId: string): Promise<void>;
  remove(promptId: string): Promise<void>;
  clear(): Promise<void>;
  reconcile(validPromptIds: string[]): Promise<void>;
}

export function createPromptUsageStore(): PromptUsageStore {
  let cache: PromptUsageMap = {};
  let hydratePromise: Promise<PromptUsageMap> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();
  const copyCache = (): PromptUsageMap => ({ ...cache });
  const hydrate = (): Promise<PromptUsageMap> => {
    if (!hydratePromise) hydratePromise = readUsage().then((usage) => {
      cache = usage;
      return copyCache();
    });
    return hydratePromise;
  };
  const publish = (usage: PromptUsageMap): void => {
    cache = normalizeUsageMap(usage);
    hydratePromise = Promise.resolve(copyCache());
  };
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const task = writeQueue.catch(() => undefined).then(operation);
    writeQueue = task.catch(() => undefined);
    return task;
  };
  const commit = (request: { action: 'record-use' | 'remove'; promptId: string } |
    { action: 'clear' } | { action: 'reconcile'; validPromptIds: string[] }): Promise<PromptUsageMap> => {
    if (!isContextValid()) return Promise.reject(new Error('Invalid extension context: usage not saved'));
    const ownerId = getActiveConversationOwner();
    if (!ownerId) return Promise.reject(new Error('ChatGPT account not verified; usage not saved'));
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: PROMPT_USAGE_COMMIT_TYPE, ...request, ownerId },
        (response: PromptUsageCommitResponse | undefined) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message ?? 'Prompt usage writer unavailable'));
          } else if (response?.ok === true) {
            if (getActiveConversationOwner() !== ownerId) {
              reject(new Error('ChatGPT account changed; usage response ignored'));
              return;
            }
            resolve(normalizeUsageMap(response.usage));
          } else {
            reject(new Error(response && 'error' in response ? response.error : 'Prompt usage writer did not confirm the save'));
          }
        });
    });
  };

  if (isContextValid()) chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[STORAGE_KEY]) return;
    cache = normalizeUsageMap(changes[STORAGE_KEY].newValue);
    hydratePromise = Promise.resolve(copyCache());
  });

  return {
    getAll: async () => {
      const ownerId = getActiveConversationOwner();
      if (!ownerId || !isContextValid()) return {};
      const usage = await hydrate();
      const stored = await chrome.storage.local.get(PROMPT_STORAGE_KEY);
      const raw: unknown = stored[PROMPT_STORAGE_KEY];
      if (raw !== undefined && !isPromptList(raw)) {
        throw new Error('Prompt storage contains invalid data; usage cannot be displayed');
      }
      if (getActiveConversationOwner() !== ownerId) return {};
      const ids = (raw ?? [] as { id: string; ownerId: string }[])
        .filter((prompt) => prompt.ownerId === ownerId).map((prompt) => prompt.id);
      return filterUsageForPrompts(usage, ids);
    },
    recordUse: (promptId) => enqueue(async () => { await hydrate(); publish(await commit({ action: 'record-use', promptId })); }),
    remove: (promptId) => enqueue(async () => { await hydrate(); publish(await commit({ action: 'remove', promptId })); }),
    clear: () => enqueue(async () => { await hydrate(); publish(await commit({ action: 'clear' })); }),
    reconcile: (validPromptIds) => enqueue(async () => {
      await hydrate();
      publish(await commit({ action: 'reconcile', validPromptIds: [...validPromptIds] }));
    }),
  };
}
export function filterUsageForPrompts(usage: PromptUsageMap, validPromptIds: readonly string[]): PromptUsageMap {
  const valid = new Set(validPromptIds);
  return Object.fromEntries(Object.entries(usage).filter(([id]) => valid.has(id)));
}
function isContextValid(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
}
function normalizeUsageMap(value: unknown): PromptUsageMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, PromptUsage] => {
    const usage = entry[1] as Partial<PromptUsage> | null;
    return !!usage && Number.isSafeInteger(usage.usageCount) && usage.usageCount! >= 0 &&
      Number.isSafeInteger(usage.lastUsedAt) && usage.lastUsedAt! >= 0;
  }));
}
function readUsage(): Promise<PromptUsageMap> {
  if (!isContextValid()) return Promise.resolve({});
  return new Promise((resolve) => chrome.storage.local.get(STORAGE_KEY, (result) => {
    if (chrome.runtime.lastError) { resolve({}); return; }
    resolve(normalizeUsageMap(result[STORAGE_KEY]));
  }));
}
