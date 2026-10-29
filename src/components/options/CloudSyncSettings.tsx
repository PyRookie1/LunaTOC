/** Opt-in automatic sync authenticated with verified LunaTOC email/password accounts. */
import { useEffect, useState } from 'react';
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
    void command({ action: 'status' }).then((status) => {
      if (!live) return;
      setConfigured(status.configured === true);
      setUid(status.uid ?? '');
      setEnabled(status.autoSyncEnabled === true);
      setLastSyncStatus(status.autoSyncStatus ?? null);
      setEmailVerified(status.emailVerified === true);
      if (status.uid && status.emailVerified !== true && status.autoSyncEnabled !== true) {
        setRequesting(true);
      }
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
  }, []);

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
        setPassword('');
        setEmailVerified(false);
        setMessage(result.message);
        return;
      }
      if (!configured || !accountId) throw new Error('请先登录 ChatGPT 并确保官方云同步服务已配置');
      if (!(await chrome.permissions.request({ origins: firebaseOrigins }))) {
        throw new Error('未授权 Firebase 网络访问；云同步保持关闭，本地功能不受影响');
      }
      if (uid && emailVerified) {
        await initialSync();
        return;
      }
      setRequesting(true);
      setMessage('请使用 LunaTOC 邮箱与密码登录；首次注册需先通过邮件验证地址。');
    });
  }

  return (
    <section className="settings-section" aria-labelledby="cloud-sync-heading">
      <div className="settings-section-heading">
        <h2 id="cloud-sync-heading">LunaTOC 云同步（可选）</h2>
        <p>默认关闭。首次需注册 LunaTOC 邮箱＋密码账号并验证邮箱，之后凭密码登录并同步已验证 ChatGPT 账号的数据。</p>
      </div>
      <div className="settings-card">
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
        <label className="settings-choice settings-no-border">
          <span className="settings-choice-info">
            <strong>自动云同步</strong>
            <small>开启前需完成 LunaTOC 邮箱＋密码登录和邮箱验证；关闭后停止上传，不删除本地或已有云端副本。</small>
          </span>
          <input
            aria-label="开启自动云同步" className="settings-switch-input" type="checkbox"
            checked={enabled || requesting} disabled={busy || !statusLoaded || !configured || !accountId}
            onChange={(event) => void changeEnabled(event.currentTarget.checked)}
          />
          <span className="settings-switch-track" aria-hidden="true" />
        </label>
        {requesting && !enabled && (
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
                    if (result.emailVerified) await initialSync();
                    else setMessage(result.message);
                  })}>我已完成邮箱验证，检查并开启同步</button>
                <button type="button" className="settings-backup-button" disabled={busy}
                  onClick={() => void run(async () => {
                    const result = await command({ action: 'resend-verification' });
                    setMessage(result.message);
                  })}>重新发送验证邮件</button>
              </>
            ) : (
              <>
                <p className="settings-backup-description">
                  {registering ? '注册 LunaTOC 云账号（首次需要确认邮箱）。' : '使用已有 LunaTOC 云账号登录。'}
                  密码仅发送给 Firebase Authentication 进行验证，不保存在扩展设置中。
                </p>
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
                <button type="button" className="settings-backup-button"
                  disabled={busy || !email || password.length < 12}
                  onClick={() => void run(async () => {
                    const action = registering ? 'register' : 'login';
                    const result = await command({ action, email, password });
                    setPassword('');
                    setUid(result.uid ?? '');
                    setEmailVerified(result.emailVerified === true);
                    if (result.emailVerified) await initialSync();
                    else setMessage(result.message);
                  })}>{registering ? '注册 LunaTOC 账号' : '登录并开启云同步'}</button>
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
            )}
            {uid && emailVerified && (
              <button type="button" className="settings-backup-button" disabled={busy}
                onClick={() => void run(initialSync)}>重试首次云同步</button>
            )}
            {uid && (
              <button type="button" className="settings-backup-button" disabled={busy}
                onClick={() => void run(async () => {
                  const result = await command({ action: 'sign-out' });
                  setUid(''); setEmailVerified(false); setRequesting(false); setPassword('');
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
          仅上传 Tips、目录别名、主题与偏好，不上传完整聊天正文。云端内容并非端到端加密，维护者可能读取明文。
          关闭同步会清理本地登录凭据，但不删除已经上传的数据。
        </p>
      </div>
    </section>
  );
}
