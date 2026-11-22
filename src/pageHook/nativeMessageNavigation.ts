/** Read-only discovery of the host virtual list's semantic navigation API. */
import { applyChatGptPromptScrollMargin } from '@/platforms/chatgpt/nativeMessageLanding';
export interface NativeTurnList {
  scrollToKey(key: string, target: (row: HTMLElement) => HTMLElement | null,
    options: { align: 'top'; signal: AbortSignal }): Promise<void>;
  getRowElement(key: string): HTMLElement | null;
  getEntryGeometry(key: string): unknown;
}

interface Fiber {
  return?: Fiber | null;
  alternate?: Fiber | null;
  memoizedProps?: { rows?: unknown[]; getRowKey?: unknown };
  memoizedState?: { memoizedState?: unknown; next?: unknown } | null;
}

function fiberOf(element: HTMLElement): Fiber | null {
  const key = Object.getOwnPropertyNames(element).find(name =>
    name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
  return key ? (element as unknown as Record<string, Fiber>)[key] : null;
}

function isTurnList(value: unknown): value is NativeTurnList {
  if (!value || typeof value !== 'object') return false;
  const api = value as Partial<NativeTurnList>;
  return typeof api.scrollToKey === 'function' && typeof api.getRowElement === 'function' &&
    typeof api.getEntryGeometry === 'function';
}

/** React snapshots may be direct values, atom tuples, or refs. No store is mutated. */
function findApi(value: unknown, owns: (api: NativeTurnList) => boolean, budget: { left: number }, depth = 0): NativeTurnList | null {
  if (budget.left-- <= 0) return null;
  if (isTurnList(value) && owns(value)) return value;
  if (depth >= 3 || !value || typeof value !== 'object') return null;
  const children = Array.isArray(value) ? value.slice(0, 32)
    : Object.hasOwn(value, 'current') ? [(value as { current: unknown }).current] : [];
  for (const child of children) {
    const found = findApi(child, owns, budget, depth + 1);
    if (found) return found;
  }
  return null;
}

export function findNativeMessageNavigation(container: HTMLElement, messageId: string): {
  api: NativeTurnList; turnKey: string;
} | null {
  // The feed itself is above the virtual list. Start at an actual mounted row.
  const row = container.querySelector<HTMLElement>('[data-turn-key]');
  const mountedKey = row?.getAttribute('data-turn-key');
  if (!row || !mountedKey) return null;
  let turnKey: string | null = null;
  let api: NativeTurnList | null = null;
  const owns = (candidate: NativeTurnList): boolean => {
    try { return candidate.getRowElement(mountedKey) === row; } catch { return false; }
  };
  for (let fiber = fiberOf(row), depth = 0; fiber && depth < 100; fiber = fiber.return ?? null, depth++) {
    // DOM bindings can point to either committed Fiber after an update.
    for (const current of [fiber, fiber.alternate]) {
      if (!current) continue;
      const props = current.memoizedProps;
      if (!turnKey && Array.isArray(props?.rows) && typeof props.getRowKey === 'function') {
        for (const value of props.rows.slice(0, 20000)) {
          if (!value || typeof value !== 'object') continue;
          const entry = value as { turnKey?: unknown; turn?: { messageIds?: unknown } };
          if (typeof entry.turnKey === 'string' && Array.isArray(entry.turn?.messageIds) &&
            entry.turn.messageIds.includes(messageId)) {
            turnKey = entry.turnKey;
            break;
          }
        }
      }
      let hook = current.memoizedState;
      for (let count = 0; hook && count < 200; count++) {
        api ??= findApi(hook.memoizedState, owns, { left: 256 });
        hook = hook.next as typeof hook;
      }

      if (api && turnKey) {
        // An alternate Fiber may describe a previous branch's row list.
        return api.getEntryGeometry(turnKey) == null ? null : { api, turnKey };
      }
    }
  }
  return null;
}

/** Match the exact message; never substitute the entire turn on a miss. */
export function findNativeMessageTarget(row: HTMLElement, id: string, edge: 'top' | 'bottom'): HTMLElement | null {
  const elements = Array.from(row.querySelectorAll<HTMLElement>('[data-chatgpt-search-message-ids]'));
  const prompt = elements.find(element =>
    element.getAttribute('data-chatgpt-search-unit-key')?.endsWith(':user') &&
    element.getAttribute('data-chatgpt-search-message-ids')?.split(/\s+/).includes(id));
  if (!prompt) return null;
  if (edge === 'top') {
    applyChatGptPromptScrollMargin(prompt);
    return prompt;
  }
  return elements.find(element =>
    element.getAttribute('data-chatgpt-search-unit-key')?.endsWith(':assistant') &&
    Boolean(prompt.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) ?? prompt;
}
