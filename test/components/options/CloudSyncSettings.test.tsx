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
    if (message.action === 'login') return { ok: true, uid: 'firebase-user', email: 'user@example.com', emailVerified: true, boundOwners: [], message: '登录成功' };
    if (message.action === 'check-verification') return { ok: true, uid: 'firebase-user', email: 'user@example.com', emailVerified: true, message: '邮箱已验证' };
    if (message.action === 'resend-verification') return { ok: true, message: '验证邮件已发送' };
    if (message.action === 'bind-account') return { ok: true, boundUid: 'firebase-user', message: '绑定成功' };
    if (message.action === 'unbind-account') return { ok: true, message: '已解除绑定' };
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
    expect(host.textContent).not.toContain('官方云同步配置已就绪');
    expect(host.textContent).not.toContain('LunaTOC 云同步（可选）');
    expect(host.querySelector('#cloud-sync-help')).toBeNull();
  });

  it('logs in with verified email/password then enables initial sync', async () => {
    await render();
    await enableForm();
    expect(mocks.requestPermissions).toHaveBeenCalledTimes(1);
    expect(host.querySelector('input[type="email"]')).not.toBeNull();
    const fields = element<HTMLDivElement>('.settings-cloud-credentials');
    expect(fields.querySelectorAll('label')).toHaveLength(2);
    expect(fields.querySelectorAll('input')).toHaveLength(2);
    expect(fields.children[0]).toContain(element<HTMLInputElement>('input[type="email"]'));
    expect(fields.children[1]).toContain(element<HTMLInputElement>('input[type="password"]'));
    await typeInto(element<HTMLInputElement>('input[type="email"]'), 'user@example.com');
    await typeInto(element<HTMLInputElement>('input[type="password"]'), 'a-secure-test-password');
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('登录 LunaTOC 账号'))?.click());
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'login']);
    expect(host.textContent).toContain('绑定当前 ChatGPT 账号');
    expect(host.textContent).toContain('user@example.com');
    expect(host.textContent).not.toContain('Firebase UID');
    expect(host.textContent).not.toContain('当前所选 ChatGPT 账号');
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('绑定当前 ChatGPT 账号并同步'))?.click());
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'login', 'bind-account', 'sync', 'set-auto-sync']);
    expect(element<HTMLInputElement>('input[aria-label="开启自动云同步"]').checked).toBe(true);
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.textContent).not.toContain('此云账号已绑定的 ChatGPT 账号');
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
    expect(host.textContent).toContain('邮箱还没验证');
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'register']);
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('我已完成邮箱验证'))?.click());
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'register', 'check-verification']);
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('绑定当前 ChatGPT 账号并同步'))?.click());
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'register', 'check-verification', 'bind-account', 'sync', 'set-auto-sync']);
  });

  it('requires explicit unbinding before moving local ChatGPT data to another cloud UID', async () => {
    mocks.sendMessage.mockImplementation(async (message: { action: string }) => {
      if (message.action === 'status') return { ok: true, configured: true,
        uid: 'firebase-second', boundUid: 'firebase-original', emailVerified: true, autoSyncEnabled: false };
      if (message.action === 'unbind-account') return { ok: true, message: '解除成功' };
      if (message.action === 'bind-account') return { ok: true, boundUid: 'firebase-second', message: '绑定成功' };
      if (message.action === 'sync') return { ok: true, message: '同步完成' };
      if (message.action === 'set-auto-sync') return { ok: true, autoSyncEnabled: true, message: '已开启' };
      return { ok: false, error: 'unexpected action' };
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render();
    expect(host.textContent).toContain('别的云账号');
    expect(host.textContent).not.toContain('绑定当前 ChatGPT 账号并同步到此云空间');
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('解除当前 ChatGPT 账号原有云端绑定'))?.click());
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'unbind-account']);
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('绑定当前 ChatGPT 账号并同步'))?.click());
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'unbind-account', 'bind-account', 'sync', 'set-auto-sync']);
  });

  it('can explicitly bind another ChatGPT account while cloud sync is already enabled', async () => {
    mocks.sendMessage.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'status') return { ok: true, configured: true,
        uid: 'firebase-user', emailVerified: true, autoSyncEnabled: true };
      if (action === 'bind-account') return { ok: true, boundUid: 'firebase-user', message: '绑定成功' };
      if (action === 'sync') return { ok: true, message: '同步完成' };
      if (action === 'set-auto-sync') return { ok: true, autoSyncEnabled: true, message: '已开启' };
      return { ok: false, error: 'unexpected action' };
    });
    await render();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.textContent).toContain('绑定当前 ChatGPT 账号并同步');
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('绑定当前 ChatGPT 账号并同步'))?.click());
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'bind-account', 'sync', 'set-auto-sync']);
  });

  it('shows the cloud login email without exposing internal UID and binding details', async () => {
    mocks.sendMessage.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'status') return { ok: true, configured: true,
        uid: 'existing-uid', email: 'persisted@example.com', emailVerified: true,
        boundUid: 'existing-uid', boundOwners: ['account-1', 'account-2'], autoSyncEnabled: true };
      return { ok: false, error: 'unexpected action' };
    });
    await render();
    const details = element<HTMLDivElement>('[aria-label="LunaTOC 云账号信息"]');
    expect(details.textContent).toContain('persisted@example.com');
    expect(details.textContent).not.toContain('existing-uid');
    expect(details.textContent).not.toContain('account-1');
    expect(details.textContent).not.toContain('account-2');
    expect(host.textContent).not.toContain('Firebase UID');
    expect(host.textContent).not.toContain('当前所选 ChatGPT 账号');
    expect(host.textContent).not.toContain('该 ChatGPT 账号的云端绑定');
    expect(host.textContent).not.toContain('此云账号已绑定的 ChatGPT 账号');
  });

  it('shows an existing foreign-cloud binding instead of silently transferring local data', async () => {
    mocks.sendMessage.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'status') return { ok: true, configured: true,
        uid: 'current-uid', email: 'current@example.com', emailVerified: true,
        boundUid: 'other-uid', boundOwners: [], autoSyncEnabled: false };
      return { ok: false, error: 'unexpected action' };
    });
    await render();
    expect(host.textContent).not.toContain('绑定其他 LunaTOC 云账号（UID：other-uid）');
    expect(host.textContent).toContain('current@example.com');
    expect(host.textContent).not.toContain('绑定当前 ChatGPT 账号并同步到此云空间');
  });

  it('cannot enable without Firebase permissions', async () => {
    mocks.requestPermissions.mockResolvedValueOnce(false);
    await render();
    await enableForm();
    expect(element<HTMLInputElement>('input[aria-label="开启自动云同步"]').checked).toBe(false);
    expect(host.textContent).toContain('没有开启云同步权限');
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
    expect(host.textContent).toContain('邮箱还没验证');
    expect(mocks.sendMessage.mock.calls.map(([arg]) => arg.action))
      .toEqual(['status', 'register', 'check-verification']);
    expect(element<HTMLInputElement>('input[aria-label="开启自动云同步"]').checked).toBe(true);
  });
});
