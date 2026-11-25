import { describe, expect, it, vi } from 'vitest';
import {
  ANALYSIS_HIDE_ENABLED_KEY,
  readAnalysisHideEnabled,
  subscribeAnalysisHideEnabled,
  writeAnalysisHideEnabled,
} from '@/features/analysisVisibility/analysisVisibilitySettings';

describe('analysis visibility preference', () => {
  it('defaults to enabled and preserves a saved disabled choice', async () => {
    await expect(readAnalysisHideEnabled({ get: async () => ({}) } as never)).resolves.toBe(true);
    await expect(readAnalysisHideEnabled({ get: async () => ({ [ANALYSIS_HIDE_ENABLED_KEY]: false }) } as never)).resolves.toBe(false);
    await expect(readAnalysisHideEnabled({ get: async () => ({ [ANALYSIS_HIDE_ENABLED_KEY]: 'invalid' }) } as never)).resolves.toBe(true);
  });

  it('persists changes and notifies other extension contexts', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await writeAnalysisHideEnabled(false, { set } as never);
    expect(set).toHaveBeenCalledWith({ [ANALYSIS_HIDE_ENABLED_KEY]: false });

    let changed!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
    const removeListener = vi.fn();
    vi.stubGlobal('chrome', { storage: { onChanged: {
      addListener: (listener: typeof changed) => { changed = listener; }, removeListener,
    } } });
    try {
      const listener = vi.fn();
      const unsubscribe = subscribeAnalysisHideEnabled(listener);
      changed({ [ANALYSIS_HIDE_ENABLED_KEY]: { oldValue: true, newValue: false } }, 'local');
      expect(listener).toHaveBeenCalledExactlyOnceWith(false);
      changed({ [ANALYSIS_HIDE_ENABLED_KEY]: { oldValue: false } }, 'local');
      expect(listener).toHaveBeenLastCalledWith(true);
      unsubscribe();
      expect(removeListener).toHaveBeenCalledWith(changed);
    } finally { vi.unstubAllGlobals(); }
  });
});
