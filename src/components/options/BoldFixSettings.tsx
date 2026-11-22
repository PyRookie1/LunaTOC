/** Global extra-feature controls for ChatGPT's Markdown bold repair. */
import { useEffect, useRef, useState } from 'react';
import { SettingsHelp } from './SettingsHelp';
import {
  DEFAULT_BOLD_FIX_ENABLED,
  readBoldFixEnabled,
  subscribeBoldFixEnabled,
  writeBoldFixEnabled,
} from '@/features/boldFix/boldFixSettings';

const HELP_TEXT =
  '自动修复 ChatGPT 回复中的 Markdown 粗体标记异常。开启后会扫描当前对话，并在切换对话或新消息生成时继续修复；关闭后恢复修复前的页面内容。';

export function BoldFixSettings(): React.JSX.Element {
  const [enabled, setEnabled] = useState(DEFAULT_BOLD_FIX_ENABLED);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);

  useEffect(() => {
    let active = true;
    let receivedStorageChange = false;
    mounted.current = true;
    const unsubscribe = subscribeBoldFixEnabled((next) => {
      receivedStorageChange = true;
      if (active) {
        setEnabled(next);
        setSettingsLoaded(true);
      }
    });

    void readBoldFixEnabled().then((stored) => {
      if (!active) return;
      if (!receivedStorageChange) setEnabled(stored);
      setSettingsLoaded(true);
    }).catch(() => {
      if (!active) return;
      if (!receivedStorageChange) {
        setEnabled(DEFAULT_BOLD_FIX_ENABLED);
        setError('无法读取粗体异常修复设置，当前按默认开启状态显示。');
      }
      setSettingsLoaded(true);
    });

    return () => {
      active = false;
      mounted.current = false;
      unsubscribe();
    };
  }, []);

  const handleToggle = (next: boolean): void => {
    if (!settingsLoaded || saving) return;
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    setError('');

    void writeBoldFixEnabled(next).catch(async () => {
      const stored = await readBoldFixEnabled().catch(() => previous);
      if (mounted.current) {
        setEnabled(stored);
        setError('粗体异常修复设置保存失败，当前状态已恢复；请检查扩展存储权限后重试。');
      }
    }).finally(() => {
      if (mounted.current) setSaving(false);
    });
  };

  return (
    <section className="settings-section" aria-labelledby="extra-features-heading">
      <div className="settings-section-heading">
        <div className="settings-heading-row">
          <h2 id="extra-features-heading">额外功能</h2>
          <SettingsHelp id="extra-features-help" text={HELP_TEXT} />
        </div>
      </div>
      <div className="settings-card">
        <label className="settings-choice settings-no-border">
          <span className="settings-choice-info">
            <strong>粗体异常修复</strong>
          </span>
          <span className="settings-switch-control">
            <input id="bold-fix-toggle" className="settings-switch-input" type="checkbox"
              checked={enabled}
              disabled={!settingsLoaded || saving}
              onChange={(event) => handleToggle(event.currentTarget.checked)} />
            <span className="settings-switch-track" aria-hidden="true" />
          </span>
        </label>
      </div>
      {saving && <p className="settings-backup-status" role="status">正在保存粗体异常修复设置…</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </section>
  );
}
