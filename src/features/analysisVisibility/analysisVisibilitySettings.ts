/** Global, device-local preference for hiding ChatGPT analysis disclosures. */
export const ANALYSIS_HIDE_ENABLED_KEY = 'lunatoc:chatgpt:analysisHideEnabled:v1';
export const DEFAULT_ANALYSIS_HIDE_ENABLED = true;

export async function readAnalysisHideEnabled(
  storage: Pick<chrome.storage.StorageArea, 'get'> = chrome.storage.local
): Promise<boolean> {
  const values = await storage.get(ANALYSIS_HIDE_ENABLED_KEY);
  const value: unknown = values?.[ANALYSIS_HIDE_ENABLED_KEY];
  return typeof value === 'boolean' ? value : DEFAULT_ANALYSIS_HIDE_ENABLED;
}

export async function writeAnalysisHideEnabled(
  enabled: boolean,
  storage: Pick<chrome.storage.StorageArea, 'set'> = chrome.storage.local
): Promise<void> {
  await storage.set({ [ANALYSIS_HIDE_ENABLED_KEY]: enabled });
}

export function subscribeAnalysisHideEnabled(listener: (enabled: boolean) => void): () => void {
  const handleChange = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !Object.hasOwn(changes, ANALYSIS_HIDE_ENABLED_KEY)) return;
    const value: unknown = changes[ANALYSIS_HIDE_ENABLED_KEY]?.newValue;
    listener(typeof value === 'boolean' ? value : DEFAULT_ANALYSIS_HIDE_ENABLED);
  };
  chrome.storage.onChanged.addListener(handleChange);
  return () => chrome.storage.onChanged.removeListener(handleChange);
}
