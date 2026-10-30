/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PopupApp } from '@/components/popup/PopupApp';

const mock = vi.hoisted(() => ({
  owner: vi.fn(), readSettings: vi.fn(), readChatTheme: vi.fn(),
  subscribeSettings: vi.fn(), subscribeChatTheme: vi.fn(),
  writeSettings: vi.fn(),
}));
vi.mock('@/features/storage/accountSettings', () => ({
  resolveAccountSettingsOwner: mock.owner,
}));
vi.mock('@/features/theme/chatGptTheme', () => ({
  readResolvedChatGPTTheme: mock.readChatTheme,
  subscribeResolvedChatGPTTheme: mock.subscribeChatTheme,
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
  mock.readSettings.mockReset().mockResolvedValue({ followChatGPT: true, manualTheme: 'dark' });
  mock.readChatTheme.mockReset().mockResolvedValue('light');
  mock.subscribeSettings.mockReset().mockReturnValue(() => {});
  mock.subscribeChatTheme.mockReset().mockReturnValue(() => {});
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

describe('Popup follows the resolved ChatGPT theme on first paint', () => {
  it('does not expose a dark theme marker while waiting for an async light theme', async () => {
    let complete!: (value: 'light' | 'dark') => void;
    mock.readChatTheme.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    await act(async () => { root.render(<PopupApp />); });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    await act(async () => { complete('light'); });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.body.dataset.theme).toBe('light');
    expect(container.querySelector('[aria-label="当前主题：浅色"]')).not.toBeNull();
  });

  it('uses the account manual override instead of an unrelated ChatGPT theme', async () => {
    mock.readSettings.mockResolvedValue({ followChatGPT: false, manualTheme: 'dark' });
    await act(async () => { root.render(<PopupApp />); });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(container.querySelector('[aria-label="当前主题：深色。点击切换主题"]')).not.toBeNull();
  });
});
