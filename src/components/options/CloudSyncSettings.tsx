/** LunaTOC-managed Firebase: users only authorize, log in, and choose sync. */
import { useEffect, useState } from 'react';
import { CLOUD_MESSAGE_TYPE, type CloudResult } from '@/features/cloud/cloudController';

type Success = Extract<CloudResult, { ok: true }>;
async function command(data: Record<string, unknown>): Promise<Success> {
  const result = await chrome.runtime.sendMessage({ type: CLOUD_MESSAGE_TYPE, ...data }) as CloudResult | undefined;
  if (!result) throw new Error('Firebase 后台服务没有响应');
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
  const [uid, setUid] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void command({ action: 'status' }).then((status) => {
      if (!live) return;
      setConfigured(status.configured === true);
      setUid(status.uid ?? '');
    }).catch((cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : '无法读取同步服务状态');
    });
    return () => { live = false; };
  }, []);

  async function run(action: () => Promise<Success>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const outcome = await action();
      setMessage(outcome.message);
      if (outcome.uid) setUid(outcome.uid);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '云同步失败');
    } finally {
      setBusy(false);
    }
  }

  async function login(signup: boolean): Promise<Success> {
    // All permissions are granted only in response to the user's action.
    if (!(await chrome.permissions.request({ origins: firebaseOrigins }))) {
      throw new Error('未授权 Firebase 网络访问，本地功能不受影响');
    }
    const result = await command({ action: signup ? 'sign-up' : 'sign-in', email, password });
    setPassword('');
    return result;
  }

  return (
    <section className="settings-section" aria-labelledby="cloud-sync-heading">
      <div className="settings-section-heading">
        <h2 id="cloud-sync-heading">LunaTOC 云同步（可选）</h2>
        <p>默认关闭，由 LunaTOC 统一维护 Firebase 服务。无需创建 Firebase 项目、填写 API Key 或部署安全规则。</p>
      </div>
      <div className="settings-card">
        {!configured && (
          <p className="settings-backup-description">
            LunaTOC 云服务尚未上线。提示词、对话目录、备份与外观设置仍可离线正常使用。
            当前扩展不会将这些数据上传到任何云服务器。
          </p>
        )}
        <div className="settings-backup-block">
          <strong className="settings-setting-title">1. 登录 LunaTOC 同步账号</strong>
          <p className="settings-backup-description">
            同步账号独立于 ChatGPT 登录身份。两台设备使用同一同步账号才能共享数据。
            密码不保存在扩展中；登录令牌仅存在浏览器会话里。
          </p>
          <label>同步邮箱
            <input className="settings-account-select" type="email" autoComplete="username"
              value={email} disabled={busy || !configured}
              onChange={(e) => setEmail(e.currentTarget.value)} />
          </label>
          <label>同步密码
            <input className="settings-account-select" type="password" autoComplete="current-password"
              value={password} disabled={busy || !configured}
              onChange={(e) => setPassword(e.currentTarget.value)} />
          </label>
          <button type="button" className="settings-backup-button"
            disabled={busy || !configured || !email || !password}
            onClick={() => void run(() => login(false))}>登录</button>{' '}
          <button type="button" className="settings-backup-button"
            disabled={busy || !configured || !email || !password}
            onClick={() => void run(() => login(true))}>注册同步账号</button>{' '}
          <button type="button" className="settings-backup-button" disabled={busy || !uid}
            onClick={() => void run(async () => {
              const response = await command({ action: 'sign-out' });
              setUid('');
              setPassword('');
              return response;
            })}>退出登录</button>
          <p className="settings-backup-description">
            状态：{uid ? '已登录（用户 ' + uid.slice(0, 8) + '…）' : '未登录'}
          </p>
        </div>
        <div className="settings-divider" />
        <div className="settings-backup-block">
          <strong className="settings-setting-title">2. 同步已验证的 ChatGPT 账号</strong>
          <p className="settings-backup-description">
            请保持该 ChatGPT 账号的标签页打开。只同步该账号的 Tips、目录别名和偏好，
            不上传完整对话正文或使用统计。同步前建议导出本地备份；
            数据冲突时会报错，不会直接覆盖。
          </p>
          <p className="settings-backup-description">目标账号：{accountId || '未识别到 ChatGPT 账号'}</p>
          <button type="button" className="settings-backup-button"
            disabled={busy || !configured || !uid || !accountId}
            onClick={() => void run(() => command({ action: 'sync', ownerId: accountId }))}>
            立即同步
          </button>
        </div>
        {message && <p className="settings-backup-status" role="status">{message}</p>}
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
