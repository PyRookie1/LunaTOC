/** Opt-in automatic sync authenticated with verified LunaTOC email/password accounts. */
import { useEffect, useState } from 'react';
import { SettingsHelp } from './SettingsHelp';
import {
  CLOUD_AUTO_SYNC_STATUS_KEY, CLOUD_MESSAGE_TYPE,
  type CloudAutoSyncStatus, type CloudResult,
} from '@/features/cloud/cloudController';

type Success = Extract<CloudResult, { ok: true }>;
async function command(data: Record<string, unknown>): Promise<Success> {
  const result = await chrome.runtime.sendMessage({ type: CLOUD_MESSAGE_TYPE, ...data }) as CloudResult | undefined;
  if (!result) throw new Error('LunaTOC 后台服务没有响应');
  if (!result.ok) throw new Error(result.error);
  return result;
}
const firebaseOrigins = [
  'https://identitytoolkit.googleapis.com/*',
  'https://securetoken.googleapis.com/*',
  'https://firestore.googleapis.com/*',
];

export function CloudSyncSettings({ accountId }: { accountId: string }): React.JSX.Element {
  const [configured, setConfigured] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [uid, setUid] = useState('');
  const [cloudEmail, setCloudEmail] = useState('');
  const [boundOwners, setBoundOwners] = useState<string[]>([]);
  const [boundUid, setBoundUid] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [registering, setRegistering] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [lastSyncStatus, setLastSyncStatus] = useState<CloudAutoSyncStatus | null>(null);

  useEffect(() => {
    let live = true;
    void command({ action: 'status', ownerId: accountId }).then((status) => {
      if (!live) return;
      setConfigured(status.configured === true);
      setUid(status.uid ?? '');
      setCloudEmail(status.email ?? '');
      setBoundUid(status.boundUid ?? '');
      setBoundOwners(status.boundOwners ?? []);
      setEnabled(status.autoSyncEnabled === true);
      setLastSyncStatus(status.autoSyncStatus ?? null);
      setEmailVerified(status.emailVerified === true);
      setRequesting(Boolean(status.uid) && status.autoSyncEnabled !== true);
      setStatusLoaded(true);
    }).catch((cause: unknown) => {
      if (live) {
        setStatusLoaded(true);
        setError(cause instanceof Error ? cause.message : '无法读取云同步状态');
      }
    });
    const onStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: chrome.storage.AreaName
    ): void => {
      if (areaName !== 'local' || !changes[CLOUD_AUTO_SYNC_STATUS_KEY]) return;
      const value = changes[CLOUD_AUTO_SYNC_STATUS_KEY].newValue as CloudAutoSyncStatus | undefined;
      if (value && (value.state === 'success' || value.state === 'error') &&
          typeof value.message === 'string' && typeof value.updatedAt === 'number') {
        setLastSyncStatus(value);
      }
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onStorageChange);
    };
  }, [accountId]);

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法完成云同步操作'); }
    finally { setBusy(false); }
  }

  async function initialSync(): Promise<void> {
    if (!accountId) throw new Error('请先打开已登录的 ChatGPT 页面');
    const binding = await command({ action: 'bind-account', ownerId: accountId });
    setBoundUid(binding.boundUid ?? uid);
    setBoundOwners((owners) => [...new Set([...owners, accountId])].sort());
    await command({ action: 'sync', ownerId: accountId });
    const result = await command({ action: 'set-auto-sync', enabled: true });
    setEnabled(true);
    setRequesting(false);
    setEmailVerified(true);
    setMessage(result.message + '；当前 ChatGPT 账号已完成首次同步');
  }

  async function changeEnabled(next: boolean): Promise<void> {
    await run(async () => {
      if (!next) {
        const result = await command({ action: 'set-auto-sync', enabled: false });
        try { await chrome.permissions.remove({ origins: firebaseOrigins }); } catch { /* Already absent. */ }
        setEnabled(false);
        setRequesting(false);
        setUid('');
        setCloudEmail('');
        setBoundOwners([]);
        setPassword('');
        setEmailVerified(false);
        setMessage(result.message);
        return;
      }
      if (!configured || !accountId) throw new Error('请先登录 ChatGPT 并确保官方云同步服务已配置');
      if (!(await chrome.permissions.request({ origins: firebaseOrigins }))) {
        throw new Error('未授权 Firebase 网络访问；云同步保持关闭，本地功能不受影响');
      }
      setRequesting(true);
      setMessage(uid && emailVerified
        ? '请确认当前 ChatGPT 账号的云端绑定后开始同步'
        : '请使用 LunaTOC 邮箱与密码登录；首次注册需先通过邮件验证地址。');
    });
  }

  return (
    <div className="settings-cloud-panel">
      <div className="settings-choice settings-no-border">
        <span className="settings-choice-info settings-inline-title">
          <label htmlFor="cloud-auto-sync-toggle"><strong>自动云同步</strong></label>
          <SettingsHelp id="cloud-sync-help"
            text="首次需使用邮箱+密码注册 LunaTOC 账号并验证邮箱。" />
        </span>
        <label className="settings-switch-control">
          <input id="cloud-auto-sync-toggle"
            aria-label="开启自动云同步" className="settings-switch-input" type="checkbox"
            checked={enabled || requesting} disabled={busy || !statusLoaded || !configured || !accountId}
            onChange={(event) => void changeEnabled(event.currentTarget.checked)}
          />
          <span className="settings-switch-track" aria-hidden="true" />
        </label>
      </div>
      <div className="settings-cloud-details">
        {!statusLoaded && <p role="status" className="settings-backup-description">正在检查官方云同步配置…</p>}
        {statusLoaded && !configured && (
          <p role="status" className="settings-backup-description">官方云同步尚未完成配置。当前所有功能仍保存在本地，不会上传数据。</p>
        )}
        {statusLoaded && configured && (
          <p role="status" className="settings-backup-status">官方云同步配置已就绪。</p>
        )}
        {!accountId && (
          <p role="status" className="settings-backup-description">请先打开已登录的 ChatGPT 页面，等待 LunaTOC 识别账号。</p>
        )}
        {statusLoaded && (
          <div className="settings-cloud-identity" aria-label="LunaTOC 云账号信息">
            <p><strong>LunaTOC 云账号：</strong>{uid ? (cloudEmail || '邮箱尚未读取') : '未登录'}</p>
          </div>
        )}
        {(requesting || enabled) && (
          <div className="settings-backup-block">
            {uid && !emailVerified ? (
              <>
                <p className="settings-backup-description">
                  LunaTOC 账号已登录，但邮箱尚未验证。请打开注册验证邮件，点击确认链接，然后回到这里检查。
                </p>
                <button type="button" className="settings-backup-button" disabled={busy}
                  onClick={() => void run(async () => {
                    const result = await command({ action: 'check-verification' });
                    setEmailVerified(result.emailVerified === true);
                    setMessage(result.emailVerified
                      ? '邮箱已验证。请确认当前 ChatGPT 账号的云端绑定后开启同步。'
                      : result.message);
                  })}>我已完成邮箱验证，检查并开启同步</button>
                <button type="button" className="settings-backup-button" disabled={busy}
                  onClick={() => void run(async () => {
                    const result = await command({ action: 'resend-verification' });
                    setMessage(result.message);
                  })}>重新发送验证邮件</button>
              </>
            ) : !uid ? (
              <>
                <p className="settings-backup-description">
                  {registering ? '注册 LunaTOC 云账号（首次需要确认邮箱）。' : '使用已有 LunaTOC 云账号登录。'}
                  密码仅发送给 Firebase Authentication 进行验证，不保存在扩展设置中。
                </p>
                <div className="settings-cloud-credentials">
                <label>LunaTOC 账号邮箱
                  <input className="settings-account-select" type="email" autoComplete="email"
                    value={email} disabled={busy}
                    onChange={(event) => setEmail(event.currentTarget.value.trim())} />
                </label>
                <label>密码（至少 12 位）
                  <input className="settings-account-select" type="password"
                    autoComplete={registering ? 'new-password' : 'current-password'}
                    value={password} disabled={busy}
                    onChange={(event) => setPassword(event.currentTarget.value)} />
                </label>
                </div>
                <button type="button" className="settings-backup-button"
                  disabled={busy || !email || password.length < 12}
                  onClick={() => void run(async () => {
                    const action = registering ? 'register' : 'login';
                    const result = await command({ action, email, password });
                    setPassword('');
                    setUid(result.uid ?? '');
                    setCloudEmail(result.email ?? email);
                    setBoundOwners(result.boundOwners ?? []);
                    setEmailVerified(result.emailVerified === true);
                    setMessage(result.emailVerified
                      ? '已登录。请确认当前 ChatGPT 账号的云端绑定后开启同步。'
                      : result.message);
                  })}>{registering ? '注册 LunaTOC 账号' : '登录 LunaTOC 账号'}</button>
                <button type="button" className="settings-backup-button" disabled={busy}
                  onClick={() => { setRegistering(!registering); setPassword(''); }}>
                  {registering ? '已有账号？返回登录' : '没有账号？注册 LunaTOC'}
                </button>
                {!registering && (
                  <button type="button" className="settings-backup-button"
                    disabled={busy || !email}
                    onClick={() => void run(async () => {
                      const result = await command({ action: 'reset-password', email });
                      setMessage(result.message);
                    })}>忘记密码？发送重置邮件</button>
                )}
              </>
            ) : null}
            {uid && emailVerified && (
              <>
                <p className="settings-backup-description">
                  {boundUid && boundUid !== uid
                    ? '当前 ChatGPT 账号绑定了另一个 LunaTOC 云账号。本次登录不会上传该账号的数据；需要先明确解除原绑定。'
                    : boundUid === uid
                      ? '当前 ChatGPT 账号已绑定至此 LunaTOC 云账号。'
                      : '当前 ChatGPT 账号尚未绑定云端。只有点击下面的绑定按钮才会上传此账号的数据；其他 ChatGPT 账号不会自动加入。'}
                </p>
                {boundUid !== uid && boundUid && (
                  <button type="button" className="settings-backup-button" disabled={busy}
                    onClick={() => void run(async () => {
                      if (!window.confirm('解除当前 ChatGPT 账号原有的 LunaTOC 云端绑定？本地和远端数据保留。解除后可选择新的云账号。')) return;
                      const result = await command({ action: 'unbind-account', ownerId: accountId });
                      setBoundUid('');
                      setBoundOwners((owners) => owners.filter((owner) => owner !== accountId));
                      setMessage(result.message);
                    })}>解除当前 ChatGPT 账号原有云端绑定</button>
                )}
                {(!boundUid || boundUid === uid) && (
                  <button type="button" className="settings-backup-button" disabled={busy}
                    onClick={() => void run(initialSync)}>
                    {boundUid === uid ? '同步当前已绑定的 ChatGPT 账号' : '绑定当前 ChatGPT 账号并同步到此云空间'}
                  </button>
                )}
              </>
            )}
            {uid && (
              <button type="button" className="settings-backup-button" disabled={busy}
                onClick={() => void run(async () => {
                  const result = await command({ action: 'sign-out' });
                  setUid(''); setCloudEmail(''); setBoundOwners([]);
                  setEmailVerified(false); setRequesting(false); setPassword('');
                  setMessage(result.message);
                })}>退出当前 LunaTOC 云账号</button>
            )}
          </div>
        )}
        <p className="settings-backup-description">
          状态：{busy ? '正在处理…' : enabled ? '自动同步已开启' : requesting ? (uid && !emailVerified ? '等待邮箱验证' : '等待 LunaTOC 登录') : '云同步已关闭'}
        </p>
        {message && <p role="status" className="settings-backup-status">{message}</p>}
        {lastSyncStatus && enabled && (
          lastSyncStatus.state === 'error'
            ? <p role="alert" className="settings-error">最近一次自动同步失败：{lastSyncStatus.message}</p>
            : <p role="status" className="settings-backup-status">最近一次自动同步成功：{lastSyncStatus.message}</p>
        )}
        {error && <p role="alert" className="settings-error">{error}</p>}
        <p className="settings-footnote">
          只同步明确绑定到当前 LunaTOC 云账号的 ChatGPT 账号的 Tips、目录别名、主题与偏好；其他账号保留在本地。
          云端内容并非端到端加密，维护者可能读取明文。
          关闭同步会清理本地登录凭据，但不删除已经上传的数据。
        </p>
      </div>
    </div>
  );
}
