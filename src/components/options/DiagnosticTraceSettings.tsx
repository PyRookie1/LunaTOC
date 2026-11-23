/** Temporary navigation diagnostics controls. Runs only on the extension options page. */
import { useEffect, useState } from 'react';
import {
  TRACE_ENABLED_KEY, TRACE_CLEAR_KEY, TRACE_FLUSH_KEY, TRACE_SESSION_PREFIX,
  TRACE_SCHEMA_VERSION, type TraceSession,
} from '@/features/navigationTrace/traceProtocol';

function isSession(value: unknown): value is TraceSession {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<TraceSession>;
  return record.schemaVersion === TRACE_SCHEMA_VERSION &&
    Array.isArray(record.events) && typeof record.sessionId === 'string';
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
export function DiagnosticTraceSettings(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    let alive = true;
    let changed = false;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && TRACE_ENABLED_KEY in changes) {
        changed = true;
        if (alive) setEnabled(changes[TRACE_ENABLED_KEY].newValue === true);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    void chrome.storage.local.get(TRACE_ENABLED_KEY).then(value => {
      if (alive) { if (!changed) setEnabled(value[TRACE_ENABLED_KEY] === true); setLoaded(true); }
    }).catch(error => {
      if (alive) { setStatus('读取诊断设置失败：' + errorText(error)); setLoaded(true); }
    });
    return () => { alive = false; chrome.storage.onChanged.removeListener(listener); };
  }, []);
  async function toggle(value: boolean): Promise<void> {
    setBusy(true); setStatus('');
    try { await chrome.storage.local.set({ [TRACE_ENABLED_KEY]: value }); setEnabled(value); }
    catch (error) { setStatus('无法保存开关：' + errorText(error)); }
    finally { setBusy(false); }
  }
  async function exportTrace(): Promise<void> {
    setBusy(true); setStatus('');
    try {
      await chrome.storage.local.set({ [TRACE_FLUSH_KEY]: crypto.randomUUID() });
      await new Promise(resolve => window.setTimeout(resolve, 700));
      const all = await chrome.storage.local.get(null);
      const sessions = Object.entries(all)
        .filter(([key, value]) => key.startsWith(TRACE_SESSION_PREFIX) && isSession(value))
        .map(([, value]) => value as TraceSession)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (!sessions.length) { setStatus('尚无诊断日志。开启后在 ChatGPT 页面执行跳转，再回来导出。'); return; }
      const payload = {
        schemaVersion: TRACE_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        sessions,
      };
      const url = URL.createObjectURL(new Blob(
        [JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }
      ));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'lunatoc-navigation-trace-' +
        new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(link);
      link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('已提交 ' + sessions.length + ' 组日志给浏览器下载；导出内容不含对话正文。');
    } catch (error) { setStatus('导出失败：' + errorText(error)); }
    finally { setBusy(false); }
  }
  async function clearTrace(): Promise<void> {
    setBusy(true); setStatus('');
    try {
      await chrome.storage.local.set({ [TRACE_CLEAR_KEY]: crypto.randomUUID() });
      await new Promise(resolve => window.setTimeout(resolve, 600));
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter(key => key.startsWith(TRACE_SESSION_PREFIX));
      if (keys.length) await chrome.storage.local.remove(keys);
      setStatus('已清空 ' + keys.length + ' 组诊断日志。');
    } catch (error) { setStatus('清空失败：' + errorText(error)); }
    finally { setBusy(false); }
  }
  return (
    <section className="settings-section" aria-labelledby="navigation-trace-heading">
      <div className="settings-section-heading">
        <h2 id="navigation-trace-heading">临时导航诊断（测试版）</h2>
      </div>
      <div className="settings-card">
        <label className="settings-choice settings-no-border">
          <span className="settings-choice-info">
            <strong>记录 ChatGPT 导航与回答挂载日志</strong>
            <small>默认关闭。开启后刷新 ChatGPT 页面，再复现目录跳转。仅记录滚动数值、挂载和布局事件；不记录问题、回答正文或账号信息。</small>
          </span>
          <span className="settings-switch-control">
            <input id="navigation-trace-toggle" type="checkbox"
              className="settings-switch-input" checked={enabled}
              disabled={!loaded || busy}
              onChange={event => void toggle(event.currentTarget.checked)} />
            <span className="settings-switch-track" aria-hidden="true" />
          </span>
        </label>
        <div className="settings-divider" />
        <div className="settings-backup-block">
          <p className="settings-backup-description">
            每次跳转记录约 16 秒，最多 2500 条事件/会话，仅保留最近 8 组且不超过 48 小时。测试结束后关闭开关并清空日志。
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="settings-backup-button"
              disabled={!loaded || busy} onClick={() => void exportTrace()}>导出诊断 JSON</button>
            <button type="button" className="settings-backup-button"
              disabled={!loaded || busy} onClick={() => void clearTrace()}>清空诊断日志</button>
          </div>
          {status && <p className="settings-backup-status" role="status">{status}</p>}
        </div>
      </div>
    </section>
  );
}
