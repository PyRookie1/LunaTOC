/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudSyncSettings } from '@/components/options/CloudSyncSettings';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  requestPermissions: vi.fn(),
  getAuthToken: vi.fn(),
}));
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.sendMessage.mockReset().mockImplementation(async (message: { action: string }) => {
    if (message.action === 'status') {
      return { ok: true, configured: true, autoSyncEnabled: false };
    }
    if (message.action === 'google-sign-in') return { ok: true, uid: 'firebase-user' };
    if (message.action === 'sync') return { ok: true, message: '同步完成' };
    if (message.action === 'set-auto-sync') return { ok: true, autoSyncEnabled: true, message: '云同步已开启' };
    if (message.action === 'sign-out') return { ok: true, message: '云同步已关闭' };
    return { ok: false, error: 'unexpected action' };
  });
  mocks.requestPermissions.mockReset().mockResolvedValue(true);
  mocks.getAuthToken.mockReset().mockResolvedValue({ token: 'google-access-token-for-test' });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: mocks.sendMessage },
    permissions: { request: mocks.requestPermissions },
    identity: { getAuthToken: mocks.getAuthToken },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => root.render(<CloudSyncSettings accountId="account-1" />));
  await act(async () => Promise.resolve());
}

describe('CloudSyncSettings opt-in flow', () => {
  it('shows only the opt-in control, with no LunaTOC email/password account creation', async () => {
    await render();
    expect(host.querySelector('input[type="checkbox"][aria-label="开启自动云同步"]')).not.toBeNull();
    expect(host.querySelector('input[type="email"]')).toBeNull();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.textContent).not.toContain('注册同步账号');
  });

  it('authorizes Google, verifies the initial sync, then enables automatic sync', async () => {
    await render();
    const toggle = host.querySelector<HTMLInputElement>('input[aria-label="开启自动云同步"]');
    if (!toggle) throw new Error('Missing cloud sync toggle');
    await act(async () => toggle.click());
    expect(mocks.requestPermissions).toHaveBeenCalledTimes(1);
    expect(mocks.getAuthToken).toHaveBeenCalledWith({ interactive: true });
    const actions = mocks.sendMessage.mock.calls.map(([message]) => message.action);
    expect(actions).toEqual(['status', 'google-sign-in', 'sync', 'set-auto-sync']);
    expect(toggle.checked).toBe(true);
    expect(host.textContent).toContain('当前 ChatGPT 账号已完成首次同步');
  });

  it('keeps cloud sync off when Google authorization is denied', async () => {
    mocks.getAuthToken.mockRejectedValueOnce(new Error('User cancelled'));
    await render();
    const toggle = host.querySelector<HTMLInputElement>('input[aria-label="开启自动云同步"]');
    if (!toggle) throw new Error('Missing cloud sync toggle');
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(false);
    expect(host.textContent).toContain('User cancelled');
    expect(mocks.sendMessage.mock.calls.map(([message]) => message.action))
      .toEqual(['status', 'sign-out']);
  });
});
