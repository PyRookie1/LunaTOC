/** Local backup controls in the extension options page. */
import { useState, type ChangeEvent } from 'react';
import {
  requestLocalBackup, parseLocalBackup, requestLocalBackupRestore, summarizeLocalBackup,
  MAX_BACKUP_BYTES, type LocalBackup, type RestoreMode,
} from '@/features/backup/localBackup';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

/** Downloads and restores extension-owned data without a network service. */
export function LocalBackupSettings(): React.JSX.Element {
  const [preview, setPreview] = useState<LocalBackup | null>(null);
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState(false);

  const show = (text: string, isError = false): void => {
    setMessage(text);
    setFailure(isError);
  };

  const exportBackup = async (): Promise<void> => {
    setBusy(true);
    show('');
    try {
      const backup = await requestLocalBackup();
      const url = URL.createObjectURL(new Blob(
        [JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' }
      ));
      const link = document.createElement('a');
      link.href = url;
      link.download = `lunatoc-backup-${backup.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      show('备份文件已交给浏览器下载。请妥善保存，不要公开分享。');
    } catch (error) {
      show(`备份失败：${errorMessage(error)}`, true);
    } finally {
      setBusy(false);
    }
  };

  const selectFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    setPreview(null);
    setFileName('');
    show('');
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      show('所选文件超过 12 MiB 限制。', true);
      return;
    }
    setBusy(true);
    try {
      const backup = parseLocalBackup(await file.text());
      setPreview(backup);
      setFileName(file.name);
      show('备份格式有效，请检查下面的预览并选择恢复方式。');
    } catch (error) {
      show(`无法导入：${errorMessage(error)}`, true);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (): Promise<void> => {
    if (!preview || busy) return;
    const action = mode === 'replace' ? '覆盖本地提示词、设置和别名' : '合并提示词与别名，并采用备份中的设置';
    if (!window.confirm(`确认${action}？LunaTOC 会协调本地写入；恢复前请刷新其他已打开的 ChatGPT 标签页，避免旧页面缓存覆盖恢复结果。`)) return;
    setBusy(true);
    show('');
    try {
      await requestLocalBackupRestore(preview, mode);
      setPreview(null);
      setFileName('');
      show('恢复成功。已打开的 ChatGPT 页面可能需要刷新才能读取完整数据。');
    } catch (error) {
      show(`恢复失败：${errorMessage(error)}`, true);
    } finally {
      setBusy(false);
    }
  };

  const summary = preview ? summarizeLocalBackup(preview) : null;
  return (
    <section className="settings-section" aria-labelledby="backup-heading">
      <div className="settings-section-heading">
        <h2 id="backup-heading">本地数据备份与恢复</h2>
      </div>
      <div className="settings-card">
        <div className="settings-backup-block">
          <button type="button" className="settings-backup-button" onClick={() => void exportBackup()} disabled={busy}>
            备份数据
          </button>
        </div>
        <div className="settings-divider" />
        <div className="settings-backup-block">
          <label className="settings-backup-button settings-backup-import">
            导入备份
            <input type="file" aria-label="导入备份" accept=".json,application/json"
              onChange={(event) => void selectFile(event)} disabled={busy} />
          </label>
          {preview && summary && (
            <div className="settings-backup-preview" aria-label="恢复数据预览">
              <p><strong>文件：</strong>{fileName}</p>
              <p><strong>导出时间：</strong>{preview.exportedAt}</p>
              <p>提示词 {summary.prompts} 条，使用统计 {summary.usage} 条，目录别名 {summary.aliases} 条（{summary.conversations} 个会话）。</p>
              <p>包含 {summary.settingsAccounts} 个账号的主题与侧边栏偏好。</p>
              {Object.values(preview.data.settings)[0] && (
                <p>示例偏好：主题 {Object.values(preview.data.settings)[0].theme.followChatGPT ? '跟随 ChatGPT' : Object.values(preview.data.settings)[0].theme.manualTheme === 'dark' ? '深色' : '浅色'}；布局 {Object.values(preview.data.settings)[0].sidebar.layoutMode === 'overlay' ? '浮层' : '并排'}。</p>
              )}
              {preview.data.prompts.length > 0 && <p>提示词预览：{preview.data.prompts.slice(0, 5).map((item) => item.title).join('、')}{preview.data.prompts.length > 5 ? '……' : ''}</p>}
              <fieldset className="settings-backup-modes">
                <legend>恢复方式</legend>
                <label><input type="radio" name="restore-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} disabled={busy} /> 合并：同 ID 的备份记录优先，其他本地提示词和别名保留；设置采用备份值。</label>
                <label><input type="radio" name="restore-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} disabled={busy} /> 覆盖：以备份内容替换上述数据，并清理未列入备份的旧目录别名。</label>
              </fieldset>
              <button type="button" className="settings-backup-button" disabled={busy} onClick={() => void restore()}>
                确认恢复
              </button>
            </div>
          )}
          {message && <p className={failure ? 'settings-error' : 'settings-backup-status'} role="status">{message}</p>}
        </div>
      </div>
    </section>
  );
}
