/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PopupApp } from '@/components/popup/PopupApp';

const mock = vi.hoisted(() => ({
  owner: vi.fn(), readSettings: vi.fn(), subscribeSettings: vi.fn(), writeSettings: vi.fn(),
}));
vi.mock('@/features/storage/accountSettings', () => ({
  resolveAccountSettingsOwner: mock.owner,
}));
vi.mock('@/features/theme/themeSettings', () => ({
  readThemeSettings: mock.readSettings,
  subscribeThemeSettings: mock.subscribeSettings,
  writeThemeSettings: mock.writeSettings,
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.documentElement.removeAttribute('data-theme');
  document.body.removeAttribute('data-theme');
  mock.owner.mockReset().mockResolvedValue('account-1');
  mock.readSettings.mockReset().mockResolvedValue({ followChatGPT: false, manualTheme: 'light' });
  mock.subscribeSettings.mockReset().mockReturnValue(() => {});
  mock.writeSettings.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
    runtime: { openOptionsPage: vi.fn() },
    tabs: { query: vi.fn().mockResolvedValue([{ id: 10 }]) },
    storage: {
      session: { get: vi.fn().mockResolvedValue({}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.documentElement.removeAttribute('data-theme');
  document.body.removeAttribute('data-theme');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Popup manual LunaTOC theme', () => {
  it('waits for account preferences, then displays the new light default', async () => {
    let complete!: (value: { followChatGPT: false; manualTheme: 'light' }) => void;
    mock.readSettings.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    await act(async () => { root.render(<PopupApp />); });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    await act(async () => { complete({ followChatGPT: false, manualTheme: 'light' }); });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.body.dataset.theme).toBe('light');
    expect(container.querySelector('[aria-label="当前主题：浅色。点击切换主题"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="跟随 ChatGPT 主题"]')).toBeNull();
  });

  it('keeps an account-specific manual dark override, independent of ChatGPT', async () => {
    document.documentElement.classList.remove('dark');
    mock.readSettings.mockResolvedValue({ followChatGPT: false, manualTheme: 'dark' });
    await act(async () => { root.render(<PopupApp />); });
    expect(document.documentElement.dataset.theme).toBe('dark');
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="当前主题：深色。点击切换主题"]');
    expect(button).not.toBeNull();
    await act(async () => { button!.click(); });
    expect(mock.writeSettings).toHaveBeenCalledWith(
      { followChatGPT: false, manualTheme: 'light' }, 'account-1');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
