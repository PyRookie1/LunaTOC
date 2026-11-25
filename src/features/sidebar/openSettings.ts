/** Ask the extension service worker to open the options page from a content script. */
export const OPEN_SETTINGS_MESSAGE = 'LUNA_TOC_OPEN_SETTINGS_V1';

export function openSettingsFromConversation(): void {
  void chrome.runtime.sendMessage({ type: OPEN_SETTINGS_MESSAGE }).catch(() => {
    // The extension context may be unavailable during an update or tab close.
  });
}
