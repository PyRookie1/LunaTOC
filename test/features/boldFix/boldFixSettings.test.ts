import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOLD_FIX_ENABLED_KEY,
  DEFAULT_BOLD_FIX_ENABLED,
  readBoldFixEnabled,
  subscribeBoldFixEnabled,
  writeBoldFixEnabled,
} from '@/features/boldFix/boldFixSettings';

let storedValue: unknown;
const storageEvents: { listener?: (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string
) => void } = {};
let getStorage: ReturnType<typeof vi.fn>;
let setStorage: ReturnType<typeof vi.fn>;
let removeChangeListener: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storedValue = undefined;
  delete storageEvents.listener;
  getStorage = vi.fn(async (key: string) =>
    storedValue === undefined ? {} : { [key]: storedValue }
  );
  setStorage = vi.fn(async (items: Record<string, unknown>) => {
    storedValue = items[BOLD_FIX_ENABLED_KEY];
  });
  removeChangeListener = vi.fn();
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: getStorage, set: setStorage },
      onChanged: {
        addListener: vi.fn((listener: (
          changes: Record<string, chrome.storage.StorageChange>,
          areaName: string
        ) => void) => {
          storageEvents.listener = listener;
        }),
        removeListener: removeChangeListener,
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('boldFixSettings', () => {
  it('defaults to enabled when the preference has not been saved', async () => {
    await expect(readBoldFixEnabled()).resolves.toBe(DEFAULT_BOLD_FIX_ENABLED);
  });

  it('uses only a stored boolean and treats malformed values as the default', async () => {
    storedValue = false;
    await expect(readBoldFixEnabled()).resolves.toBe(false);
    storedValue = 'false';
    await expect(readBoldFixEnabled()).resolves.toBe(DEFAULT_BOLD_FIX_ENABLED);
  });

  it('writes the global preference under its dedicated local-storage key', async () => {
    await writeBoldFixEnabled(false);
    expect(setStorage).toHaveBeenCalledWith({ [BOLD_FIX_ENABLED_KEY]: false });
    await expect(readBoldFixEnabled()).resolves.toBe(false);
  });

  it('publishes local preference changes and restores the default when the key is removed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBoldFixEnabled(listener);
    storageEvents.listener?.({
      [BOLD_FIX_ENABLED_KEY]: { oldValue: true, newValue: false },
    }, 'local');
    storageEvents.listener?.({
      [BOLD_FIX_ENABLED_KEY]: { oldValue: false },
    }, 'local');
    storageEvents.listener?.({
      [BOLD_FIX_ENABLED_KEY]: { oldValue: true, newValue: false },
    }, 'sync');

    expect(listener).toHaveBeenNthCalledWith(1, false);
    expect(listener).toHaveBeenNthCalledWith(2, DEFAULT_BOLD_FIX_ENABLED);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(removeChangeListener).toHaveBeenCalledTimes(1);
  });
});
