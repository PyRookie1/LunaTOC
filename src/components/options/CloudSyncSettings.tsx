/** Opt-in automatic sync authenticated with verified LunaTOC email/password accounts. */
import { useEffect, useRef, useState } from 'react';
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
  const [statusAccountId, setStatusAccountId] = useState('');
  const autoStartAttempt = useRef('');
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
      setStatusAccountId(accountId);
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
    // Let the background service perform the first sync, avoiding concurrent manual and automatic requests.
    setLastSyncStatus(null);
    await command({ action: 'set-auto-sync', enabled: true });
    setEnabled(true);
    setRequesting(false);
    setEmailVerified(true);
    setMessage('自动云同步已开启，正在同步数据。');
  }

  // Login resumes background sync without requiring another click; never auto-transfer a foreign binding.
  useEffect(() => {
    if (!statusLoaded || statusAccountId !== accountId || busy || enabled || !requesting ||
        !uid || !emailVerified || !configured || !accountId || (boundUid && boundUid !== uid)) return;
    const key = accountId + ':' + uid;
    if (autoStartAttempt.current === key) return;
    autoStartAttempt.current = key;
    void run(initialSync);
  }, [accountId, statusAccountId, statusLoaded, busy, enabled, requesting,
    uid, emailVerified, configured, boundUid]);

  async function changeEnabled(next: boolean): Promise<void> {
    await run(async () => {
      if (!next) {
        const result = await command({ action: 'set-auto-sync', enabled: false });
        try { await chrome.permissions.remove({ origins: firebaseOrigins }); } catch { /* Already absent. */ }
        setEnabled(false);
        setRequesting(false);
        autoStartAttempt.current = '';
        setUid('');
        setCloudEmail('');
        setBoundOwners([]);
        setPassword('');
        setEmailVerified(false);
        setMessage(result.message);
        return;
      }
      if (!accountId) throw new Error('请先登录 ChatGPT。');
      if (!configured) throw new Error('云同步暂时用不了，请稍后再试。');
      if (!(await chrome.permissions.request({ origins: firebaseOrigins }))) {
        throw new Error('没有开启云同步权限，请允许访问后重试。');
      }
      setRequesting(true);
      setMessage('');
    });
  }

  return (
    <div className="settings-cloud-panel" aria-busy={!statusLoaded}>
      <div className="settings-choice settings-no-border">
        <span className="settings-choice-info settings-inline-title">
          <label htmlFor="cloud-auto-sync-toggle"><strong>自动云同步</strong></label>
          <SettingsHelp id="cloud-auto-sync-help"
            text="用户数据默认保存在本地，使用邮箱+密码创建、验证并登录LuanTOC账号后自动云同步。" />
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
        {statusLoaded && !configured && (
          <p role="alert" className="settings-error">云同步暂时用不了，请稍后再试。</p>
        )}
        {!accountId && (
          <p role="alert" className="settings-error">请先登录 ChatGPT。</p>
        )}
        {statusLoaded && uid && (
          <div className="settings-cloud-identity" aria-label="LunaTOC 云账号信息">
            <p><strong>LunaTOC 云账号：</strong>{cloudEmail || '邮箱暂时没读到'}</p>
          </div>
        )}
        {(requesting || enabled) && (
          <div className="settings-backup-block">
            {uid && !emailVerified ? (
              <>
                <p className="settings-error" role="alert">邮箱还没验证，请去邮箱点一下验证链接。</p>
                <button type="button" className="settings-backup-button" disabled={busy}
                  onClick={() => void run(async () => {
                    const result = await command({ action: 'check-verification' });
                    setEmailVerified(result.emailVerified === true);
                    setMessage(result.emailVerified
                      ? '邮箱已验证，正在开启自动云同步。'
                      : '邮箱还没验证，请先去邮箱点确认链接。');
                  })}>我已完成邮箱验证，检查并开启同步</button>
                <button type="button" className="settings-backup-button" disabled={busy}
                  onClick={() => void run(async () => {
                    const result = await command({ action: 'resend-verification' });
                    setMessage(result.message);
                  })}>重新发送验证邮件</button>
              </>
            ) : !uid ? (
              <>
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
                      ? '登录成功，正在开启自动云同步。'
                      : '邮箱还没验证，请去邮箱查看验证邮件。');
                  })}>{registering ? '注册 LunaTOC 账号' : '登录 LunaTOC 账号'}</button>
                {!registering && (
                  <button type="button" className="settings-backup-button"
                    disabled={busy || !email}
                    onClick={() => void run(async () => {
                      const result = await command({ action: 'reset-password', email });
                      setMessage(result.message);
                    })}>忘记密码？发送重置邮件</button>
                )}
                <button type="button" className="settings-backup-button" disabled={busy}
                  onClick={() => { setRegistering(!registering); setPassword(''); }}>
                  {registering ? '已有账号？返回登录' : '没有账号？注册 LunaTOC'}
                </button>
              </>
            ) : null}
            {uid && emailVerified && (
              <>
                {boundUid && boundUid !== uid && (
                  <p className="settings-error" role="alert">这个 ChatGPT 账号已经绑定了别的云账号，先解除绑定才能继续。</p>
                )}
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
                {!boundUid && (
                  <button type="button" className="settings-backup-button" disabled={busy}
                    onClick={() => void run(initialSync)}>
                    绑定当前 ChatGPT 账号并同步到此云空间
                  </button>
                )}
                {requesting && boundUid === uid && error && (
                  <button type="button" className="settings-backup-button" disabled={busy}
                    onClick={() => void run(initialSync)}>
                    重试开启自动云同步
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
                  autoStartAttempt.current = '';
                  setMessage(result.message);
                })}>退出当前 LunaTOC 云账号</button>
            )}
          </div>
        )}
        {message && <p role="status" className="settings-backup-status">{message}</p>}
        {lastSyncStatus?.state === 'success' && enabled && (
          <p role="status" className="settings-backup-status">自动同步成功：{lastSyncStatus.message}</p>
        )}
        {lastSyncStatus?.state === 'error' && enabled && (
          <p role="alert" className="settings-error">自动同步失败：{lastSyncStatus.message}</p>
        )}
        {error && <p role="alert" className="settings-error">{error}</p>}
      </div>
    </div>
  );
}
