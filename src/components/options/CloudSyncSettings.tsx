/** Opt-in Firebase Spark cloud sync controls. Firebase passwords are never persisted. */
import { useEffect, useState } from 'react';
import { CLOUD_CONFIG_KEY, CLOUD_MESSAGE_TYPE, type CloudResult } from '@/features/cloud/cloudController';

async function command(data: Record<string, unknown>): Promise<Extract<CloudResult, { ok: true }>> {
  const response = await chrome.runtime.sendMessage({ type: CLOUD_MESSAGE_TYPE, ...data }) as CloudResult | undefined;
  if (!response) throw new Error('Firebase 后台服务未响应');
  if (!response.ok) throw new Error(response.error);
  return response;
}
const permissionOrigins = [
  'https://identitytoolkit.googleapis.com/*',
  'https://securetoken.googleapis.com/*',
  'https://firestore.googleapis.com/*',
];
export function CloudSyncSettings({ accountId }: { accountId: string }): React.JSX.Element {
  const [projectId, setProjectId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [uid, setUid] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      chrome.storage.local.get(CLOUD_CONFIG_KEY),
      command({ action: 'status' }),
    ]).then(([local, status]) => {
      if (!alive) return;
      const cfg = local[CLOUD_CONFIG_KEY] as { projectId?: unknown; apiKey?: unknown } | undefined;
      if (typeof cfg?.projectId === 'string') setProjectId(cfg.projectId);
      if (typeof cfg?.apiKey === 'string') setApiKey(cfg.apiKey);
      setConfigured(status.configured === true);
      setUid(status.uid ?? '');
      setMessage(status.message);
    }).catch((cause: unknown) => {
      if (alive) setError(cause instanceof Error ? cause.message : '无法读取 Firebase 配置');
    });
    return () => { alive = false; };
  }, []);

  async function run(task: () => Promise<Extract<CloudResult, { ok: true }>>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await task();
      setMessage(response.message);
      if (response.uid) setUid(response.uid);
      if (response.configured !== undefined) setConfigured(response.configured);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Firebase 请求失败');
    } finally {
      setBusy(false);
    }
  }

  /** Browser permissions are requested only after an explicit user gesture. */
  async function grantPermission(): Promise<void> {
    const granted = await chrome.permissions.request({ origins: permissionOrigins });
    if (!granted) throw new Error('未授予 Firebase 主机访问权限；本地功能不受影响');
  }

  return (
    <section className="settings-section" aria-labelledby="cloud-sync-heading">
      <div className="settings-section-heading">
        <h2 id="cloud-sync-heading">Firebase 云同步（可选）</h2>
        <p>默认关闭。只同步当前已验证的 ChatGPT 账号下的 Tips、目录名称及偏好；不上传对话正文或使用统计。</p>
      </div>
      <div className="settings-card">
        <div className="settings-backup-block">
          <strong className="settings-setting-title">1. 配置自己的 Firebase Spark 项目</strong>
          <p className="settings-backup-description">
            先在 Firebase 控制台启用 Email/Password 登录、Firestore，并部署仓库提供的安全规则。
            Web API Key 是客户端公开配置，不要填写服务账号私钥。
          </p>
          <label>Firebase 项目 ID
            <input className="settings-account-select" autoComplete="off" value={projectId}
              onChange={(e) => setProjectId(e.currentTarget.value.trim())} disabled={busy} />
          </label>
          <label>Firebase Web API Key
            <input className="settings-account-select" autoComplete="off" value={apiKey}
              onChange={(e) => setApiKey(e.currentTarget.value.trim())} disabled={busy} />
          </label>
          <button type="button" className="settings-backup-button" disabled={busy || !projectId || !apiKey}
            onClick={() => void run(async () => {
              await grantPermission();
              const result = await command({ action: 'configure', config: { projectId, apiKey } });
              setConfigured(true);
              setUid('');
              return result;
            })}>
            保存 Firebase 配置并授权访问
          </button>
        </div>
        <div className="settings-divider" />
        <div className="settings-backup-block">
          <strong className="settings-setting-title">2. 登录 Firebase 账号</strong>
          <p className="settings-backup-description">
            Firebase 账号与 ChatGPT 账号独立。跨设备同步必须登录同一个 Firebase 账号；
            密码仅用于登录请求，登录令牌只存于浏览器会话，重启后需要重新登录。
          </p>
          <label>Firebase 登录邮箱
            <input className="settings-account-select" type="email" autoComplete="username" value={email}
              onChange={(e) => setEmail(e.currentTarget.value)} disabled={busy} />
          </label>
          <label>Firebase 密码
            <input className="settings-account-select" type="password" autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.currentTarget.value)} disabled={busy} />
          </label>
          <button type="button" className="settings-backup-button"
            disabled={busy || !configured || !email || !password}
            onClick={() => void run(async () => {
              const result = await command({ action: 'sign-in', email, password });
              setPassword('');
              return result;
            })}>登录 Firebase</button>{' '}
          <button type="button" className="settings-backup-button"
            disabled={busy || !configured || !email || !password}
            onClick={() => void run(async () => {
              const result = await command({ action: 'sign-up', email, password });
              setPassword('');
              return result;
            })}>注册 Firebase 账号</button>{' '}
          <button type="button" className="settings-backup-button"
            disabled={busy || !uid}
            onClick={() => void run(async () => {
              const result = await command({ action: 'sign-out' });
              setUid('');
              setPassword('');
              return result;
            })}>退出 Firebase</button>
          <p className="settings-backup-description">登录状态：{uid ? '已登录（UID ' + uid.slice(0, 8) + '…）' : '未登录'}</p>
        </div>
        <div className="settings-divider" />
        <div className="settings-backup-block">
          <strong className="settings-setting-title">3. 同步已验证的 ChatGPT 账号</strong>
          <p className="settings-backup-description">
            请保持对应账号的 ChatGPT 标签页打开。首次上传或下载可能包含私人提示词和账号标识；
            首次跨设备合并如有冲突会停止，不会悄悄覆盖。每次同步最多一个 Firestore 账号文档
            （240 KB），默认不持续轮询。请先导出本地备份。
          </p>
          <p className="settings-backup-description">目标：{accountId || '尚无已验证账号'}</p>
          <button type="button" className="settings-backup-button"
            disabled={busy || !configured || !uid || !accountId}
            onClick={() => void run(() => command({ action: 'sync', ownerId: accountId }))}>
            立即同步当前账号
          </button>
        </div>
        {message && <p className="settings-backup-status" role="status">{message}</p>}
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
