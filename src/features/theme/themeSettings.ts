/** Defines and persists LunaTOC's account-scoped theme preference. */
export type ResolvedTheme = 'dark' | 'light';

export interface ThemeSettings {
  /** Legacy storage field only; detection is removed and new writes always use false. */
  followChatGPT: boolean;
  manualTheme: ResolvedTheme;
}

import { SETTINGS_COMMIT_TYPE, type SettingsCommitResponse } from '@/features/storage/settingsWriteCoordinator';
import {
  isValidAccountOwnerId, readStoredAccountSettings,
  resolveAccountSettingsOwner,
} from '@/features/storage/accountSettings';
import { subscribeAccountPreference } from '@/features/storage/accountPreferenceSubscription';

const DEFAULT_SETTINGS: ThemeSettings = { followChatGPT: false, manualTheme: 'light' };

function normalizeThemeSettings(value: unknown): ThemeSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ThemeSettings>;
  if (typeof candidate.followChatGPT !== 'boolean' ||
      (candidate.manualTheme !== 'dark' && candidate.manualTheme !== 'light')) return null;
  // Legacy follow-ChatGPT preferences become the new light default; explicit manual choices survive.
  return candidate.followChatGPT
    ? { followChatGPT: false, manualTheme: 'light' }
    : { followChatGPT: false, manualTheme: candidate.manualTheme };
}

/** Reads only the selected account's theme; an unverified context gets safe defaults. */
export async function readThemeSettings(ownerId?: string): Promise<ThemeSettings> {
  const owner = ownerId ?? await resolveAccountSettingsOwner();
  if (!owner || !isValidAccountOwnerId(owner)) return { ...DEFAULT_SETTINGS };
  const record = await readStoredAccountSettings(owner);
  const raw = record && typeof record === 'object' && !Array.isArray(record)
    ? (record as Record<string, unknown>).theme : undefined;
  return normalizeThemeSettings(raw) ?? { ...DEFAULT_SETTINGS };
}

/** Saves a complete theme preference only for a known, verified account. */
export async function writeThemeSettings(settings: ThemeSettings, ownerId?: string): Promise<void> {
  if (!chrome.runtime?.id) throw new Error('Invalid extension context: theme setting not saved');
  const owner = ownerId ?? await resolveAccountSettingsOwner();
  if (!owner || !isValidAccountOwnerId(owner)) {
    throw new Error('无法确认当前 ChatGPT 账号，主题设置未保存。');
  }
  await new Promise<void>((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: SETTINGS_COMMIT_TYPE, action: 'theme', ownerId: owner, settings,
    }, (response: SettingsCommitResponse | undefined) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message ?? 'Settings writer unavailable'));
      else if (response?.ok) resolve();
      else reject(new Error(response && 'error' in response ? response.error : 'Settings writer did not confirm the save'));
    });
  });
}

/** Subscribes to one account's preference and follows verified account switches in page contexts. */
export function subscribeThemeSettings(
  listener: (settings: ThemeSettings) => void,
  ownerId?: string
): () => void {
  return subscribeAccountPreference(listener, readThemeSettings, (record) => {
    const raw = record && typeof record === 'object' && !Array.isArray(record)
      ? (record as Record<string, unknown>).theme : undefined;
    return normalizeThemeSettings(raw) ?? { ...DEFAULT_SETTINGS };
  }, () => ({ ...DEFAULT_SETTINGS }), ownerId);
}
