import { describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_RUNTIME_CONFIG_STORAGE_KEY,
  loadPlatformRuntimeConfig,
  platformRuntimeConfigKey,
  savePlatformRuntimeConfig,
} from '@/config/config';

describe('LunaTOC initial-release runtime configuration', () => {
  it('uses the LunaTOC namespace and reads only the current configuration', async () => {
    expect(platformRuntimeConfigKey('chatgpt')).toBe(CHATGPT_RUNTIME_CONFIG_STORAGE_KEY);
    const value = { useLocalConfig: true, showCompatibilityAlert: false };
    const get = vi.fn(async (key: unknown) =>
      key === CHATGPT_RUNTIME_CONFIG_STORAGE_KEY ? { [CHATGPT_RUNTIME_CONFIG_STORAGE_KEY]: value } : {});
    const set = vi.fn();
    const remove = vi.fn();
    const storage = { get, set, remove } as unknown as chrome.storage.StorageArea;
    expect(await loadPlatformRuntimeConfig('chatgpt', storage)).toEqual(value);
    expect(get).toHaveBeenCalledExactlyOnceWith(CHATGPT_RUNTIME_CONFIG_STORAGE_KEY);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not read or migrate unrelated stored keys', async () => {
    const get = vi.fn(async () => ({}));
    const set = vi.fn();
    const remove = vi.fn();
    const storage = { get, set, remove } as unknown as chrome.storage.StorageArea;
    const loaded = await loadPlatformRuntimeConfig('chatgpt', storage);
    expect(loaded).toMatchObject({
      useLocalConfig: expect.any(Boolean),
      showCompatibilityAlert: expect.any(Boolean),
    });
    expect(get).toHaveBeenCalledExactlyOnceWith(CHATGPT_RUNTIME_CONFIG_STORAGE_KEY);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await savePlatformRuntimeConfig('chatgpt', { useLocalConfig: true }, storage);
    expect(set).toHaveBeenCalledWith({
      [CHATGPT_RUNTIME_CONFIG_STORAGE_KEY]: {
        useLocalConfig: true,
        showCompatibilityAlert: loaded.showCompatibilityAlert,
      },
    });
  });
});
