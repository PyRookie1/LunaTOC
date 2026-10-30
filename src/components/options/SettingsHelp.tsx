/** Small, keyboard-accessible help tooltip for compact settings controls. */
export function SettingsHelp({ id, text }: { id: string; text: string }): React.JSX.Element {
  return (
    <span className="settings-help">
      <button type="button" className="settings-help-button"
        aria-label={`查看说明：${text}`} aria-describedby={id}>？</button>
      <span id={id} className="settings-help-tooltip" role="tooltip">{text}</span>
    </span>
  );
}
