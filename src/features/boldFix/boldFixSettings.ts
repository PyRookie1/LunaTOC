/** Global, device-local preference for ChatGPT Markdown bold repair. */
export const BOLD_FIX_ENABLED_KEY = 'lunatoc:chatgpt:boldFixEnabled:v1';
export const DEFAULT_BOLD_FIX_ENABLED = true;

export type BoldFixSettingsStorage = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

/** Reads the global setting; missing or malformed values use the enabled default. */
export async function readBoldFixEnabled(
  storage: Pick<chrome.storage.StorageArea, 'get'> = chrome.storage.local
): Promise<boolean> {
  const values = await storage.get(BOLD_FIX_ENABLED_KEY);
  const stored = values?.[BOLD_FIX_ENABLED_KEY] as unknown;
  return typeof stored === 'boolean' ? stored : DEFAULT_BOLD_FIX_ENABLED;
}

/** Persists the global setting independently of account-scoped sidebar preferences. */
export async function writeBoldFixEnabled(
  enabled: boolean,
  storage: Pick<chrome.storage.StorageArea, 'set'> = chrome.storage.local
): Promise<void> {
  await storage.set({ [BOLD_FIX_ENABLED_KEY]: enabled });
}

/** Follows changes made by this options page or another extension context. */
export function subscribeBoldFixEnabled(listener: (enabled: boolean) => void): () => void {
  const handleChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ): void => {
    if (areaName !== 'local' || !Object.hasOwn(changes, BOLD_FIX_ENABLED_KEY)) return;
    const stored = changes[BOLD_FIX_ENABLED_KEY]?.newValue as unknown;
    listener(typeof stored === 'boolean' ? stored : DEFAULT_BOLD_FIX_ENABLED);
  };

  chrome.storage.onChanged.addListener(handleChange);
  return () => chrome.storage.onChanged.removeListener(handleChange);
}
