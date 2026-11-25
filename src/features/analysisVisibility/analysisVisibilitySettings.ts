/** Global, device-local opt-in for hiding ChatGPT analysis disclosures. */
export const ANALYSIS_HIDE_ENABLED_KEY = 'lunatoc:chatgpt:analysisHideEnabled:v1';
export const DEFAULT_ANALYSIS_HIDE_ENABLED = false;

export async function readAnalysisHideEnabled(
  storage: Pick<chrome.storage.StorageArea, 'get'> = chrome.storage.local
): Promise<boolean> {
  const values = await storage.get(ANALYSIS_HIDE_ENABLED_KEY);
  return values?.[ANALYSIS_HIDE_ENABLED_KEY] === true;
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
    listener(changes[ANALYSIS_HIDE_ENABLED_KEY]?.newValue === true);
  };
  chrome.storage.onChanged.addListener(handleChange);
  return () => chrome.storage.onChanged.removeListener(handleChange);
}
