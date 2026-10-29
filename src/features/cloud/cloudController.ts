/** Firebase Identity Toolkit / Firestore REST: user-initiated, quota-limited account sync. */
import { isValidAccountOwnerId, ACCOUNT_SETTINGS_KEY } from '@/features/storage/accountSettings';
import { createLocalBackup } from '@/features/backup/localBackup';
import { isPromptList, PROMPT_STORAGE_KEY } from '@/features/myPrompts/promptWriteCoordinator';
import { TOC_ALIAS_PREFIX, TOC_ALIAS_DELETED_PREFIX, parseTocAliasRecord } from '@/features/conversationPrompts/tocAliasWriteCoordinator';
import { CLOUD_MAX_BYTES, emptyCloudSnapshot, mergeAccountSnapshots, validateCloudSnapshot,
  type CloudSnapshot } from './cloudSnapshot';
import type { SerialWriteQueue } from '@/features/storage/serialWriteQueue';
import { bundledFirebaseConfig } from './managedFirebaseConfig';
import { emailActionCode } from './emailLink';

export const CLOUD_MESSAGE_TYPE = 'LUNATOC_CLOUD_V1';
const SESSION_KEY = 'lunatoc:cloud:auth:session:v1';
const PENDING_EMAIL_KEY = 'lunatoc:cloud:pending-email:v1';
export const CLOUD_AUTO_SYNC_KEY = 'lunatoc:cloud:auto-sync:v1';
export const CLOUD_AUTO_SYNC_STATUS_KEY = 'lunatoc:cloud:auto-sync-status:v1';
export interface CloudAutoSyncStatus { state: 'success' | 'error'; message: string; updatedAt: number }
const BASE_PREFIX = 'lunatoc:cloud:baseline:v1:';
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,62}$/;
const AUTH_KEY_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;
interface Config { apiKey: string; projectId: string; authDomain: string }
interface Session { idToken: string; refreshToken: string; uid: string; expiresAt: number }
interface FirestoreDocument { fields?: { json?: { stringValue?: string } }; updateTime?: string }
type LocalStorage = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;
type Fetcher = typeof fetch;
export type CloudAction =
  | { type: typeof CLOUD_MESSAGE_TYPE; action: 'send-email-link'; email: string }
  | { type: typeof CLOUD_MESSAGE_TYPE; action: 'complete-email-link'; email: string; link: string }
  | { type: typeof CLOUD_MESSAGE_TYPE; action: 'set-auto-sync'; enabled: boolean }
  | { type: typeof CLOUD_MESSAGE_TYPE; action: 'sign-out' | 'status' }
  | { type: typeof CLOUD_MESSAGE_TYPE; action: 'sync'; ownerId: string };
export type CloudResult = { ok: true; message: string; uid?: string; configured?: boolean; autoSyncEnabled?: boolean; autoSyncStatus?: CloudAutoSyncStatus; pendingEmail?: string }
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
    typeof session.expiresAt === 'number' && Number.isFinite(session.expiresAt);
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
export function createCloudController(
  local: LocalStorage,
  sessionStorage: LocalStorage,
  queue: SerialWriteQueue,
  verifyOwner: (ownerId: string) => Promise<boolean>,
  fetcher: Fetcher = fetch,
  managedConfig: Config | null = bundledFirebaseConfig()
) {
  async function config(): Promise<Config> {
    // Never accept user-provided project identifiers from local storage or
    // messages. This prevents silently syncing to an attacker-owned backend.
    if (!validConfig(managedConfig)) {
      throw new Error('LunaTOC 官方 Firebase 服务尚未配置；本地功能可继续使用');
    }
    return managedConfig;
  }
  async function session(): Promise<Session> {
    const values = await sessionStorage.get(SESSION_KEY);
    if (!validSession(values[SESSION_KEY])) throw new Error('请先通过邮箱链接验证云同步身份');
    return values[SESSION_KEY];
  }
  async function token(): Promise<Session> {
    const existing = await session();
    if (existing.expiresAt - Date.now() > 60_000) return existing;
    const cfg = await config();
    const response = await fetcher('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(cfg.apiKey), {
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
  async function sendEmailLink(rawEmail: unknown): Promise<CloudResult> {
    const email = emailAddress(rawEmail);
    const cfg = await config();
    const response = await fetcher(
      'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + encodeURIComponent(cfg.apiKey),
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'EMAIL_SIGNIN', email,
          continueUrl: 'https://' + cfg.authDomain + '/',
          canHandleCodeInApp: true,
        }) }
    );
    await jsonResponse(response);
    // The email is not included in the one-time link, preventing session injection.
    await local.set({ [PENDING_EMAIL_KEY]: email });
    return { ok: true, message: '验证邮件已发送。请在邮件中复制完整的登录链接，返回这里粘贴。不要把链接分享给其他人。', pendingEmail: email };
  }
  async function completeEmailLink(rawEmail: unknown, link: unknown): Promise<CloudResult> {
    const email = emailAddress(rawEmail);
    const cfg = await config();
    const code = emailActionCode(link, cfg.authDomain, cfg.apiKey);
    const response = await fetcher(
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=' + encodeURIComponent(cfg.apiKey),
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, oobCode: code }) }
    );
    const result = await jsonResponse(response);
    if (typeof result.idToken !== 'string' || typeof result.refreshToken !== 'string' ||
        typeof result.localId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.localId)) {
      throw new Error('Firebase 未返回有效的邮箱登录信息');
    }
    const expiry = Number(result.expiresIn);
    if (!Number.isFinite(expiry) || expiry <= 0) throw new Error('Firebase 登录有效期无效');
    const active: Session = {
      idToken: result.idToken, refreshToken: result.refreshToken,
      uid: result.localId, expiresAt: Date.now() + expiry * 1000,
    };
    // Persist the refresh session in extension-owned local storage so reopening
    // Chrome does not require another email; sign-out removes it explicitly.
    await sessionStorage.set({ [SESSION_KEY]: active });
    await local.remove(PENDING_EMAIL_KEY);
    return { ok: true, message: '邮箱验证成功；正在首次同步', uid: active.uid };
  }
  async function currentLocal(ownerId: string, base: CloudSnapshot): Promise<CloudSnapshot> {
    const backup = await createLocalBackup(local as Parameters<typeof createLocalBackup>[0]);
    const raw = await local.get(null) as Record<string, unknown>;
    const deletedRoutes = new Set<string>();
    for (const route of [...Object.keys(base.aliases), ...base.deletedRoutes]) {
      if (Object.hasOwn(raw, TOC_ALIAS_DELETED_PREFIX + route)) deletedRoutes.add(route);
    }
    const aliases = Object.fromEntries(Object.entries(backup.data.aliases)
      .filter(([route, record]) => record.ownerId === ownerId && !deletedRoutes.has(route)));
    return validateCloudSnapshot({
      version: 1, prompts: backup.data.prompts.filter((prompt) => prompt.ownerId === ownerId),
      aliases, settings: backup.data.settings[ownerId] ?? null,
      deletedRoutes: [...deletedRoutes],
    }, ownerId);
  }
  async function applySnapshot(ownerId: string, target: CloudSnapshot): Promise<void> {
    const all = await local.get(null) as Record<string, unknown>;
    const backup = await createLocalBackup(local as Parameters<typeof createLocalBackup>[0]);
    const remaining = backup.data.prompts.filter((p) => p.ownerId !== ownerId);
    const nextPrompts = [...remaining, ...target.prompts];
    if (!isPromptList(nextPrompts)) throw new Error('合并提示词 ID 存在跨账号冲突，拒绝覆盖本地数据');
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const removed = new Set<string>();
    values[PROMPT_STORAGE_KEY] = nextPrompts;
    const settings = { ...backup.data.settings };
    if (target.settings) settings[ownerId] = target.settings;
    else delete settings[ownerId];
    values[ACCOUNT_SETTINGS_KEY] = settings;
    const validIds = new Set(nextPrompts.map((p) => p.id));
    const previousUsage = all['lunatoc:promptUsage:v1'] as Record<string, unknown> | undefined;
    if (previousUsage !== undefined) {
      values['lunatoc:promptUsage:v1'] = Object.fromEntries(Object.entries(previousUsage)
        .filter(([id]) => validIds.has(id)));
    }
    for (const [route, existing] of Object.entries(backup.data.aliases)) {
      if (existing.ownerId !== ownerId) continue;
      if (!Object.hasOwn(target.aliases, route)) removed.add(TOC_ALIAS_PREFIX + route);
    }
    for (const [route, record] of Object.entries(target.aliases)) {
      const key = TOC_ALIAS_PREFIX + route;
      const existing = backup.data.aliases[route];
      if (existing && existing.ownerId !== ownerId) throw new Error('本地会话属于其他账号，拒绝云端覆盖');
      if (Object.hasOwn(all, TOC_ALIAS_DELETED_PREFIX + route)) {
        throw new Error('本地会话已删除，拒绝从云端恢复目录别名：' + route);
      }
      values[key] = record;
    }
    for (const route of target.deletedRoutes) {
      const existing = backup.data.aliases[route];
      if (existing && existing.ownerId !== ownerId) throw new Error('不能删除另一个账号的会话别名');
      values[TOC_ALIAS_DELETED_PREFIX + route] = true;
      removed.add(TOC_ALIAS_PREFIX + route);
    }
    const changedKeys = [...new Set([...Object.keys(values), ...removed])];
    try {
      await local.set(values);
      if (removed.size) await local.remove([...removed]);
      const actual = await local.get(changedKeys) as Record<string, unknown>;
      if (Object.entries(values).some(([key, value]) => JSON.stringify(actual[key]) !== JSON.stringify(value)) ||
          [...removed].some((key) => Object.hasOwn(actual, key))) {
        throw new Error('本地同步写入后核验失败');
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
  async function syncAccount(ownerId: string): Promise<CloudResult> {
    if (!isValidAccountOwnerId(ownerId) || !(await verifyOwner(ownerId))) {
      throw new Error('未找到该账号的已验证 ChatGPT 页面；请登录对应账号并保持页面打开');
    }
    const cfg = await config();
    const user = await token();
    const ownerHash = await hashOwner(ownerId);
    const baselineKey = BASE_PREFIX + cfg.projectId + ':' + user.uid + ':' + ownerHash;
    return queue.run(async () => {
      if (!(await verifyOwner(ownerId))) throw new Error('ChatGPT 账号验证已失效，同步已取消');
      const baselineValues = await local.get(baselineKey);
      const base = baselineValues[baselineKey] === undefined
        ? emptyCloudSnapshot() : validateCloudSnapshot(baselineValues[baselineKey], ownerId);
      const hasBaseline = baselineValues[baselineKey] !== undefined;
      const here = await currentLocal(ownerId, base);
      const url = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(cfg.projectId) +
        '/databases/(default)/documents/users/' + encodeURIComponent(user.uid) +
        '/accounts/' + ownerHash;
      const response = await fetcher(url, { headers: { Authorization: 'Bearer ' + user.idToken } });
      let remote = emptyCloudSnapshot();
      let updateTime: string | null = null;
      // An authenticated 404 after an acknowledged sync is NOT a deletion
      // instruction. The document may have been removed by an administrator or
      // become unavailable after a project/security-rule change. Fail closed.
      if (response.status === 404 && hasBaseline) {
        throw new Error('已同步的 Firebase 文档意外缺失；已停止同步并保留本地数据。请检查项目和 Firestore 安全规则');
      }
      if (response.status !== 404) {
        const document = await jsonResponse(response) as unknown as FirestoreDocument;
        if (typeof document.fields?.json?.stringValue !== 'string' || !document.updateTime) {
          throw new Error('Firestore 文档字段或更新时间无效');
        }
        remote = validateCloudSnapshot(JSON.parse(document.fields.json.stringValue), ownerId);
        updateTime = document.updateTime;
      }
      // New installations auto-register default preferences. Defaults are
      // not intentional edits: on first sync prefer a customized remote setting.
      const defaults = {
        theme: { followChatGPT: true, manualTheme: 'dark' },
        sidebar: { layoutMode: 'overlay', backgroundColor: 'default', revealTint: false },
      };
      const initialLocal = !hasBaseline && remote.settings && here.settings &&
        JSON.stringify(here.settings) === JSON.stringify(defaults)
        ? { ...here, settings: null } : here;
      const merged = mergeAccountSnapshots(base, initialLocal, remote, ownerId);
      if (!(await verifyOwner(ownerId))) throw new Error('ChatGPT 账号已切换，云端操作取消');
      const latestSession = await session();
      if (latestSession.uid !== user.uid) throw new Error('Firebase 登录账号已改变，同步取消');
      if (JSON.stringify(merged) !== JSON.stringify(remote)) {
        const precondition = updateTime
          ? 'currentDocument.updateTime=' + encodeURIComponent(updateTime)
          : 'currentDocument.exists=false';
        const patched = await fetcher(url + '?' + precondition, {
          method: 'PATCH', headers: { Authorization: 'Bearer ' + user.idToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { json: { stringValue: JSON.stringify(merged) } } }),
        });
        await jsonResponse(patched);
      }
      // Verify the active accounts again before updating local browser data.
      if (!(await verifyOwner(ownerId)) || (await session()).uid !== user.uid) {
        throw new Error('同步期间登录账号发生变化；本地数据未覆盖，请重新核对并再次同步');
      }
      // Remote snapshot was committed first. Local apply is account-limited and rollback guarded.
      await applySnapshot(ownerId, merged);
      await local.set({ [baselineKey]: merged });
      return { ok: true, message: '同步完成：本地与 Firebase 已一致（提示词、目录别名、账号偏好）', uid: user.uid };
    });
  }
  async function execute(request: unknown): Promise<CloudResult> {
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
          (request as { type?: unknown }).type !== CLOUD_MESSAGE_TYPE) {
        throw new Error('无效的 Firebase 操作请求');
      }
      const command = request as Record<string, unknown>;
      switch (command.action) {
        case 'configure':
          throw new Error('Firebase 项目由 LunaTOC 维护者统一管理，禁止从扩展页面更改');
        case 'send-email-link':
          return await sendEmailLink(command.email);
        case 'complete-email-link':
          return await completeEmailLink(command.email, command.link);
        case 'set-auto-sync': {
          if (typeof command.enabled !== 'boolean') throw new Error('云同步开关状态无效');
          if (command.enabled) {
            const active = await session();
            await local.set({ [CLOUD_AUTO_SYNC_KEY]: true });
            return { ok: true, message: '云同步已开启；后续本地更改会自动同步', uid: active.uid, autoSyncEnabled: true };
          }
          await local.set({ [CLOUD_AUTO_SYNC_KEY]: false });
          await sessionStorage.remove(SESSION_KEY);
          await local.remove(PENDING_EMAIL_KEY);
          return { ok: true, message: '云同步已关闭；本地数据保留，云端数据不会自动删除', autoSyncEnabled: false };
        }
        case 'sign-out':
          await local.set({ [CLOUD_AUTO_SYNC_KEY]: false });
          await sessionStorage.remove(SESSION_KEY);
          await local.remove(PENDING_EMAIL_KEY);
          return { ok: true, message: '云同步已关闭；本地和云端数据均未删除', autoSyncEnabled: false };
        case 'status': {
          const [auth, settings] = await Promise.all([
            sessionStorage.get(SESSION_KEY), local.get([CLOUD_AUTO_SYNC_KEY, CLOUD_AUTO_SYNC_STATUS_KEY, PENDING_EMAIL_KEY]),
          ]);
          const user = auth[SESSION_KEY];
          return { ok: true, message: validSession(user) ? '邮箱已验证' : '云同步未验证',
            configured: validConfig(managedConfig), autoSyncEnabled: settings[CLOUD_AUTO_SYNC_KEY] === true,
            ...(typeof settings[PENDING_EMAIL_KEY] === 'string' ? { pendingEmail: settings[PENDING_EMAIL_KEY] as string } : {}),
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
  return { execute };
}
