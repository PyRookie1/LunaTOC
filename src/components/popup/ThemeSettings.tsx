/** Renders manual light/dark theme control for the popup. */
import { Moon, Sun } from 'lucide-react';
import type {
  ResolvedTheme,
  ThemeSettings as ThemeSettingsValue,
} from '@/features/theme/themeSettings';

interface ThemeSettingsProps {
  settings: ThemeSettingsValue;
  resolvedTheme: ResolvedTheme;
  onChange: (settings: ThemeSettingsValue) => void;
  disabled?: boolean;
}

/** Displays the current theme as a user-controlled toggle. */
export function ThemeSettings({
  settings,
  resolvedTheme,
  onChange,
  disabled = false,
}: ThemeSettingsProps): React.JSX.Element {
  const toggleManualTheme = (): void => {
    onChange({
      ...settings,
      manualTheme: settings.manualTheme === 'dark' ? 'light' : 'dark',
    });
  };

  return (
    <section
      className="mb-2.5 border-b border-(--p-toggle-border) pb-2"
      aria-labelledby="theme-heading"
    >
      <div className="flex min-h-6 items-center gap-2">
        <h2
          id="theme-heading"
          className="m-0 mr-auto text-[10px] font-semibold uppercase tracking-[0.08em] text-(--p-toggle-text)"
        >
          主题
        </h2>
        <button
          type="button"
          disabled={disabled}
          aria-label={`当前主题：${resolvedTheme === 'dark' ? '深色' : '浅色'}。点击切换主题`}
          title={`当前主题：${resolvedTheme === 'dark' ? '深色' : '浅色'}。点击切换`}
          className={`inline-flex size-6 cursor-pointer appearance-none items-center justify-center border-0 bg-transparent p-0 outline-none transition duration-150 hover:scale-110 hover:brightness-125 active:scale-95 focus-visible:ring-2 focus-visible:ring-(--p-accent) focus-visible:ring-offset-2 focus-visible:ring-offset-(--p-bg-main) ${resolvedTheme === 'dark' ? 'text-blue-400' : 'text-amber-600'}`}
          onClick={toggleManualTheme}
        >
          {resolvedTheme === 'dark' ? (
            <Moon
              aria-hidden="true"
              viewBox="2 2 20 20"
              className="size-5 drop-shadow-[0_0_4px_currentColor]"
            />
          ) : (
            <Sun
              aria-hidden="true"
              viewBox="2 2 20 20"
              className="size-5 drop-shadow-[0_0_4px_currentColor]"
            />
          )}
        </button>
      </div>
    </section>
  );
}
