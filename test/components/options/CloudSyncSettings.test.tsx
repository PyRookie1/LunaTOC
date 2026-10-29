/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudSyncSettings } from '@/components/options/CloudSyncSettings';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  requestPermissions: vi.fn(),
  removePermissions: vi.fn(),
}));
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.sendMessage.mockReset().mockImplementation(async (message: { action: string }) => {
    if (message.action === 'status') return { ok: true, configured: true, autoSyncEnabled: false };
    if (message.action === 'register') return { ok: true, uid: 'firebase-user', emailVerified: false, message: '请验证邮箱' };
    if (message.action === 'login') return { ok: true, uid: 'firebase-user', emailVerified: true, message: '登录成功' };
    if (message.action === 'check-verification') return { ok: true, uid: 'firebase-user', emailVerified: true, message: '邮箱已验证' };
    if (message.action === 'resend-verification') return { ok: true, message: '验证邮件已发送' };
    if (message.action === 'sync') return { ok: true, message: '同步完成' };
    if (message.action === 'set-auto-sync') return { ok: true, autoSyncEnabled: true, message: '云同步已开启' };
    if (message.action === 'sign-out') return { ok: true, message: '云同步已关闭' };
    return { ok: false, error: 'unexpected action' };
  });
  mocks.requestPermissions.mockReset().mockResolvedValue(true);
  mocks.removePermissions.mockReset().mockResolvedValue(true);
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: mocks.sendMessage },
    permissions: { request: mocks.requestPermissions, remove: mocks.removePermissions },
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
function element<T extends HTMLElement>(selector: string): T {
  const found = host.querySelector<T>(selector);
  if (!found) throw new Error('Missing element: ' + selector);
  return found;
}
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function enableForm(): Promise<void> {
  await act(async () => element<HTMLInputElement>('input[aria-label="开启自动云同步"]').click());
}

describe('CloudSyncSettings verified LunaTOC password accounts', () => {
  it('starts disabled without credential inputs before user opts in', async () => {
    await render();
    expect(host.querySelector('input[type="email"]')).toBeNull();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.textContent).toContain('云同步已关闭');
  });

  it('logs in with verified email/password then enables initial sync', async () => {
    await render();
    await enableForm();
    expect(mocks.requestPermissions).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('等待 LunaTOC 登录');
    await typeInto(element<HTMLInputElement>('input[type="email"]'), 'user@example.com');
    await typeInto(element<HTMLInputElement>('input[type="password"]'), 'a-secure-test-password');
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('登录并开启云同步'))?.click());
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'login', 'sync', 'set-auto-sync']);
    expect(element<HTMLInputElement>('input[aria-label="开启自动云同步"]').checked).toBe(true);
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it('registers an account, waits for verified email, then starts syncing', async () => {
    await render();
    await enableForm();
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('注册 LunaTOC'))?.click());
    await typeInto(element<HTMLInputElement>('input[type="email"]'), 'user@example.com');
    await typeInto(element<HTMLInputElement>('input[type="password"]'), 'a-secure-test-password');
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent === '注册 LunaTOC 账号')?.click());
    expect(host.textContent).toContain('邮箱尚未验证');
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'register']);
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('我已完成邮箱验证'))?.click());
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'register', 'check-verification', 'sync', 'set-auto-sync']);
  });

  it('cannot enable without Firebase permissions', async () => {
    mocks.requestPermissions.mockResolvedValueOnce(false);
    await render();
    await enableForm();
    expect(element<HTMLInputElement>('input[aria-label="开启自动云同步"]').checked).toBe(false);
    expect(host.textContent).toContain('未授权 Firebase 网络访问');
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action)).toEqual(['status']);
  });

  it('does not upload if a registered email is still unverified', async () => {
    mocks.sendMessage.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'status') return { ok: true, configured: true, autoSyncEnabled: false };
      if (action === 'register') return { ok: true, uid: 'firebase-user', emailVerified: false, message: '验证邮件已发送' };
      if (action === 'check-verification') return { ok: true, uid: 'firebase-user', emailVerified: false, message: '邮箱尚未验证' };
      return { ok: false, error: 'unexpected action' };
    });
    await render();
    await enableForm();
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('注册 LunaTOC'))?.click());
    await typeInto(element<HTMLInputElement>('input[type="email"]'), 'user@example.com');
    await typeInto(element<HTMLInputElement>('input[type="password"]'), 'a-secure-test-password');
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent === '注册 LunaTOC 账号')?.click());
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('我已完成邮箱验证'))?.click());
    expect(host.textContent).toContain('邮箱尚未验证');
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'register', 'check-verification']);
    expect(element<HTMLInputElement>('input[aria-label="开启自动云同步"]').checked).toBe(true);
  });
});
