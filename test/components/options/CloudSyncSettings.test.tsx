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
    if (message.action === 'send-email-link') return {
      ok: true, message: '验证邮件已发送', pendingEmail: 'user@example.com',
    };
    if (message.action === 'complete-email-link') return { ok: true, uid: 'firebase-user', message: '邮箱验证成功' };
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

describe('CloudSyncSettings passwordless opt-in', () => {
  it('starts disabled and has no account registration, password or Chrome Identity flow', async () => {
    await render();
    expect(host.querySelector('input[type="email"]')).toBeNull();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.textContent).not.toContain('注册同步账号');
    expect(host.textContent).toContain('云同步已关闭');
  });

  it('requests permission, emails a link, verifies the one-time code and starts syncing', async () => {
    await render();
    await enableForm();
    expect(mocks.requestPermissions).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('等待邮箱验证');
    const email = element<HTMLInputElement>('input[type="email"]');
    await typeInto(email, 'user@example.com');
    const buttons = Array.from(host.querySelectorAll('button'));
    await act(async () => buttons.find(b => b.textContent?.includes('发送验证邮件'))?.click());
    await typeInto(element<HTMLInputElement>('input[type="url"]'),
      'https://lunatoc-demo.firebaseapp.com/__/auth/action?mode=signIn&oobCode=code&apiKey=public');
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('验证链接并开启同步'))?.click());
    const actions = mocks.sendMessage.mock.calls.map(([arg]) => arg.action);
    expect(actions).toEqual(['status', 'send-email-link', 'complete-email-link', 'sync', 'set-auto-sync']);
    expect(element<HTMLInputElement>('input[aria-label="开启自动云同步"]').checked).toBe(true);
    expect(host.textContent).toContain('自动同步已开启');
  });

  it('cannot enable without Firebase permissions', async () => {
    mocks.requestPermissions.mockResolvedValueOnce(false);
    await render();
    await enableForm();
    expect(element<HTMLInputElement>('input[aria-label="开启自动云同步"]').checked).toBe(false);
    expect(host.textContent).toContain('未授权 Firebase 网络访问');
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action)).toEqual(['status']);
  });

  it('does not enable auto upload when email verification fails', async () => {
    mocks.sendMessage.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'status') return { ok: true, configured: true, autoSyncEnabled: false };
      if (action === 'complete-email-link') return { ok: false, error: 'EXPIRED_OOB_CODE' };
      return { ok: true, message: 'sent' };
    });
    await render();
    await enableForm();
    await typeInto(element<HTMLInputElement>('input[type="email"]'), 'user@example.com');
    await typeInto(element<HTMLInputElement>('input[type="url"]'), 'https://some-verified-link/');
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('验证链接并开启同步'))?.click());
    expect(host.textContent).toContain('EXPIRED_OOB_CODE');
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .not.toContain('set-auto-sync');
  });
});
