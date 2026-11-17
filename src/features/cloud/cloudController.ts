/** Firebase Identity Toolkit / Firestore REST: user-initiated, quota-limited account sync. */
import { isValidAccountOwnerId, ACCOUNT_SETTINGS_KEY } from '@/features/storage/accountSettings';
import { createLocalBackup, storageValuesEqual } from '@/features/backup/localBackup';
import { isPromptList, PROMPT_STORAGE_KEY, PROMPT_DELETED_STORAGE_KEY, parsePromptDeletionMap } from '@/features/myPrompts/promptWriteCoordinator';
import { TOC_ALIAS_PREFIX, TOC_ALIAS_DELETED_PREFIX, TOC_ALIAS_RECORD_DELETED_PREFIX, parseTocAliasRecord, parseTocAliasDeletionFence } from '@/features/conversationPrompts/tocAliasWriteCoordinator';
import { CLOUD_MAX_BYTES, emptyCloudSnapshot, mergeAccountSnapshots, validateCloudSnapshot,
  type CloudSnapshot } from './cloudSnapshot';
import type { SerialWriteQueue } from '@/features/storage/serialWriteQueue';
import { bundledFirebaseConfig } from './managedFirebaseConfig';
import { pendingCloudSyncStatus } from './cloudSyncStatus';
import { isPermanentConversationId } from '@/navigation/lifecycle/protocol';

export const CLOUD_MESSAGE_TYPE = 'LUNATOC_CLOUD_V1';
export const FIREBASE_REQUEST_TIMEOUT_MS = 20_000;
export const CLOUD_MAX_DAILY_WRITES_PER_USER = 100;
export const CLOUD_MAX_ACCOUNTS_PER_USER = 20;
export const CLOUD_WRITE_MIN_INTERVAL_MS = 5_000;
export const CLOUD_WRITE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SESSION_KEY = 'lunatoc:cloud:auth:session:v1';
export const CLOUD_AUTO_SYNC_KEY = 'lunatoc:cloud:auto-sync:v1';
export const CLOUD_AUTO_SYNC_STATUS_KEY = 'lunatoc:cloud:auto-sync-status:v1';
export const CLOUD_ACCOUNT_BINDINGS_KEY = 'lunatoc:cloud:account-bindings:v1';
export interface CloudAutoSyncStatus { state: 'pending' | 'success' | 'error'; message: string; updatedAt: number }
const BASE_PREFIX = 'lunatoc:cloud:baseline:';
const BASELINE_RESET_KEY = 'lunatoc:cloud:baseline-reset';
const MAX_CLOUD_WRITE_ATTEMPTS = 3;
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,62}$/;
const AUTH_KEY_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;
interface Config { apiKey: string; projectId: string; authDomain: string }
interface Session { idToken: string; refreshToken: string; uid: string; expiresAt: number; emailVerified: boolean; email?: string }
interface FirestoreDocument { fields?: { json?: { stringValue?: string } }; updateTime?: string }
interface FirestoreQuotaDocument {
  fields?: {
    accountHashes?: { arrayValue?: { values?: Array<{ stringValue?: string }> } };
    lastAccountHash?: { stringValue?: string };
    dailyWrites?: { integerValue?: string };
    windowStart?: { timestampValue?: string };
    lastWriteAt?: { timestampValue?: string };
  };
  updateTime?: string;
}
interface CloudWriteQuota {
  accountHashes: string[];
  lastAccountHash: string;
  dailyWrites: number;
  windowStart: string;
  lastWriteAt: string;
  updateTime: string;
}
type LocalStorage = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;
type Fetcher = typeof fetch;
export type CloudAction =
  | { type: typeof CLOUD_MESSAGE_TYPE; action: 'register' | 'login'; email: string; password: string }
  | { type: typeof CLOUD_MESSAGE_TYPE; action: 'resend-verification' | 'check-verification' }
  | { type: typeof CLOUD_MESSAGE_TYPE; action: 'reset-password'; email: string }
  | { type: typeof CLOUD_MESSAGE_TYPE; action: 'set-auto-sync'; enabled: boolean }
  | { type: typeof CLOUD_MESSAGE_TYPE; action: 'sign-out' | 'status'; ownerId?: string }
  | { type: typeof CLOUD_MESSAGE_TYPE; action: 'bind-account' | 'unbind-account' | 'sync'; ownerId: string };
export type CloudResult = { ok: true; message: string; uid?: string; configured?: boolean; autoSyncEnabled?: boolean; autoSyncStatus?: CloudAutoSyncStatus; emailVerified?: boolean; email?: string; boundUid?: string; boundOwners?: string[] }
  | { ok: false; error: string };

function validConfig(value: unknown): value is Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return typeof config.projectId === 'string' && PROJECT_PATTERN.test(config.projectId) &&
    typeof config.apiKey === 'string' && AUTH_KEY_PATTERN.test(config.apiKey) &&
    typeof config.authDomain === 'string' &&
    /^[a-z0-9-]+\.(?:firebaseapp\.com|web\.app)$/.test(config.authDomain);
}
function validSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return typeof session.idToken === 'string' && !!session.idToken &&
    typeof session.refreshToken === 'string' && !!session.refreshToken &&
    typeof session.uid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(session.uid) &&
    typeof session.expiresAt === 'number' && Number.isFinite(session.expiresAt) &&
    typeof session.emailVerified === 'boolean';
}
async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json().catch(() => ({}));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Firebase 返回无效响应');
  }
  const json = data as Record<string, unknown>;
  if (!response.ok) {
    const nested = json.error as { message?: unknown } | undefined;
    const message = typeof nested?.message === 'string' ? nested.message : 'HTTP ' + response.status;
    throw new Error('Firebase 请求失败：' + message.slice(0, 160));
  }
  return json;
}
async function hashOwner(ownerId: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ownerId));
  return 'acct_' + Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseCloudWriteQuota(value: unknown): CloudWriteQuota {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Firebase 写入配额记录无效，已停止同步');
  }
  const document = value as FirestoreQuotaDocument;
  const fields = document.fields;
  if (!fields || Object.keys(fields).some((key) =>
    !['accountHashes', 'lastAccountHash', 'dailyWrites', 'windowStart', 'lastWriteAt'].includes(key))) {
    throw new Error('Firebase 写入配额记录无效，已停止同步');
  }
  const dailyWrites = Number(fields.dailyWrites?.integerValue);
  const hashes = fields?.accountHashes?.arrayValue?.values;
  const accountHashes: string[] = Array.isArray(hashes)
    ? hashes.map((entry) => typeof entry?.stringValue === 'string' ? entry.stringValue : '') : [];
  const lastAccountHash = fields?.lastAccountHash?.stringValue;
  const windowStart = fields?.windowStart?.timestampValue;
  const lastWriteAt = fields?.lastWriteAt?.timestampValue;
  if (!document.updateTime ||
      !Number.isSafeInteger(dailyWrites) || dailyWrites < 1 ||
      dailyWrites > CLOUD_MAX_DAILY_WRITES_PER_USER ||
      !Array.isArray(hashes) || accountHashes.length < 1 ||
      accountHashes.length > CLOUD_MAX_ACCOUNTS_PER_USER ||
      accountHashes.some((hash) => typeof hash !== 'string' || !/^acct_[a-f0-9]{64}$/.test(hash)) ||
      new Set(accountHashes).size !== accountHashes.length ||
      typeof lastAccountHash !== 'string' || !/^acct_[a-f0-9]{64}$/.test(lastAccountHash) ||
      !accountHashes.includes(lastAccountHash) ||
      typeof windowStart !== 'string' || !Number.isFinite(Date.parse(windowStart)) ||
      typeof lastWriteAt !== 'string' || !Number.isFinite(Date.parse(lastWriteAt))) {
    throw new Error('Firebase 写入配额记录无效，已停止同步');
  }
  return { accountHashes, lastAccountHash, dailyWrites, windowStart, lastWriteAt,
    updateTime: document.updateTime };
}
export function createCloudController(
  local: LocalStorage,
  sessionStorage: LocalStorage,
  queue: SerialWriteQueue,
  verifyOwner: (ownerId: string) => Promise<boolean>,
  fetcher: Fetcher = fetch,
  managedConfig: Config | null = bundledFirebaseConfig()
) {
  // Older builds accidentally stored the Firebase ID and refresh tokens in
  // chrome.storage.local. Do not migrate those tokens into the new session:
  // remove them and require a fresh login after a browser restart.
  let initialization: Promise<void> | undefined;
  function initialize(): Promise<void> {
    initialization ??= (async () => {
      const legacy = await local.get(SESSION_KEY);
      if (Object.hasOwn(legacy, SESSION_KEY)) {
        await local.remove(SESSION_KEY);
      }
      // The Firestore store is initialized once from canonical local data after reset.
      // Clear only sync acknowledgements; prompts, aliases, settings and deletion records remain intact.
      const resetState = await local.get(BASELINE_RESET_KEY);
      if (resetState[BASELINE_RESET_KEY] !== true) {
        const localValues = await local.get(null) as Record<string, unknown>;
        const staleBaselines = Object.keys(localValues).filter((key) => key.startsWith(BASE_PREFIX));
        if (staleBaselines.length) await local.remove(staleBaselines);
        await local.set({ [BASELINE_RESET_KEY]: true });
      }
      const [preferences, savedSession] = await Promise.all([
        local.get(CLOUD_AUTO_SYNC_KEY), sessionStorage.get(SESSION_KEY),
      ]);
      if (preferences[CLOUD_AUTO_SYNC_KEY] === true && !validSession(savedSession[SESSION_KEY])) {
        await local.set({
          [CLOUD_AUTO_SYNC_KEY]: false,
          [CLOUD_AUTO_SYNC_STATUS_KEY]: {
            state: 'error',
            message: '浏览器关闭后已清除云账号登录状态，请重新登录并开启自动同步。',
            updatedAt: Date.now(),
          } satisfies CloudAutoSyncStatus,
        });
      }
    })();
    return initialization;
  }
  async function config(): Promise<Config> {
    // Never accept user-provided project identifiers from local storage or
    // messages. This prevents silently syncing to an attacker-owned backend.
    if (!validConfig(managedConfig)) {
      throw new Error('LunaTOC 官方 Firebase 服务尚未配置；本地功能可继续使用');
    }
    return managedConfig;
  }
  async function firebaseFetch(url: string, options: RequestInit): Promise<Response> {
    // Firebase calls run in the MV3 background worker, not the ChatGPT page.
    // Distinguish revoked optional host permissions from DNS/proxy/firewall failures.
    // A stalled request must not hold the MV3 cloud write queue indefinitely.
    // Abort the actual fetch and independently settle the caller even when a
    // test adapter or unusual proxy ignores AbortSignal.
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('Firebase 网络请求超时（20 秒），本轮操作已停止；请检查网络后重试'));
          controller.abort();
        }, FIREBASE_REQUEST_TIMEOUT_MS);
      });
      // The deadline also covers a server that sends response headers but
      // never finishes its JSON body. All LunaTOC Firebase endpoints return
      // bounded JSON rather than streaming responses.
      const completedResponse = (async (): Promise<Response> => {
        const response = await fetcher(url, { ...options, signal: controller.signal });
        await response.clone().arrayBuffer();
        return response;
      })();
      return await Promise.race([completedResponse, deadline]);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (!(cause instanceof TypeError) && !/failed to fetch|fetch failed|network/i.test(detail)) {
        throw cause;
      }
      const host = new URL(url).hostname;
      if (typeof chrome !== 'undefined' && chrome.permissions?.contains) {
        try {
          const allowed = await chrome.permissions.contains({ origins: ['https://' + host + '/*'] });
          if (!allowed) {
            throw new Error('Firebase 网络权限不足：扩展未获准访问 ' + host +
              '。请关闭再开启「自动云同步」，重新授权 Firebase 网络访问后重试。');
          }
        } catch (permissionError) {
          if (permissionError instanceof Error && permissionError.message.startsWith('Firebase 网络权限不足')) {
            throw permissionError;
          }
          // If permissions cannot be inspected, retain the original network diagnosis.
        }
      }
      throw new Error('无法连接 Firebase（' + host +
        '）：网络请求失败。请检查 Chrome 网络/代理、DNS、防火墙及拦截扩展，并确认 Firebase API 可访问；云同步未开启。');
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }
  /** Local cloud bindings are explicit, account-scoped and excluded from cloud snapshots. */
  async function accountBindings(): Promise<Record<string, string>> {
    const raw = (await local.get(CLOUD_ACCOUNT_BINDINGS_KEY))[CLOUD_ACCOUNT_BINDINGS_KEY];
    if (raw === undefined) return Object.create(null) as Record<string, string>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('LunaTOC 云账号绑定记录无效，已停止同步');
    }
    const bindings = Object.create(null) as Record<string, string>;
    for (const [ownerId, uid] of Object.entries(raw as Record<string, unknown>)) {
      if (!isValidAccountOwnerId(ownerId) || typeof uid !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(uid)) {
        throw new Error('LunaTOC 云账号绑定记录无效，已停止同步');
      }
      bindings[ownerId] = uid;
    }
    return bindings;
  }
  async function changeBinding(ownerId: string, action: 'bind-account' | 'unbind-account'): Promise<CloudResult> {
    if (!isValidAccountOwnerId(ownerId) || !(await verifyOwner(ownerId))) {
      throw new Error('当前 ChatGPT 账号未经验证，不能修改云账号绑定');
    }
    const currentUser = action === 'bind-account' ? await token() : null;
    if (currentUser && !currentUser.emailVerified) throw new Error('请先验证 LunaTOC 注册邮箱');
    return queue.run(async () => {
      if (!(await verifyOwner(ownerId))) throw new Error('ChatGPT 账号已切换，绑定操作取消');
      const bindings = await accountBindings();
      if (action === 'unbind-account') {
        if (!Object.hasOwn(bindings, ownerId)) return { ok: true, message: '当前 ChatGPT 账号没有云端绑定' };
        delete bindings[ownerId];
        await local.set({ [CLOUD_ACCOUNT_BINDINGS_KEY]: bindings });
        return { ok: true, message: '已解除该 ChatGPT 账号的云端绑定，本地和云端数据均保留' };
      }
      const active = await session();
      if (!currentUser || active.uid !== currentUser.uid) throw new Error('LunaTOC 登录账号已切换，绑定操作取消');
      if (bindings[ownerId] && bindings[ownerId] !== active.uid) {
        throw new Error('该 ChatGPT 账号已经绑定另一个 LunaTOC 云账号。请先明确解除原绑定，避免数据意外上传');
      }
      if (bindings[ownerId] === active.uid) return { ok: true, boundUid: active.uid, message: '当前账号已绑定' };
      bindings[ownerId] = active.uid;
      await local.set({ [CLOUD_ACCOUNT_BINDINGS_KEY]: bindings });
      return { ok: true, boundUid: active.uid, message: '已将当前 ChatGPT 账号绑定到此 LunaTOC 云账号' };
    });
  }
  async function session(): Promise<Session> {
    const values = await sessionStorage.get(SESSION_KEY);
    if (!validSession(values[SESSION_KEY])) throw new Error('请先登录 LunaTOC 云账号');
    return values[SESSION_KEY];
  }
  async function token(forceRefresh = false): Promise<Session> {
    const existing = await session();
    if (!forceRefresh && existing.expiresAt - Date.now() > 60_000) return existing;
    const cfg = await config();
    const response = await firebaseFetch('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(cfg.apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: existing.refreshToken }),
    });
    const payload = await jsonResponse(response);
    if (typeof payload.id_token !== 'string' || typeof payload.refresh_token !== 'string' ||
        payload.user_id !== existing.uid || !Number.isFinite(Number(payload.expires_in))) {
      throw new Error('Firebase 登录令牌更新失败');
    }
    const renewed: Session = {
      idToken: payload.id_token, refreshToken: payload.refresh_token,
      uid: existing.uid, expiresAt: Date.now() + Number(payload.expires_in) * 1000,
      emailVerified: existing.emailVerified, email: existing.email,
    };
    await sessionStorage.set({ [SESSION_KEY]: renewed });
    return renewed;
  }
  function emailAddress(value: unknown): string {
    if (typeof value !== 'string' || value.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new Error('请输入有效的邮箱地址');
    }
    return value.trim();
  }
  function passwordValue(value: unknown): string {
    if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
      throw new Error('LunaTOC 密码须为 12 至 128 个字符');
    }
    return value;
  }
  async function lookupIdentity(user: Session): Promise<{ verified: boolean; email?: string }> {
    const cfg = await config();
    const response = await firebaseFetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(cfg.apiKey),
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: user.idToken }) }
    );
    const payload = await jsonResponse(response);
    const info = (payload.users as Array<Record<string, unknown>> | undefined)?.[0];
    if (!info || info.localId !== user.uid || typeof info.emailVerified !== 'boolean') {
      throw new Error('Firebase 用户身份验证失败');
    }
    return {
      verified: info.emailVerified,
      ...(typeof info.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(info.email)
        ? { email: info.email } : {}),
    };
  }
  async function sendVerification(user: Session): Promise<void> {
    const cfg = await config();
    const response = await firebaseFetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + encodeURIComponent(cfg.apiKey),
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken: user.idToken }) }
    );
    await jsonResponse(response);
  }
  async function requestPasswordReset(rawEmail: unknown): Promise<CloudResult> {
    const email = emailAddress(rawEmail);
    const cfg = await config();
    const response = await firebaseFetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + encodeURIComponent(cfg.apiKey),
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }) }
    );
    await jsonResponse(response);
    // Do not disclose if this address is registered.
    return { ok: true, message: '如该邮箱已注册，密码重置邮件将发送到该地址，请检查收件箱' };
  }
  async function passwordAuth(mode: 'register' | 'login', rawEmail: unknown, rawPassword: unknown): Promise<CloudResult> {
    const email = emailAddress(rawEmail);
    const password = passwordValue(rawPassword);
    const cfg = await config();
    const endpoint = mode === 'register' ? 'signUp' : 'signInWithPassword';
    const response = await firebaseFetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:' + endpoint + '?key=' + encodeURIComponent(cfg.apiKey),
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }) }
    );
    const payload = await jsonResponse(response);
    if (typeof payload.idToken !== 'string' || typeof payload.refreshToken !== 'string' ||
        typeof payload.localId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.localId)) {
      throw new Error('Firebase 未返回有效的账号登录信息');
    }
    const expiresIn = Number(payload.expiresIn);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Firebase 登录有效期无效');
    const active: Session = {
      idToken: payload.idToken, refreshToken: payload.refreshToken,
      uid: payload.localId, expiresAt: Date.now() + expiresIn * 1000,
      emailVerified: false, email,
    };
    if (mode === 'login') {
      const info = await lookupIdentity(active);
      active.emailVerified = info.verified;
      if (info.email) active.email = info.email;
    }
    // Reauthentication as the same Firebase UID must not interrupt an enabled sync.
    // Registration or switching Firebase UID must not inherit a different account's sync.
    const previousAuth = await sessionStorage.get(SESSION_KEY);
    if (mode === 'register' || !validSession(previousAuth[SESSION_KEY]) ||
        previousAuth[SESSION_KEY].uid !== active.uid) {
      await local.set({ [CLOUD_AUTO_SYNC_KEY]: false });
    }
    // Only the Firebase ID/refresh tokens are persisted. Never save the password.
    await sessionStorage.set({ [SESSION_KEY]: active });
    if (mode === 'register') {
      await sendVerification(active);
      return { ok: true, uid: active.uid, email: active.email, emailVerified: false,
        message: 'LunaTOC 账号已创建。请打开 Firebase 验证邮件完成邮箱确认，再返回这里检查验证状态。' };
    }
    return { ok: true, uid: active.uid, email: active.email, emailVerified: active.emailVerified,
      boundOwners: Object.entries(await accountBindings()).filter(([, uid]) =>
        uid === active.uid).map(([owner]) => owner).sort(),
      message: active.emailVerified ? 'LunaTOC 账号密码登录成功' : '登录成功，但邮箱未验证。请先验证邮箱。' };
  }
  async function checkVerification(): Promise<CloudResult> {
    const active = await token(true);
    const info = await lookupIdentity(active);
    await sessionStorage.set({ [SESSION_KEY]: { ...active, emailVerified: info.verified,
      email: info.email ?? active.email } });
    return { ok: true, uid: active.uid, email: info.email ?? active.email, emailVerified: info.verified,
      message: info.verified ? '邮箱已验证，可以开启云同步' : '邮箱尚未验证，请先打开验证邮件完成确认' };
  }
  async function currentLocal(ownerId: string, base: CloudSnapshot): Promise<CloudSnapshot> {
    const backup = await createLocalBackup(local as Parameters<typeof createLocalBackup>[0]);
    const raw = await local.get(null) as Record<string, unknown>;
    const prompts = backup.data.prompts.filter((prompt) => prompt.ownerId === ownerId);
    const promptIds = new Set(prompts.map((prompt) => prompt.id));
    const deletionMap = parsePromptDeletionMap(raw[PROMPT_DELETED_STORAGE_KEY]);
    const deletedPrompts = new Set(deletionMap[ownerId] ?? []);
    const otherPromptIds = new Set(backup.data.prompts
      .filter((prompt) => prompt.ownerId !== ownerId).map((prompt) => prompt.id));
    if (prompts.some((prompt) => Object.entries(deletionMap).some(([deletedOwner, ids]) =>
      deletedOwner !== ownerId && ids.includes(prompt.id))) ||
      [...deletedPrompts].some((id) => otherPromptIds.has(id))) {
      throw new Error('提示词删除标记与另一个 ChatGPT 账号的数据冲突，已停止同步以保护数据');
    }
    // Backfill durable fences for deletions made by older builds, where the
    // acknowledged baseline is the only reliable evidence of the removed IDs.
    for (const id of [...base.prompts.map((prompt) => prompt.id), ...base.deletedPrompts]) {
      if (!promptIds.has(id)) deletedPrompts.add(id);
    }
    if (prompts.some((prompt) => deletedPrompts.has(prompt.id))) {
      throw new Error('本地提示词同时存在于数据列表和删除标记中，已停止同步以保护数据');
    }

    const baseRoutes = new Set([...Object.keys(base.aliases), ...base.deletedAliases, ...base.deletedRoutes]);
    const deletedRoutes = new Set<string>(base.deletedRoutes);
    const deletedAliases = new Set<string>(base.deletedAliases);
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith(TOC_ALIAS_DELETED_PREFIX)) {
        const route = key.slice(TOC_ALIAS_DELETED_PREFIX.length);
        if (!isPermanentConversationId(route)) {
          throw new Error('本地会话删除标记无效，已停止同步以保护数据');
        }
        if (value === true) {
          // Legacy global fences can be attributed only when this account's
          // acknowledged snapshot already contains the route.
          if (baseRoutes.has(route)) deletedRoutes.add(route);
          else if (Object.hasOwn(backup.data.aliases, route)) {
            throw new Error('旧版全局会话删除标记与本地账号数据冲突，无法安全确认归属');
          }
          continue;
        }
        const fence = parseTocAliasDeletionFence(value);
        if (fence?.ownerId === ownerId) deletedRoutes.add(route);
        else if (fence && (baseRoutes.has(route) || Object.hasOwn(backup.data.aliases, route))) {
          throw new Error('本地会话删除标记属于另一个 ChatGPT 账号，已停止同步以保护数据');
        }
      } else if (key.startsWith(TOC_ALIAS_RECORD_DELETED_PREFIX)) {
        const route = key.slice(TOC_ALIAS_RECORD_DELETED_PREFIX.length);
        if (!isPermanentConversationId(route)) {
          throw new Error('本地目录别名删除标记无效，已停止同步以保护数据');
        }
        const fence = parseTocAliasDeletionFence(value);
        if (fence?.ownerId === ownerId) deletedAliases.add(route);
        else if (fence && (Object.hasOwn(base.aliases, route) || base.deletedAliases.includes(route) ||
          base.deletedRoutes.includes(route) || Object.hasOwn(backup.data.aliases, route))) {
          throw new Error('本地目录别名删除标记属于另一个 ChatGPT 账号，已停止同步以保护数据');
        }
      }
    }
    for (const route of new Set([...deletedRoutes, ...deletedAliases])) {
      const localAlias = backup.data.aliases[route];
      if (localAlias && localAlias.ownerId !== ownerId) {
        throw new Error('本地会话删除标记与另一个 ChatGPT 账号的别名冲突，已停止同步以保护数据');
      }
    }
    for (const [route, record] of Object.entries(backup.data.aliases)) {
      if ((base.aliases[route] || base.deletedAliases.includes(route) || base.deletedRoutes.includes(route)) && record.ownerId !== ownerId) {
        throw new Error('本地会话别名已属于另一个 ChatGPT 账号，已停止同步以保护数据');
      }
    }
    // Backfill last-label removals from old builds. A missing local record
    // against an acknowledged alias is a record deletion unless the whole
    // conversation already carries the stronger conversation-level fence.
    for (const route of Object.keys(base.aliases)) {
      if (deletedRoutes.has(route)) continue;
      const localAlias = backup.data.aliases[route];
      if (!localAlias) deletedAliases.add(route);
      else if (!Object.hasOwn(raw, TOC_ALIAS_RECORD_DELETED_PREFIX + route)) {
        deletedAliases.delete(route);
      }
    }
    // An explicit local re-add after a previously synced record deletion clears
    // that record tombstone, while preserving unrelated owner fences.
    for (const route of base.deletedAliases) {
      if (deletedRoutes.has(route)) continue;
      const localAlias = backup.data.aliases[route];
      if (localAlias?.ownerId === ownerId &&
          !Object.hasOwn(raw, TOC_ALIAS_RECORD_DELETED_PREFIX + route)) {
        deletedAliases.delete(route);
      }
    }
    for (const route of deletedRoutes) deletedAliases.delete(route);
    const aliases = Object.fromEntries(Object.entries(backup.data.aliases)
      .filter(([route, record]) => record.ownerId === ownerId &&
        !deletedRoutes.has(route) && !deletedAliases.has(route)));
    return validateCloudSnapshot({
      prompts, aliases, settings: backup.data.settings[ownerId] ?? null,
      deletedRoutes: [...deletedRoutes], deletedAliases: [...deletedAliases],
      deletedPrompts: [...deletedPrompts],
    }, ownerId);
  }
  async function applySnapshot(
    ownerId: string, target: CloudSnapshot, base: CloudSnapshot
  ): Promise<void> {
    const all = await local.get(null) as Record<string, unknown>;
    const backup = await createLocalBackup(local as Parameters<typeof createLocalBackup>[0]);
    const remaining = backup.data.prompts.filter((p) => p.ownerId !== ownerId);
    const otherPromptIds = new Set(remaining.map((prompt) => prompt.id));
    if (target.deletedPrompts.some((id) => otherPromptIds.has(id))) {
      throw new Error('云端删除标记与另一个 ChatGPT 账号的提示词 ID 冲突，拒绝覆盖本地数据');
    }
    const nextPrompts = [...remaining, ...target.prompts];
    if (!isPromptList(nextPrompts)) throw new Error('合并提示词 ID 存在跨账号冲突，拒绝覆盖本地数据');

    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const removed = new Set<string>();
    values[PROMPT_STORAGE_KEY] = nextPrompts;
    const settings = { ...backup.data.settings };
    if (target.settings) settings[ownerId] = target.settings;
    else delete settings[ownerId];
    values[ACCOUNT_SETTINGS_KEY] = settings;

    const deletionMap = parsePromptDeletionMap(all[PROMPT_DELETED_STORAGE_KEY]);
    if (Object.entries(deletionMap).some(([fenceOwner, ids]) =>
      fenceOwner !== ownerId && target.deletedPrompts.some((id) => ids.includes(id)))) {
      throw new Error('云端提示词删除标记与另一个 ChatGPT 账号的删除标记冲突，拒绝覆盖');
    }
    const nextDeletionMap = Object.assign(Object.create(null), deletionMap) as Record<string, string[]>;
    if (target.deletedPrompts.length) nextDeletionMap[ownerId] = [...target.deletedPrompts];
    else delete nextDeletionMap[ownerId];
    if (!storageValuesEqual(deletionMap, nextDeletionMap)) {
      values[PROMPT_DELETED_STORAGE_KEY] = nextDeletionMap;
    }

    const validIds = new Set(nextPrompts.map((p) => p.id));
    const previousUsage = all['lunatoc:promptUsage:v1'] as Record<string, unknown> | undefined;
    if (previousUsage !== undefined) {
      values['lunatoc:promptUsage:v1'] = Object.fromEntries(Object.entries(previousUsage)
        .filter(([id]) => validIds.has(id)));
    }

    const baseRoutes = new Set([...Object.keys(base.aliases), ...base.deletedAliases, ...base.deletedRoutes]);
    for (const [route, existing] of Object.entries(backup.data.aliases)) {
      if (existing.ownerId !== ownerId) continue;
      if (!Object.hasOwn(target.aliases, route)) removed.add(TOC_ALIAS_PREFIX + route);
    }
    for (const [route, record] of Object.entries(target.aliases)) {
      const key = TOC_ALIAS_PREFIX + route;
      const existing = backup.data.aliases[route];
      if (existing && existing.ownerId !== ownerId) throw new Error('本地会话属于其他账号，拒绝云端覆盖');
      const deletionKey = TOC_ALIAS_DELETED_PREFIX + route;
      const rawFence = all[deletionKey];
      if (rawFence === true) {
        if (!baseRoutes.has(route)) {
          throw new Error('发现无法确认账号归属的旧版会话删除标记，拒绝从云端恢复');
        }
        removed.add(deletionKey);
      } else if (rawFence !== undefined) {
        const fence = parseTocAliasDeletionFence(rawFence);
        if (fence?.ownerId !== ownerId) {
          throw new Error('本地会话删除标记属于另一个 ChatGPT 账号，拒绝云端覆盖');
        }
        removed.add(deletionKey);
      }
      const recordDeletionKey = TOC_ALIAS_RECORD_DELETED_PREFIX + route;
      const rawRecordFence = all[recordDeletionKey];
      if (rawRecordFence !== undefined) {
        const recordFence = parseTocAliasDeletionFence(rawRecordFence);
        if (recordFence?.ownerId !== ownerId) {
          throw new Error('本地目录别名删除标记属于另一个 ChatGPT 账号，拒绝云端覆盖');
        }
        removed.add(recordDeletionKey);
      }
      values[key] = record;
    }
    for (const route of target.deletedAliases) {
      const existing = backup.data.aliases[route];
      if (existing && existing.ownerId !== ownerId) throw new Error('不能删除另一个账号的目录别名');
      const deletionKey = TOC_ALIAS_DELETED_PREFIX + route;
      const rawFence = all[deletionKey];
      if (rawFence === true) {
        if (!baseRoutes.has(route)) throw new Error('发现无法确认账号归属的旧版会话删除标记，拒绝同步');
        removed.add(deletionKey);
      } else if (rawFence !== undefined) {
        const fence = parseTocAliasDeletionFence(rawFence);
        if (fence?.ownerId !== ownerId) throw new Error('会话删除标记属于另一个账号，拒绝同步');
        removed.add(deletionKey);
      }
      const recordDeletionKey = TOC_ALIAS_RECORD_DELETED_PREFIX + route;
      const rawRecordFence = all[recordDeletionKey];
      const previousRecordFence = parseTocAliasDeletionFence(rawRecordFence);
      if (previousRecordFence && previousRecordFence.ownerId !== ownerId) {
        throw new Error('本地目录别名删除标记属于另一个账号，拒绝覆盖');
      }
      values[recordDeletionKey] = {
        ownerId, deletedAt: previousRecordFence?.deletedAt ?? Date.now(),
      };
      removed.add(TOC_ALIAS_PREFIX + route);
    }
    for (const route of target.deletedRoutes) {
      const existing = backup.data.aliases[route];
      if (existing && existing.ownerId !== ownerId) throw new Error('不能删除另一个账号的会话别名');
      const deletionKey = TOC_ALIAS_DELETED_PREFIX + route;
      const rawFence = all[deletionKey];
      if (rawFence === true && !baseRoutes.has(route)) {
        throw new Error('发现无法确认账号归属的旧版会话删除标记，拒绝覆盖');
      }
      const previousFence = rawFence === true ? null : parseTocAliasDeletionFence(rawFence);
      if (previousFence && previousFence.ownerId !== ownerId) {
        throw new Error('本地会话删除标记属于另一个 ChatGPT 账号，拒绝覆盖');
      }
      values[deletionKey] = {
        ownerId, deletedAt: previousFence?.deletedAt ?? Date.now(),
      };
      const recordDeletionKey = TOC_ALIAS_RECORD_DELETED_PREFIX + route;
      const rawRecordFence = all[recordDeletionKey];
      const previousRecordFence = parseTocAliasDeletionFence(rawRecordFence);
      if (previousRecordFence && previousRecordFence.ownerId !== ownerId) {
        throw new Error('本地目录别名删除标记属于另一个 ChatGPT 账号，拒绝覆盖');
      }
      removed.add(TOC_ALIAS_PREFIX + route);
      removed.add(recordDeletionKey);
    }

    const changedKeys = [...new Set([...Object.keys(values), ...removed])];
    try {
      await local.set(values);
      if (removed.size) await local.remove([...removed]);
      const actual = await local.get(changedKeys) as Record<string, unknown>;
      const mismatchedWrites = Object.entries(values)
        .filter(([key, expected]) => !storageValuesEqual(expected, actual[key]));
      const failedRemovals = [...removed].filter((key) => Object.hasOwn(actual, key));
      if (mismatchedWrites.length || failedRemovals.length) {
        throw new Error('本地同步写入后核验失败（写入不一致 ' + mismatchedWrites.length +
          ' 项，删除未完成 ' + failedRemovals.length + ' 项）');
      }
    } catch (cause) {
      const previous = Object.fromEntries(changedKeys
        .filter((key) => Object.hasOwn(all, key)).map((key) => [key, all[key]]));
      const absent = changedKeys.filter((key) => !Object.hasOwn(all, key));
      try {
        if (Object.keys(previous).length) await local.set(previous);
        if (absent.length) await local.remove(absent);
      } catch {
        throw new Error('本地同步失败且回滚失败，请保留本地备份并停止写入');
      }
      throw cause;
    }
  }
  async function isFirestorePreconditionFailure(response: Response): Promise<boolean> {
    if (response.status === 409 || response.status === 412) return true;
    if (response.status !== 400) return false;
    const body = await response.clone().json().catch(() => null) as
      { error?: { status?: unknown; message?: unknown } } | null;
    return body?.error?.status === 'FAILED_PRECONDITION' ||
      (typeof body?.error?.message === 'string' && body.error.message.includes('FAILED_PRECONDITION'));
  }

  async function syncAccount(ownerId: string): Promise<CloudResult> {
    if (!isValidAccountOwnerId(ownerId) || !(await verifyOwner(ownerId))) {
      throw new Error('未找到该账号的已验证 ChatGPT 页面；请登录对应账号并保持页面打开');
    }
    const cfg = await config();
    const user = await token();
    if (!user.emailVerified) throw new Error('请先验证 LunaTOC 注册邮箱，未验证账号禁止访问云数据');
    if ((await accountBindings())[ownerId] !== user.uid) {
      throw new Error('该 ChatGPT 账号未绑定当前 LunaTOC 云账号，禁止上传或下载');
    }
    const ownerHash = await hashOwner(ownerId);
    const baselineKey = BASE_PREFIX + cfg.projectId + ':' + user.uid + ':' + ownerHash;
    const documentsRoot = 'projects/' + encodeURIComponent(cfg.projectId) +
      '/databases/(default)/documents';
    const accountName = documentsRoot + '/users/' + encodeURIComponent(user.uid) +
      '/accounts/' + ownerHash;
    const quotaName = documentsRoot + '/users/' + encodeURIComponent(user.uid) +
      '/usage/cloudWrites';
    const accountUrl = 'https://firestore.googleapis.com/v1/' + accountName;
    const quotaUrl = 'https://firestore.googleapis.com/v1/' + quotaName;
    const commitUrl = 'https://firestore.googleapis.com/v1/' + documentsRoot + ':commit';
    const authHeaders = { Authorization: 'Bearer ' + user.idToken };

    return queue.run(async () => {
      if (!(await verifyOwner(ownerId))) throw new Error('ChatGPT 账号验证已失效，同步已取消');
      if ((await accountBindings())[ownerId] !== user.uid) throw new Error('云账号绑定已变化，同步已取消');
      const baselineValues = await local.get(baselineKey);
      const base = baselineValues[baselineKey] === undefined
        ? emptyCloudSnapshot() : validateCloudSnapshot(baselineValues[baselineKey], ownerId);
      const hasBaseline = baselineValues[baselineKey] !== undefined;

      for (let attempt = 0; attempt < MAX_CLOUD_WRITE_ATTEMPTS; attempt += 1) {
        const here = await currentLocal(ownerId, base);
        const response = await firebaseFetch(accountUrl, { headers: authHeaders });
        let remote = emptyCloudSnapshot();
        let accountUpdateTime: string | null = null;
        if (response.status === 404 && hasBaseline) {
          throw new Error('已同步的 Firebase 文档意外缺失；已停止同步并保留本地数据。请检查项目和 Firestore 安全规则');
        }
        if (response.status !== 404) {
          const document = await jsonResponse(response) as unknown as FirestoreDocument;
          if (typeof document.fields?.json?.stringValue !== 'string' || !document.updateTime) {
            throw new Error('Firestore 文档字段或更新时间无效');
          }
          remote = validateCloudSnapshot(JSON.parse(document.fields.json.stringValue), ownerId);
          accountUpdateTime = document.updateTime;
        }
        const defaults = {
          theme: { followChatGPT: false, manualTheme: 'light' },
          sidebar: { layoutMode: 'overlay', backgroundColor: 'default', revealTint: false },
        };
        const initialLocal = !hasBaseline && remote.settings && here.settings &&
          JSON.stringify(here.settings) === JSON.stringify(defaults)
          ? { ...here, settings: null } : here;
        const localBackup = await createLocalBackup(local as Parameters<typeof createLocalBackup>[0]);
        const otherPromptIds = new Set(localBackup.data.prompts
          .filter((prompt) => prompt.ownerId !== ownerId).map((prompt) => prompt.id));
        const localFenceState = await local.get(PROMPT_DELETED_STORAGE_KEY);
        const localPromptFences = parsePromptDeletionMap(localFenceState[PROMPT_DELETED_STORAGE_KEY]);
        if (remote.deletedPrompts.some((id) => otherPromptIds.has(id)) ||
            Object.entries(localPromptFences).some(([fenceOwner, ids]) =>
              fenceOwner !== ownerId && remote.deletedPrompts.some((id) => ids.includes(id)))) {
          throw new Error('云端提示词删除标记与另一个 ChatGPT 账号的数据冲突，已停止同步');
        }
        for (const route of [...Object.keys(remote.aliases), ...remote.deletedAliases, ...remote.deletedRoutes]) {
          const localAlias = localBackup.data.aliases[route];
          if (localAlias && localAlias.ownerId !== ownerId) {
            throw new Error('云端会话删除或别名与另一个 ChatGPT 账号的数据冲突，已停止同步');
          }
        }
        const merged = mergeAccountSnapshots(base, initialLocal, remote, ownerId);
        if (Object.entries(localPromptFences).some(([fenceOwner, ids]) =>
          fenceOwner !== ownerId && merged.deletedPrompts.some((id) => ids.includes(id)))) {
          throw new Error('合并后的提示词删除标记与另一个 ChatGPT 账号冲突，已停止同步');
        }
        if (!(await verifyOwner(ownerId))) throw new Error('ChatGPT 账号已切换，云端操作取消');
        const latestSession = await session();
        if (latestSession.uid !== user.uid) throw new Error('Firebase 登录账号已改变，同步取消');

        if (JSON.stringify(merged) !== JSON.stringify(remote)) {
          // The account snapshot and its per-UID quota are committed atomically.
          // Firestore rules require both writes, validate the server timestamp,
          // increment the fixed 24-hour counter and enforce the global cooldown.
          const quotaResponse = await firebaseFetch(quotaUrl, { headers: authHeaders });
          let quota: CloudWriteQuota | null = null;
          if (quotaResponse.status !== 404) {
            quota = parseCloudWriteQuota(await jsonResponse(quotaResponse));
          }
          const accountHashes = quota ? [...quota.accountHashes] : [];
          if (!accountHashes.includes(ownerHash)) {
            if (accountHashes.length >= CLOUD_MAX_ACCOUNTS_PER_USER) {
              throw new Error('当前 LunaTOC 云账号已达到 20 个 ChatGPT 账号的数据上限；现有数据不会被删除');
            }
            accountHashes.push(ownerHash);
            accountHashes.sort();
          }
          const now = Date.now();
          const windowExpired = !quota ||
            now >= Date.parse(quota.windowStart) + CLOUD_WRITE_WINDOW_MS;
          const dailyWrites = windowExpired ? 1 : quota!.dailyWrites + 1;
          const quotaFields: Record<string, unknown> = {
            accountHashes: { arrayValue: { values: accountHashes.map((hash) => ({ stringValue: hash })) } },
            lastAccountHash: { stringValue: ownerHash },
            dailyWrites: { integerValue: String(dailyWrites) },
          };
          const updateTransforms: Array<Record<string, string>> = [
            { fieldPath: 'lastWriteAt', setToServerValue: 'REQUEST_TIME' },
          ];
          if (windowExpired) {
            updateTransforms.push({ fieldPath: 'windowStart', setToServerValue: 'REQUEST_TIME' });
          } else {
            quotaFields.windowStart = { timestampValue: quota!.windowStart };
          }
          const accountWrite: Record<string, unknown> = {
            update: {
              name: accountName,
              fields: {
                json: { stringValue: JSON.stringify(merged) },
              },
            },
            updateMask: { fieldPaths: ['json'] },
            currentDocument: accountUpdateTime
              ? { updateTime: accountUpdateTime } : { exists: false },
          };
          const quotaWrite: Record<string, unknown> = {
            update: { name: quotaName, fields: quotaFields },
            updateTransforms,
            currentDocument: quota ? { updateTime: quota.updateTime } : { exists: false },
          };
          const committed = await firebaseFetch(commitUrl, {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ writes: [accountWrite, quotaWrite] }),
          });
          if (await isFirestorePreconditionFailure(committed)) {
            if (attempt < MAX_CLOUD_WRITE_ATTEMPTS - 1) continue;
            throw new Error('云端数据或写入配额在同步期间被其他设备更新，已保留本地数据；请重试同步');
          }
          if (committed.status === 403) {
            const detail = await committed.clone().json().catch(() => null) as
              { error?: { status?: unknown; message?: unknown } } | null;
            if (detail?.error?.status === 'PERMISSION_DENIED') {
              if (quota && Date.now() < Date.parse(quota.lastWriteAt) + CLOUD_WRITE_MIN_INTERVAL_MS) {
                throw new Error('云同步写入过于频繁：同一 LunaTOC 云账号两次写入至少间隔 5 秒，请稍后重试');
              }
              if (quota && quota.dailyWrites >= CLOUD_MAX_DAILY_WRITES_PER_USER &&
                  Date.now() < Date.parse(quota.windowStart) + CLOUD_WRITE_WINDOW_MS) {
                throw new Error('云同步已达到当前 24 小时配额窗口的 100 次写入上限，请在配额窗口重置后重试');
              }
              throw new Error('Firestore 服务端配额或安全规则拒绝了本次写入；本地数据已保留，请稍后重试或检查系统时间');
            }
          }
          await jsonResponse(committed);
        }

        if (!(await verifyOwner(ownerId)) || (await session()).uid !== user.uid) {
          throw new Error('同步期间登录账号发生变化；本地数据未覆盖，请重新核对并再次同步');
        }
        await applySnapshot(ownerId, merged, base);
        await local.set({ [baselineKey]: merged });
        return {
          ok: true,
          message: '同步完成：本地与 Firebase 已一致（提示词、目录别名、账号偏好）',
          uid: user.uid,
        };
      }
      throw new Error('云端数据或写入配额在同步期间被其他设备更新，已保留本地数据；请重试同步');
    });
  }
  async function execute(request: unknown): Promise<CloudResult> {
    try {
      await initialize();
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
          (request as { type?: unknown }).type !== CLOUD_MESSAGE_TYPE) {
        throw new Error('无效的 Firebase 操作请求');
      }
      const command = request as Record<string, unknown>;
      switch (command.action) {
        case 'configure':
          throw new Error('Firebase 项目由 LunaTOC 维护者统一管理，禁止从扩展页面更改');
        case 'register':
        case 'login':
          return await passwordAuth(command.action, command.email, command.password);
        case 'reset-password':
          return await requestPasswordReset(command.email);
        case 'resend-verification': {
          const active = await session();
          if (active.emailVerified) throw new Error('邮箱已验证，无需重复发送');
          await sendVerification(active);
          return { ok: true, message: '验证邮件已重新发送，请检查收件箱和垃圾邮件' };
        }
        case 'check-verification':
          return await checkVerification();
        case 'set-auto-sync': {
          if (typeof command.enabled !== 'boolean') throw new Error('云同步开关状态无效');
          if (command.enabled) {
            const active = await session();
            if (!active.emailVerified) throw new Error('请先验证 LunaTOC 注册邮箱');
            if (!Object.values(await accountBindings()).includes(active.uid)) {
              throw new Error('请先将当前 ChatGPT 账号明确绑定到 LunaTOC 云账号');
            }
            await local.set({
              [CLOUD_AUTO_SYNC_KEY]: true,
              [CLOUD_AUTO_SYNC_STATUS_KEY]: pendingCloudSyncStatus('自动云同步已开启，等待首次同步'),
            });
            return { ok: true, message: '云同步已开启；后续本地更改会自动同步', uid: active.uid, autoSyncEnabled: true };
          }
          await local.set({ [CLOUD_AUTO_SYNC_KEY]: false });
          await sessionStorage.remove(SESSION_KEY);
          return { ok: true, message: '云同步已关闭；本地数据保留，云端数据不会自动删除', autoSyncEnabled: false };
        }
        case 'sign-out':
          await local.set({ [CLOUD_AUTO_SYNC_KEY]: false });
          await sessionStorage.remove(SESSION_KEY);
          return { ok: true, message: '云同步已关闭；本地和云端数据均未删除', autoSyncEnabled: false };
        case 'bind-account':
        case 'unbind-account':
          return await changeBinding(command.ownerId as string, command.action);
        case 'status': {
          const bindings = await accountBindings();
          const [auth, settings] = await Promise.all([
            sessionStorage.get(SESSION_KEY), local.get([CLOUD_AUTO_SYNC_KEY, CLOUD_AUTO_SYNC_STATUS_KEY]),
          ]);
          const storedUser = auth[SESSION_KEY];
          let user = validSession(storedUser) ? storedUser : null;
          // Previously saved sessions did not persist the email. Resolve the
          // identity once from Firebase; offline status can still show the UID.
          if (user && !user.email && validConfig(managedConfig)) {
            try {
              const identity = await lookupIdentity(await token());
              if (identity.email) {
                const latest = await session();
                if (latest.uid === user.uid) {
                  user = { ...latest, email: identity.email };
                  await sessionStorage.set({ [SESSION_KEY]: user });
                }
              }
            } catch { /* Status stays available offline without the email. */ }
          }
          return { ok: true, message: validSession(user) ? 'LunaTOC 云账号已登录' : 'LunaTOC 云账号未登录',
            configured: validConfig(managedConfig), autoSyncEnabled: settings[CLOUD_AUTO_SYNC_KEY] === true,
            ...(isValidAccountOwnerId(command.ownerId) && bindings[command.ownerId]
              ? { boundUid: bindings[command.ownerId] } : {}),
            boundOwners: validSession(user)
              ? Object.keys(bindings).filter((owner) => bindings[owner] === user.uid).sort() : [],
            ...(validSession(user) ? { emailVerified: user.emailVerified,
              ...(user.email ? { email: user.email } : {}) } : {}),
            ...(settings[CLOUD_AUTO_SYNC_STATUS_KEY] && typeof settings[CLOUD_AUTO_SYNC_STATUS_KEY] === 'object'
              ? { autoSyncStatus: settings[CLOUD_AUTO_SYNC_STATUS_KEY] as CloudAutoSyncStatus } : {}),
            ...(validSession(user) ? { uid: user.uid } : {}) };
        }
        case 'sync':
          return await syncAccount(command.ownerId as string);
        default: throw new Error('不支持的 Firebase 操作');
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Firebase 操作失败' };
    }
  }
  return { execute, initialize };
}
