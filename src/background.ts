/**
 * Service-worker bridge for per-tab compatibility warnings in Chrome's toolbar.
 */
import {
  PROMPT_COMMIT_TYPE, PROMPT_STORAGE_KEY, createPromptWriteCoordinator,
} from '@/features/myPrompts/promptWriteCoordinator';
import { PROMPT_USAGE_COMMIT_TYPE, createPromptUsageWriteCoordinator } from '@/features/myPrompts/promptUsageWriteCoordinator';
import { SETTINGS_COMMIT_TYPE, createSettingsWriteCoordinator } from '@/features/storage/settingsWriteCoordinator';
import { createSerialWriteQueue } from '@/features/storage/serialWriteQueue';
import {
  BACKUP_STORAGE_MESSAGE_TYPE, createLocalBackup, restoreLocalBackup,
  type BackupStorageMessage, type BackupStorageResponse, type LocalBackup,
} from '@/features/backup/localBackup';
import {
  TOC_ALIAS_COMMIT_TYPE, TOC_ALIAS_PREFIX, TOC_ALIAS_DELETED_PREFIX,
  createTocAliasWriteCoordinator,
} from '@/features/conversationPrompts/tocAliasWriteCoordinator';
import {
  TOOLBAR_COMPATIBILITY_WARNING,
  TOOLBAR_COMPATIBILITY_HEALTHY,
} from '@/features/contractAlert/toolbarWarning';
import { createToolbarWarningController } from '@/features/contractAlert/toolbarBackground';
import { installRemoteDeletionObserver } from '@/background/remoteDeletionObserver';
import { createCloudController, CLOUD_MESSAGE_TYPE, CLOUD_AUTO_SYNC_KEY } from '@/features/cloud/cloudController';
import { ACCOUNT_SETTINGS_KEY, GET_ACTIVE_ACCOUNT_OWNER_MESSAGE } from '@/features/storage/accountSettings';

// Observe only actual successful ChatGPT delete/visibility-removal mutations in the browser network layer.
// The observer never stores request bodies and only sends a route ID to the originating tab.
installRemoteDeletionObserver();

const toolbar = createToolbarWarningController(chrome.storage.session, chrome.action);
const storageWriteQueue = createSerialWriteQueue();
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!message || typeof message !== 'object') return;
  const payload = message as { type?: unknown; detail?: unknown; revision?: unknown };
  const kind = payload.type === TOOLBAR_COMPATIBILITY_WARNING ? 'warning'
    : payload.type === TOOLBAR_COMPATIBILITY_HEALTHY ? 'healthy' : null;
  if (!kind) return;
  const tabId = sender.tab?.id;
  if (tabId === undefined ||
      sender.frameId !== 0 ||
      (sender.documentLifecycle && sender.documentLifecycle !== 'active') ||
      !/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/.test(sender.url ?? '') ||
      !Number.isSafeInteger(payload.revision) ||
      (payload.revision as number) < 1 ||
      (kind === 'warning' &&
        (typeof payload.detail !== 'string' || !payload.detail.trim()))) return;

  void toolbar.update(tabId, {
    kind,
    revision: payload.revision as number,
    documentId: sender.documentId ?? '',
    detail: kind === 'warning' ? (payload.detail as string).slice(0, 180) : undefined,
  }).catch(() => {
    // A tab can close or an extension context can expire during async updates.
  });
});

/** Discard previous-document warnings during a full navigation. */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  void toolbar.clear(tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void toolbar.clear(tabId, false).catch(() => {});
});

/**
 * Handle prompt writes only from this extension. Returning true keeps the
 * MV3 message event alive until the queued storage write has completed.
 */
const promptCoordinator = createPromptWriteCoordinator(chrome.storage.local, storageWriteQueue);
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' ||
      (message as { type?: unknown }).type !== PROMPT_COMMIT_TYPE) return;
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'Untrusted extension message sender' });
    return false;
  }
  void promptCoordinator.commit(message).then(sendResponse, () =>
    sendResponse({ ok: false, error: 'Prompt storage writer unavailable' })
  );
  return true;
});

/** Orders TOC alias mutations and confirmed deletion fences with backup writes. */
const tocAliasCoordinator = createTocAliasWriteCoordinator(chrome.storage.local, storageWriteQueue);
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' ||
      (message as { type?: unknown }).type !== TOC_ALIAS_COMMIT_TYPE) return;
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'Untrusted extension message sender' });
    return false;
  }
  void tocAliasCoordinator.commit(message).then(sendResponse, () =>
    sendResponse({ ok: false, error: 'TOC alias writer unavailable' })
  );
  return true;
});


const promptUsageCoordinator = createPromptUsageWriteCoordinator(chrome.storage.local, storageWriteQueue);
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' ||
      (message as { type?: unknown }).type !== PROMPT_USAGE_COMMIT_TYPE) return;
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'Untrusted extension message sender' });
    return false;
  }
  void promptUsageCoordinator.commit(message).then(sendResponse, () =>
    sendResponse({ ok: false, error: 'Prompt usage writer unavailable' })
  );
  return true;
});

const settingsCoordinator = createSettingsWriteCoordinator(chrome.storage.local, storageWriteQueue);
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' ||
      (message as { type?: unknown }).type !== SETTINGS_COMMIT_TYPE) return;
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'Untrusted extension message sender' });
    return false;
  }
  const action = (message as { action?: unknown }).action;
  if (action === 'register-account' &&
      (sender.tab?.id === undefined || sender.frameId !== 0 ||
       (sender.documentLifecycle && sender.documentLifecycle !== 'active') ||
       !/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/.test(sender.url ?? ''))) {
    sendResponse({ ok: false, error: 'Account registration requires an active ChatGPT content context' });
    return false;
  }
  void settingsCoordinator.commit(message).then(sendResponse, () =>
    sendResponse({ ok: false, error: 'Settings writer unavailable' })
  );
  return true;
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' ||
      (message as { type?: unknown }).type !== BACKUP_STORAGE_MESSAGE_TYPE) return;
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'Untrusted extension message sender' });
    return false;
  }
  const request = message as BackupStorageMessage;
  void storageWriteQueue.run(async (): Promise<BackupStorageResponse> => {
    if (request.action === 'export') {
      return { ok: true, backup: await createLocalBackup(chrome.storage.local) };
    }
    if (request.action !== 'restore' ||
        (request.mode !== 'merge' && request.mode !== 'replace')) {
      return { ok: false, error: 'Invalid backup request' };
    }
    await restoreLocalBackup(request.backup as LocalBackup, request.mode, chrome.storage.local);
    return { ok: true };
  }).then(sendResponse, (error: unknown) => sendResponse({
    ok: false, error: error instanceof Error ? error.message : 'Local backup operation failed',
  }));
  return true;
});


/** Only an extension options document may submit Firebase credentials or sync commands. */
async function hasVerifiedChatGptOwner(ownerId: string): Promise<boolean> {
  if (!ownerId) return false;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({
      url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    });
  } catch { return false; }
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: GET_ACTIVE_ACCOUNT_OWNER_MESSAGE,
      }) as { ownerId?: unknown } | undefined;
      if (response?.ownerId === ownerId) return true;
    } catch { /* A ChatGPT tab can be loading or lack the content script. */ }
  }
  return false;
}

const cloudController = createCloudController(
  chrome.storage.local, chrome.storage.session, storageWriteQueue, hasVerifiedChatGptOwner
);

// Automatic sync is opt-in. Local changes are uploaded only after a Google
// identity has authenticated with the maintainer's Firebase project.
async function findVerifiedChatGptOwners(): Promise<string[]> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
  } catch { return []; }
  const owners = new Set<string>();
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: GET_ACTIVE_ACCOUNT_OWNER_MESSAGE,
      }) as { ownerId?: unknown } | undefined;
      if (typeof response?.ownerId === 'string' && response.ownerId) owners.add(response.ownerId);
    } catch { /* A tab may be loading or not yet have a content script. */ }
  }
  return [...owners];
}

let autoSyncRunning = false;
let autoSyncPending = false;
async function runAutomaticSync(): Promise<void> {
  if (autoSyncRunning) {
    autoSyncPending = true;
    return;
  }
  autoSyncRunning = true;
  try {
    do {
      autoSyncPending = false;
      const enabled = await chrome.storage.local.get(CLOUD_AUTO_SYNC_KEY);
      if (enabled[CLOUD_AUTO_SYNC_KEY] !== true) break;
      // Browser session storage is cleared on restart. Reuse an already
      // authorized Chrome Google token silently; never open an unexpected login window.
      const authStatus = await cloudController.execute({ type: CLOUD_MESSAGE_TYPE, action: 'status' });
      if (!authStatus.ok || authStatus.configured !== true) break;
      if (!authStatus.uid) {
        try {
          const auth = await chrome.identity.getAuthToken({ interactive: false });
          const accessToken = typeof auth === 'string' ? auth : auth?.token;
          if (!accessToken) break;
          const login = await cloudController.execute({
            type: CLOUD_MESSAGE_TYPE, action: 'google-sign-in', accessToken,
          });
          if (!login.ok) {
            console.warn('LunaTOC automatic cloud re-authentication failed:', login.error);
            break;
          }
        } catch {
          // The user may need to enable sync again if Chrome has no cached consent.
          break;
        }
      }
      const owners = await findVerifiedChatGptOwners();
      for (const ownerId of owners) {
        const result = await cloudController.execute({
          type: CLOUD_MESSAGE_TYPE, action: 'sync', ownerId,
        });
        if (!result.ok) {
          // Keep local work intact. The settings page remains the place to
          // inspect a manual retry; automatic failures never erase local data.
          console.warn('LunaTOC automatic cloud sync skipped:', result.error);
        }
      }
    } while (autoSyncPending);
  } finally {
    autoSyncRunning = false;
    if (autoSyncPending) void runAutomaticSync();
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const relevant = Object.keys(changes).some((key) =>
    key === PROMPT_STORAGE_KEY || key === ACCOUNT_SETTINGS_KEY ||
    key.startsWith(TOC_ALIAS_PREFIX) || key.startsWith(TOC_ALIAS_DELETED_PREFIX)
  );
  if (relevant) void runAutomaticSync();
});

// Opening or switching to ChatGPT makes that account eligible for sync once
// the content script can verify its identity.
chrome.tabs.onActivated.addListener(() => { void runAutomaticSync(); });
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' &&
      /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/.test(tab.url ?? '')) {
    void runAutomaticSync();
  }
});
chrome.runtime.onStartup.addListener(() => { void runAutomaticSync(); });
chrome.runtime.onInstalled.addListener(() => { void runAutomaticSync(); });

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' ||
      (message as { type?: unknown }).type !== CLOUD_MESSAGE_TYPE) return;
  // A content script is an extension sender too: only the actual options page
  // is authorized to pass credentials or trigger cross-device transfers.
  const optionsUrl = chrome.runtime.getURL('src/options/options.html');
  if (sender.id !== chrome.runtime.id || sender.url !== optionsUrl) {
    sendResponse({ ok: false, error: 'Firebase 操作只允许从扩展设置页执行' });
    return false;
  }
  void cloudController.execute(message).then(sendResponse, () =>
    sendResponse({ ok: false, error: 'Firebase 服务暂不可用' })
  );
  return true;
});
