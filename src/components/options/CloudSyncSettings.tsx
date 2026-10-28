/** Optional cloud sync: Google identity is authorized once; sync then runs automatically. */
import { useEffect, useState } from 'react';
import { CLOUD_AUTO_SYNC_STATUS_KEY, CLOUD_MESSAGE_TYPE, type CloudAutoSyncStatus, type CloudResult } from '@/features/cloud/cloudController';

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
  const [uid, setUid] = useState('');
  const [enabled, setEnabled] = useState(false);
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
    }).catch((cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : '无法读取云同步状态');
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

  async function changeEnabled(nextEnabled: boolean): Promise<void> {
    if (busy || nextEnabled === enabled) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      if (!nextEnabled) {
        const result = await command({ action: 'set-auto-sync', enabled: false });
        setEnabled(false);
        setUid('');
        setMessage(result.message);
        return;
      }
      if (!configured) throw new Error('官方云同步配置尚未完成，暂时无法开启');
      if (!accountId) throw new Error('请先登录 ChatGPT，并等待 LunaTOC 识别账号');
      // The user explicitly opted in, so request Firebase network access now.
      if (!(await chrome.permissions.request({ origins: firebaseOrigins }))) {
        throw new Error('未授权 Firebase 网络访问；云同步保持关闭，本地功能不受影响');
      }
      // Google identity is the cross-device identity. Firebase creates or finds
      // the matching provider account automatically; no LunaTOC password/account form.
      const auth = await chrome.identity.getAuthToken({ interactive: true });
      const accessToken = typeof auth === 'string' ? auth : auth?.token;
      if (!accessToken) throw new Error('没有取得 Google 授权；云同步保持关闭');
      const login = await command({ action: 'google-sign-in', accessToken });
      setUid(login.uid ?? '');
      // Validate the real Firestore connection before persisting the opt-in.
      await command({ action: 'sync', ownerId: accountId });
      const result = await command({ action: 'set-auto-sync', enabled: true });
      setEnabled(true);
      setMessage(result.message + '；当前 ChatGPT 账号已完成首次同步');
    } catch (cause) {
      // A failed first connection must not leave automatic upload enabled.
      try { await command({ action: 'sign-out' }); } catch { /* Keep the original failure. */ }
      setEnabled(false);
      setUid('');
      setError(cause instanceof Error ? cause.message : '无法开启云同步');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="cloud-sync-heading">
      <div className="settings-section-heading">
        <h2 id="cloud-sync-heading">LunaTOC 云同步（可选）</h2>
        <p>默认关闭。开启后，LunaTOC 使用你的 Google 账号进行跨设备身份识别，并自动同步已验证 ChatGPT 账号的提示词、目录别名和偏好。不需要创建 LunaTOC 同步账号。</p>
      </div>
      <div className="settings-card">
        {!configured && (
          <p className="settings-backup-description" role="status">
            官方云同步尚未完成配置。当前所有功能仍保存在本地，不会上传数据。
          </p>
        )}
        {configured && (
          <p className="settings-backup-status" role="status">官方云同步配置已就绪。</p>
        )}
        {!accountId && (
          <p className="settings-backup-description" role="status">
            请先打开已登录的 ChatGPT 页面，等待 LunaTOC 识别账号后再开启云同步。
          </p>
        )}
        <label className="settings-choice settings-no-border">
          <span className="settings-choice-info">
            <strong>自动云同步</strong>
            <small>
              {enabled
                ? '已开启：本地数据更改后会自动同步。关闭后停止上传，已存云端的数据不会自动删除。'
                : '关闭状态下完全使用本地存储。开启时会请求 Firebase 网络权限，并在需要时弹出 Google 授权窗口。'}
            </small>
          </span>
          <input
            aria-label="开启自动云同步"
            className="settings-switch-input"
            type="checkbox"
            checked={enabled}
            disabled={busy || !configured || !accountId}
            onChange={(event) => void changeEnabled(event.currentTarget.checked)}
          />
          <span className="settings-switch-track" aria-hidden="true" />
        </label>
        <p className="settings-backup-description">
          状态：{busy ? '正在连接并验证云同步…' : enabled ? '已开启' : '已关闭'}
          {uid ? '（Google 身份已关联）' : ''}
        </p>
        {message && <p className="settings-backup-status" role="status">{message}</p>}
        {lastSyncStatus && enabled && (
          lastSyncStatus.state === 'error'
            ? <p className="settings-error" role="alert">最近一次自动同步失败：{lastSyncStatus.message}</p>
            : <p className="settings-backup-status" role="status">最近一次自动同步成功：{lastSyncStatus.message}</p>
        )}
        {error && <p className="settings-error" role="alert">{error}</p>}
        <p className="settings-footnote">
          仅同步当前已验证 ChatGPT 账号的 Tips、目录别名、主题与侧边栏偏好；不上传完整对话正文或使用统计。云端数据由 LunaTOC 维护者管理，可能以明文形式读取。关闭同步不会删除本地数据或自动删除云端副本。
        </p>
      </div>
    </section>
  );
}
