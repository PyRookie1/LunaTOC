import { useState } from 'react';
import { OPEN_CAPTURE_CHECK } from '@/navigation/refresh/refreshProtocol';

/** Opens the content-side checker without copying conversation data. */
export function ConversationCheckSettings(): React.JSX.Element {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const open = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
      const tab = tabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) ||
        (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).find(item => item.id !== undefined);
      if (!tab?.id) { setStatus('请先打开已登录的 ChatGPT 页面。'); return; }
      const response = await chrome.tabs.sendMessage(tab.id, { type: OPEN_CAPTURE_CHECK });
      if (response?.ok !== true) throw new Error('unavailable');
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      setStatus('已打开页面中的检查面板，请按面板提示操作。');
    } catch { setStatus('检查面板未能打开，请刷新 ChatGPT 页面后重试。'); }
    finally { setBusy(false); }
  };
  return <section className="settings-section" aria-labelledby="conversation-check-heading">
    <div className="settings-section-heading"><h2 id="conversation-check-heading">对话功能检查</h2></div>
    <div className="settings-card">
      <p className="settings-backup-status">按需检查消息读取与时间边界。结果只保存在当前检查面板，不启用持续记录，不上传正文或图片。</p>
      <button className="settings-backup-button" type="button" disabled={busy} onClick={() => void open()}>运行功能检查</button>
      {status && <p className="settings-backup-status" role="status">{status}</p>}
    </div>
  </section>;
}
