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
import { createCloudController, CLOUD_MESSAGE_TYPE, CLOUD_AUTO_SYNC_KEY, CLOUD_AUTO_SYNC_STATUS_KEY } from '@/features/cloud/cloudController';
import { ACCOUNT_SETTINGS_KEY, GET_ACTIVE_ACCOUNT_OWNER_MESSAGE, isValidAccountOwnerId } from '@/features/storage/accountSettings';
import {
  CLOUD_RETRY_ALARM, CLOUD_RETRY_STATE_KEY, CLOUD_POLL_ALARM, CLOUD_POLL_MINUTES,
  cloudRetryDelayMs, isTransientCloudError, parseCloudRetryState,
} from '@/features/cloud/cloudRetry';

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
  void (async () => {
    const ownerId = (message as { ownerId?: unknown }).ownerId;
    if (!isValidAccountOwnerId(ownerId) || !(await hasVerifiedChatGptOwner(ownerId, sender.tab?.id))) {
      return { ok: false, error: 'ChatGPT account not verified; prompt write refused' };
    }
    return promptCoordinator.commit(message);
  })().then(sendResponse, () =>
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
  void (async () => {
    const request = message as { ownerId?: unknown; action?: unknown; expected?: { ownerId?: unknown } };
    const ownerId = request.action === 'cleanup-conversation'
      ? request.expected?.ownerId : request.ownerId;
    if (!isValidAccountOwnerId(ownerId) || !(await hasVerifiedChatGptOwner(ownerId, sender.tab?.id))) {
      return { ok: false, error: 'ChatGPT account not verified; alias update refused' };
    }
    return tocAliasCoordinator.commit(message);
  })().then(sendResponse, () =>
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
  void (async () => {
    const ownerId = (message as { ownerId?: unknown }).ownerId;
    if (!isValidAccountOwnerId(ownerId) || !(await hasVerifiedChatGptOwner(ownerId, sender.tab?.id))) {
      return { ok: false, error: 'ChatGPT account not verified; usage update refused' };
    }
    return promptUsageCoordinator.commit(message);
  })().then(sendResponse, () =>
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
  void (async () => {
    const ownerId = (message as { ownerId?: unknown }).ownerId;
    if (!isValidAccountOwnerId(ownerId) || !(await hasVerifiedChatGptOwner(ownerId, sender.tab?.id))) {
      return { ok: false, error: 'ChatGPT account not verified; settings update refused' };
    }
    return settingsCoordinator.commit(message);
  })().then(sendResponse, () =>
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


/** Only an extension options document may submit email verification or sync commands. */
async function hasVerifiedChatGptOwner(ownerId: string, sourceTabId?: number): Promise<boolean> {
  if (!ownerId) return false;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({
      url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    });
  } catch { return false; }
  for (const tab of tabs) {
    if (tab.id === undefined || (sourceTabId !== undefined && tab.id !== sourceTabId)) continue;
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
  chrome.storage.local, chrome.storage.local, storageWriteQueue, hasVerifiedChatGptOwner
);

// Automatic sync is opt-in. Local changes are uploaded only after a verified Firebase email/password identity has authenticated with the maintainer's project.
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

/**
 * Alarms, rather than in-memory timeouts alone, keep pending cloud work alive
 * across Manifest V3 service-worker suspension and browser restarts.
 */
async function armCloudRetry(attempt: number): Promise<void> {
  const enabled = await chrome.storage.local.get(CLOUD_AUTO_SYNC_KEY);
  if (enabled[CLOUD_AUTO_SYNC_KEY] !== true) return;
  const nextRetryAt = Date.now() + cloudRetryDelayMs(attempt);
  await chrome.storage.local.set({
    [CLOUD_RETRY_STATE_KEY]: { pending: true, attempt: Math.min(attempt, 100), nextRetryAt },
  });
  await chrome.alarms.create(CLOUD_RETRY_ALARM, { when: nextRetryAt });
}

async function clearCloudRetry(): Promise<void> {
  await chrome.storage.local.remove(CLOUD_RETRY_STATE_KEY);
  await chrome.alarms.clear(CLOUD_RETRY_ALARM);
}

async function refreshCloudPolling(): Promise<void> {
  const enabled = await chrome.storage.local.get(CLOUD_AUTO_SYNC_KEY);
  if (enabled[CLOUD_AUTO_SYNC_KEY] === true) {
    await chrome.alarms.create(CLOUD_POLL_ALARM, {
      delayInMinutes: CLOUD_POLL_MINUTES,
      periodInMinutes: CLOUD_POLL_MINUTES,
    });
    // Chrome may clear alarms after restart or extension updates. Rehydrate
    // pending work from persistent storage instead of trusting alarm persistence.
    const stored = await chrome.storage.local.get(CLOUD_RETRY_STATE_KEY);
    const pending = parseCloudRetryState(stored[CLOUD_RETRY_STATE_KEY]);
    if (pending) {
      await chrome.alarms.create(CLOUD_RETRY_ALARM, {
        when: Math.max(Date.now() + 1_000, pending.nextRetryAt),
      });
    }
  } else {
    await chrome.alarms.clear(CLOUD_POLL_ALARM);
    await clearCloudRetry();
  }
}

let autoSyncRunning = false;
let autoSyncPending = false;
async function runAutomaticSync(force = false): Promise<void> {
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
      const stored = await chrome.storage.local.get(CLOUD_RETRY_STATE_KEY);
      const retry = parseCloudRetryState(stored[CLOUD_RETRY_STATE_KEY]);
      // Respect backoff after transient failures, including after worker restart.
      if (!force && retry && retry.nextRetryAt > Date.now()) break;
      const authStatus = await cloudController.execute({ type: CLOUD_MESSAGE_TYPE, action: 'status' });
      if (!authStatus.ok || authStatus.configured !== true || !authStatus.uid) {
        await chrome.storage.local.set({ [CLOUD_AUTO_SYNC_STATUS_KEY]: {
          state: 'error', message: '邮箱验证会话已失效，请在设置页重新验证邮箱', updatedAt: Date.now(),
        } });
        break;
      }
      // An authenticated LunaTOC user syncs only their explicitly bound ChatGPT accounts.
      const owners = (await findVerifiedChatGptOwners())
        .filter((owner) => authStatus.boundOwners?.includes(owner) === true);
      const errors: string[] = [];
      let transientFailure = false;
      for (const ownerId of owners) {
        const result = await cloudController.execute({
          type: CLOUD_MESSAGE_TYPE, action: 'sync', ownerId,
        });
        if (!result.ok) {
          errors.push(result.error);
          transientFailure ||= isTransientCloudError(result.error);
          console.warn('LunaTOC automatic cloud sync skipped:', result.error);
        }
      }
      const failed = errors.length > 0;
      if (owners.length > 0) {
        await chrome.storage.local.set({
          [CLOUD_AUTO_SYNC_STATUS_KEY]: {
            state: failed ? 'error' : 'success',
            message: failed ? errors[0] : '已完成所有已验证 ChatGPT 账号的同步',
            updatedAt: Date.now(),
          },
        });
      }
      if (transientFailure) {
        await armCloudRetry(Math.min((retry?.attempt ?? 0) + 1, 100));
      } else if (!failed && owners.length > 0) {
        await clearCloudRetry();
      } else if (owners.length === 0 && retry) {
        // Stay pending while the owner has no authenticated ChatGPT tab.
        await armCloudRetry(Math.min(retry.attempt + 1, 100));
      }
      force = false;
    } while (autoSyncPending);
  } finally {
    autoSyncRunning = false;
    if (autoSyncPending) void runAutomaticSync().catch(() => {});
  }
}

let autoSyncDebounce: ReturnType<typeof setTimeout> | undefined;
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const relevant = Object.entries(changes).some(([key, change]) => {
    const accountData = key === PROMPT_STORAGE_KEY || key === ACCOUNT_SETTINGS_KEY ||
      key.startsWith(TOC_ALIAS_PREFIX) || key.startsWith(TOC_ALIAS_DELETED_PREFIX);
    return accountData && JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue);
  });
  if (!relevant) return;
  // Persist a retry alarm before the short debounce. The alarm survives worker suspension.
  void (async () => {
    const enabled = await chrome.storage.local.get(CLOUD_AUTO_SYNC_KEY);
    if (enabled[CLOUD_AUTO_SYNC_KEY] !== true) return;
    const stored = await chrome.storage.local.get(CLOUD_RETRY_STATE_KEY);
    if (!parseCloudRetryState(stored[CLOUD_RETRY_STATE_KEY])) await armCloudRetry(0);
    if (autoSyncDebounce) clearTimeout(autoSyncDebounce);
    autoSyncDebounce = setTimeout(() => {
      autoSyncDebounce = undefined;
      void runAutomaticSync(true).catch(() => {});
    }, 1000);
  })().catch(() => {});
});

// A verified ChatGPT tab makes its owner eligible for upload and download.
chrome.tabs.onActivated.addListener(() => { void runAutomaticSync().catch(() => {}); });
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' &&
      /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/.test(tab.url ?? '')) {
    void runAutomaticSync().catch(() => {});
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLOUD_RETRY_ALARM || alarm.name === CLOUD_POLL_ALARM) {
    void runAutomaticSync().catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(() => {
  void refreshCloudPolling().then(() => runAutomaticSync()).catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  void refreshCloudPolling().then(() => runAutomaticSync()).catch(() => {});
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' ||
      (message as { type?: unknown }).type !== CLOUD_MESSAGE_TYPE) return;
  // A content script is an extension sender too: only the actual options page
  // is authorized to pass one-time email codes or trigger cross-device transfers.
  const optionsUrl = chrome.runtime.getURL('src/options/options.html');
  if (sender.id !== chrome.runtime.id || sender.url !== optionsUrl) {
    sendResponse({ ok: false, error: 'Firebase 操作只允许从扩展设置页执行' });
    return false;
  }
  void cloudController.execute(message).then(async (result) => {
    if (result.ok && ['set-auto-sync', 'sign-out', 'register', 'login'].includes(String((message as { action?: unknown }).action))) {
      try {
        await refreshCloudPolling();
        if ((message as { enabled?: unknown }).enabled === true) {
          void runAutomaticSync(true).catch(() => {});
        }
      } catch {
        sendResponse({ ok: false, error: '无法设置 Chrome 同步定时任务；请重新打开扩展设置页' });
        return;
      }
    }
    sendResponse(result);
  }, () => sendResponse({ ok: false, error: 'Firebase 服务暂不可用' }));
  return true;
});
