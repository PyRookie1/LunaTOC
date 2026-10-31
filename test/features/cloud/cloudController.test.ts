import { describe, expect, it, vi } from 'vitest';
import { createCloudController, CLOUD_MESSAGE_TYPE, CLOUD_AUTO_SYNC_KEY, CLOUD_ACCOUNT_BINDINGS_KEY, FIREBASE_REQUEST_TIMEOUT_MS } from '@/features/cloud/cloudController';
import { createSerialWriteQueue } from '@/features/storage/serialWriteQueue';
import { PROMPT_STORAGE_KEY } from '@/features/myPrompts/promptWriteCoordinator';
import { ACCOUNT_SETTINGS_KEY } from '@/features/storage/accountSettings';

const owner = 'account-1';
const item = { id: 'tip-a', ownerId: owner, title: 'Saved', content: 'Private content',
  createdAt: 1, updatedAt: 2 };
const settings = { theme: { followChatGPT: false, manualTheme: 'light' },
  sidebar: { layoutMode: 'overlay', backgroundColor: 'default', revealTint: false } };
function storage(initial: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = structuredClone(initial);
  const get = vi.fn(async (keys?: string | string[] | null) => {
    if (keys === undefined || keys === null) return structuredClone(state);
    return structuredClone(Object.fromEntries((typeof keys === 'string' ? [keys] : keys)
      .filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]])));
  });
  const set = vi.fn(async (values: Record<string, unknown>) =>
    { Object.assign(state, structuredClone(values)); });
  const remove = vi.fn(async (keys: string | string[]) => {
    for (const key of typeof keys === 'string' ? [keys] : keys) delete state[key];
  });
  return { state, get, set, remove, getBytesInUse: vi.fn(async () => 0),
    api: { get, set, remove, getBytesInUse: vi.fn(async () => 0) } as unknown as chrome.storage.StorageArea };
}
const request = (action: string, options: Record<string, unknown> = {}) =>
  ({ type: CLOUD_MESSAGE_TYPE, action, ...options });
function firebaseHarness() {
  const documents = new Map<string, { snapshot: unknown; updateTime: string }>();
  let writes = 0;
  let verified = true;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('accounts:sendOobCode')) {
      const body = JSON.parse(init?.body as string) as { requestType?: string };
      if (body.requestType !== 'VERIFY_EMAIL' && body.requestType !== 'PASSWORD_RESET') throw new Error('Unexpected email request');
      return Response.json({ email: 'test@example.com' });
    }
    if (url.includes('securetoken.googleapis.com')) return Response.json({
      id_token: 'new-id-token', refresh_token: 'new-refresh-token', user_id: 'firebase-user',
      expires_in: '3600',
    });
    if (url.includes('accounts:lookup')) return Response.json({
      users: [{ localId: 'firebase-user', email: 'test@example.com', emailVerified: verified }],
    });
    if (url.includes('accounts:signInWithPassword') || url.includes('accounts:signUp')) {
      const body = JSON.parse(init?.body as string) as { email: string; password: string };
      if (body.email !== 'test@example.com' || body.password !== 'a-secure-test-password') {
        return Response.json({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }, { status: 400 });
      }
      return Response.json({
        idToken: 'id-token', refreshToken: 'refresh-token', localId: 'firebase-user', expiresIn: '3600',
      });
    }
    if (url.includes('firestore.googleapis.com')) {
      const key = url.split('?')[0];
      if (init?.method === 'PATCH') {
        const previous = documents.get(key);
        if (previous && !url.includes('currentDocument.updateTime=')) {
          return Response.json({ error: { message: 'FAILED_PRECONDITION' } }, { status: 412 });
        }
        const body = JSON.parse(init.body as string) as { fields: { json: { stringValue: string } } };
        writes += 1;
        const value = { snapshot: JSON.parse(body.fields.json.stringValue), updateTime: '2026-10-28T00:00:00Z' };
        documents.set(key, value);
        return Response.json({ updateTime: value.updateTime });
      }
      const result = documents.get(key);
      return result ? Response.json({
        updateTime: result.updateTime,
        fields: { json: { stringValue: JSON.stringify(result.snapshot) } },
      }) : Response.json({ error: { message: 'NOT_FOUND' } }, { status: 404 });
    }
    throw new Error('Unexpected Firebase URL ' + url);
  });
  return { documents, fetcher, writes: () => writes, setVerified: (value: boolean) => { verified = value; } };
}
const initialLocal = () => ({ [PROMPT_STORAGE_KEY]: [item],
  [ACCOUNT_SETTINGS_KEY]: { [owner]: settings },
  'lunatoc:promptUsage:v1': { 'tip-a': { usageCount: 5, lastUsedAt: 10 } },
});
async function ready(local: ReturnType<typeof storage>, cloud: ReturnType<typeof firebaseHarness>,
  verified = async () => true) {
  const sessions = storage();
  const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
    verified, cloud.fetcher as unknown as typeof fetch,
    { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo', authDomain: 'lunatoc-demo.firebaseapp.com' });
  expect(await service.execute(request('status'))).toMatchObject({ ok: true, configured: true });
  const login = await service.execute(request('login', {
    email: 'test@example.com', password: 'a-secure-test-password',
  }));
  expect(login).toMatchObject({ ok: true, uid: 'firebase-user' });
  const binding = await service.execute(request('bind-account', { ownerId: owner }));
  if (binding.ok) expect(binding.boundUid).toBe('firebase-user');
  return { service, sessions };
}
describe('Firebase REST account sync', () => {
  it('fails a hung fetch after the deadline, aborts it and allows another attempt', async () => {
    const local = storage(initialLocal()), sessions = storage(), cloud = firebaseHarness();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, options?: RequestInit): Promise<Response> => {
      signal = options?.signal ?? undefined;
      // Deliberately ignore AbortSignal. The caller must still settle.
      return new Promise<Response>(() => {});
    });
    const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
      async () => true, fetcher as unknown as typeof fetch,
      { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo',
        authDomain: 'lunatoc-demo.firebaseapp.com' });

    vi.useFakeTimers();
    try {
      const pending = service.execute(request('login', {
        email: 'test@example.com', password: 'a-secure-test-password',
      }));
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(FIREBASE_REQUEST_TIMEOUT_MS);
      expect(await pending).toMatchObject({
        ok: false, error: expect.stringContaining('网络请求超时'),
      });
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(local.state[PROMPT_STORAGE_KEY]).toEqual([item]);
    } finally {
      vi.useRealTimers();
    }
    fetcher.mockImplementation((input, options) => cloud.fetcher(input, options));
    expect(await service.execute(request('login', {
      email: 'test@example.com', password: 'a-secure-test-password',
    }))).toMatchObject({ ok: true, uid: 'firebase-user' });
  });

  it('also times out when Firebase sends headers but never completes the response body', async () => {
    const local = storage(initialLocal()), sessions = storage();
    let signal: AbortSignal | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const responseBody = new ReadableStream<Uint8Array>({
      start(active) {
        controller = active;
        active.enqueue(new TextEncoder().encode('{"idToken":'));
      },
    });
    const fetcher = vi.fn(async (_url: string, options?: RequestInit): Promise<Response> => {
      signal = options?.signal ?? undefined;
      return new Response(responseBody, { status: 200 });
    });
    const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
      async () => true, fetcher as unknown as typeof fetch,
      { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo',
        authDomain: 'lunatoc-demo.firebaseapp.com' });

    vi.useFakeTimers();
    try {
      const pending = service.execute(request('login', {
        email: 'test@example.com', password: 'a-secure-test-password',
      }));
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(FIREBASE_REQUEST_TIMEOUT_MS);
      expect(await pending).toMatchObject({
        ok: false, error: expect.stringContaining('网络请求超时'),
      });
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(local.state[PROMPT_STORAGE_KEY]).toEqual([item]);
    } finally {
      controller?.close();
      vi.useRealTimers();
    }
  });

  it('does not reuse old success after cloud sync is re-enabled', async () => {
    const local = storage({ ...initialLocal(),
      'lunatoc:cloud:auto-sync-status:v1': {
        state: 'success', message: '旧的成功结果', updatedAt: 1,
      },
    });
    const remote = firebaseHarness();
    const { service } = await ready(local, remote);
    const enabled = await service.execute(request('set-auto-sync', { enabled: true }));
    expect(enabled).toMatchObject({ ok: true, autoSyncEnabled: true });
    expect(local.state['lunatoc:cloud:auto-sync-status:v1']).toMatchObject({
      state: 'pending', message: expect.stringContaining('等待首次同步'),
    });
    expect(await service.execute(request('status'))).toMatchObject({
      ok: true, autoSyncEnabled: true, autoSyncStatus: {
        state: 'pending', message: expect.stringContaining('等待首次同步'),
      },
    });
  });

  it('keeps Firebase ID and refresh tokens only in Chrome session storage', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service, sessions } = await ready(local, remote);
    const saved = sessions.state['lunatoc:cloud:auth:session:v1'] as Record<string, unknown>;
    expect(saved.idToken).toBe('id-token');
    expect(saved.refreshToken).toBe('refresh-token');
    expect(local.state).not.toHaveProperty('lunatoc:cloud:auth:session:v1');
    expect(JSON.stringify(local.state)).not.toContain('refresh-token');
    await service.execute(request('set-auto-sync', { enabled: true }));
    // MV3 worker suspension must not log the user out: session storage survives it.
    const restartedWorker = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
      async () => true, remote.fetcher as unknown as typeof fetch,
      { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo',
        authDomain: 'lunatoc-demo.firebaseapp.com' });
    expect(await restartedWorker.execute(request('status')))
      .toMatchObject({ ok: true, uid: 'firebase-user', autoSyncEnabled: true });
  });

  it('removes old long-lived credentials without reusing them for login', async () => {
    const previousSession = {
      idToken: 'old-id-token', refreshToken: 'old-refresh-token',
      uid: 'firebase-user', expiresAt: Date.now() + 3_600_000, emailVerified: true,
    };
    const local = storage({ ...initialLocal(), [CLOUD_AUTO_SYNC_KEY]: true,
      'lunatoc:cloud:auth:session:v1': previousSession });
    const sessions = storage(), remote = firebaseHarness();
    const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
      async () => true, remote.fetcher as unknown as typeof fetch,
      { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo',
        authDomain: 'lunatoc-demo.firebaseapp.com' });
    expect(await service.execute(request('status'))).toMatchObject({
      ok: true, autoSyncEnabled: false,
      autoSyncStatus: { state: 'error', message: expect.stringContaining('重新登录') },
    });
    expect(local.state).not.toHaveProperty('lunatoc:cloud:auth:session:v1');
    expect(sessions.state).not.toHaveProperty('lunatoc:cloud:auth:session:v1');
    expect(remote.fetcher).not.toHaveBeenCalled();
    expect(local.state[PROMPT_STORAGE_KEY]).toEqual([item]);
    expect((await service.execute(request('login', {
      email: 'test@example.com', password: 'a-secure-test-password',
    }))).ok).toBe(true);
    expect(sessions.state).toHaveProperty('lunatoc:cloud:auth:session:v1');
    expect(local.state).not.toHaveProperty('lunatoc:cloud:auth:session:v1');
  });

  it('disables automatic sync after a complete browser restart without erasing local content', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service } = await ready(local, remote);
    expect(await service.execute(request('set-auto-sync', { enabled: true })))
      .toMatchObject({ ok: true, autoSyncEnabled: true });
    // New empty chrome.storage.session models a full browser shutdown and restart.
    const restartedSessionStorage = storage();
    const restartedWorker = createCloudController(local.api, restartedSessionStorage.api,
      createSerialWriteQueue(), async () => true, remote.fetcher as unknown as typeof fetch,
      { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo',
        authDomain: 'lunatoc-demo.firebaseapp.com' });
    const result = await restartedWorker.execute(request('status'));
    expect(result).toMatchObject({ ok: true, autoSyncEnabled: false });
    if (result.ok) expect(result.uid).toBeUndefined();
    expect(local.state[CLOUD_AUTO_SYNC_KEY]).toBe(false);
    expect(local.state[PROMPT_STORAGE_KEY]).toEqual([item]);
    expect(local.state[ACCOUNT_SETTINGS_KEY]).toEqual({ [owner]: settings });
    expect(restartedSessionStorage.state).not.toHaveProperty('lunatoc:cloud:auth:session:v1');
  });
  it('returns the authenticated email and per-UID bindings without persisting any password', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service, sessions } = await ready(local, remote);
    expect(await service.execute(request('status', { ownerId: owner })))
      .toMatchObject({ ok: true, email: 'test@example.com', uid: 'firebase-user',
        boundUid: 'firebase-user', boundOwners: [owner] });
    const stored = sessions.state['lunatoc:cloud:auth:session:v1'] as Record<string, unknown>;
    expect(stored.email).toBe('test@example.com');
    expect(JSON.stringify(sessions.state)).not.toContain('a-secure-test-password');
    // An older stored session without email may be restored by Firebase lookup.
    delete stored.email;
    expect(await service.execute(request('status', { ownerId: owner })))
      .toMatchObject({ ok: true, email: 'test@example.com', boundOwners: [owner] });
    expect((sessions.state['lunatoc:cloud:auth:session:v1'] as Record<string, unknown>).email)
      .toBe('test@example.com');
  });

  it('does not disable automatic sync when the same Firebase UID logs in again', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service } = await ready(local, remote);
    expect(await service.execute(request('set-auto-sync', { enabled: true })))
      .toMatchObject({ ok: true, autoSyncEnabled: true });
    expect((await service.execute(request('login', {
      email: 'test@example.com', password: 'a-secure-test-password',
    }))).ok).toBe(true);
    expect(local.state[CLOUD_AUTO_SYNC_KEY]).toBe(true);
    expect(await service.execute(request('status')))
      .toMatchObject({ ok: true, autoSyncEnabled: true, uid: 'firebase-user' });
  });

  it('requires explicit binding and never syncs all local ChatGPT accounts on login', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness(), sessions = storage();
    const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
      async () => true, remote.fetcher as unknown as typeof fetch,
      { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo', authDomain: 'lunatoc-demo.firebaseapp.com' });
    expect((await service.execute(request('login', {
      email: 'test@example.com', password: 'a-secure-test-password',
    }))).ok).toBe(true);
    expect(await service.execute(request('sync', { ownerId: owner })))
      .toMatchObject({ ok: false, error: expect.stringContaining('未绑定') });
    expect(remote.writes()).toBe(0);
    expect(await service.execute(request('bind-account', { ownerId: owner })))
      .toMatchObject({ ok: true, boundUid: 'firebase-user' });
    expect(await service.execute(request('status', { ownerId: owner })))
      .toMatchObject({ ok: true, boundUid: 'firebase-user', boundOwners: [owner] });
    expect((await service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);
  });

  it('keeps the former cloud owner binding when LunaTOC UID changes until explicitly unbound', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service, sessions } = await ready(local, remote);
    const stored = sessions.state['lunatoc:cloud:auth:session:v1'] as Record<string, unknown>;
    sessions.state['lunatoc:cloud:auth:session:v1'] = {
      ...stored, uid: 'firebase-second', idToken: 'token-second', refreshToken: 'refresh-second',
    };
    expect(await service.execute(request('status', { ownerId: owner })))
      .toMatchObject({ ok: true, boundUid: 'firebase-user', boundOwners: [] });
    expect(await service.execute(request('sync', { ownerId: owner })))
      .toMatchObject({ ok: false, error: expect.stringContaining('未绑定') });
    expect(await service.execute(request('bind-account', { ownerId: owner })))
      .toMatchObject({ ok: false, error: expect.stringContaining('另一个') });
    expect(remote.writes()).toBe(0);
    expect(await service.execute(request('unbind-account', { ownerId: owner })))
      .toMatchObject({ ok: true });
    expect(local.state[PROMPT_STORAGE_KEY]).toEqual([item]);
    expect(await service.execute(request('bind-account', { ownerId: owner })))
      .toMatchObject({ ok: true, boundUid: 'firebase-second' });
    expect((await service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);
    expect([...remote.documents.keys()].some((key) => key.includes('/users/firebase-second/accounts/'))).toBe(true);
  });

  it('fails closed on malformed local cloud binding records', async () => {
    const local = storage({ ...initialLocal(), [CLOUD_ACCOUNT_BINDINGS_KEY]: { [owner]: null } });
    const cloud = firebaseHarness(), sessions = storage();
    const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
      async () => true, cloud.fetcher as unknown as typeof fetch,
      { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo', authDomain: 'lunatoc-demo.firebaseapp.com' });
    expect(await service.execute(request('status'))).toMatchObject({
      ok: false, error: expect.stringContaining('绑定记录无效'),
    });
  });
  it('rejects user-specified Firebase backend without a managed project configuration', async () => {
    const local = storage({ 'lunatoc:cloud:config:v1': {
      projectId: 'attacker-project', apiKey: 'AIzaSy-Attacker-public-key',
    } });
    const sessions = storage(), remote = firebaseHarness();
    const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
      async () => true, remote.fetcher as unknown as typeof fetch, null);
    expect(await service.execute(request('status'))).toMatchObject({ ok: true, configured: false });
    expect(await service.execute(request('configure', {
      config: { projectId: 'attacker-project', apiKey: 'AIzaSy-Attacker-public-key' },
    }))).toMatchObject({ ok: false, error: expect.stringContaining('禁止') });
    expect(await service.execute(request('login', { email: 'test@example.com', password: 'a-secure-test-password' }))).toMatchObject({ ok: false, error: expect.stringContaining('尚未配置') });
    expect(remote.fetcher).not.toHaveBeenCalled();
  });
  it('registers with a password, sends a verification email, and blocks cloud access until verified', async () => {
    const local = storage(), sessions = storage(), cloud = firebaseHarness();
    cloud.setVerified(false);
    const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
      async () => true, cloud.fetcher as unknown as typeof fetch,
      { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo',
        authDomain: 'lunatoc-demo.firebaseapp.com' });
    const signup = await service.execute(request('register', {
      email: 'test@example.com', password: 'a-secure-test-password',
    }));
    expect(signup).toMatchObject({ ok: true, uid: 'firebase-user', emailVerified: false });
    const verify = cloud.fetcher.mock.calls.find(([url]) => String(url).includes('accounts:sendOobCode'));
    expect(JSON.parse(verify?.[1]?.body as string)).toEqual({
      requestType: 'VERIFY_EMAIL', idToken: 'id-token',
    });
    expect(JSON.stringify(sessions.state)).not.toContain('a-secure-test-password');
    expect(await service.execute(request('set-auto-sync', { enabled: true })))
      .toMatchObject({ ok: false, error: expect.stringContaining('验证') });
    expect(await service.execute(request('sync', { ownerId: owner })))
      .toMatchObject({ ok: false, error: expect.stringContaining('验证') });
    cloud.setVerified(true);
    expect(await service.execute(request('check-verification')))
      .toMatchObject({ ok: true, emailVerified: true });
    expect(await service.execute(request('set-auto-sync', { enabled: true })))
      .toMatchObject({ ok: false, error: expect.stringContaining('绑定') });
    expect(await service.execute(request('bind-account', { ownerId: owner })))
      .toMatchObject({ ok: true, boundUid: 'firebase-user' });
    expect(await service.execute(request('set-auto-sync', { enabled: true })))
      .toMatchObject({ ok: true, autoSyncEnabled: true });
  });

  it('uses the password-reset mail quota only on explicit user request', async () => {
    const local = storage(), sessions = storage(), cloud = firebaseHarness();
    const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
      async () => true, cloud.fetcher as unknown as typeof fetch,
      { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo',
        authDomain: 'lunatoc-demo.firebaseapp.com' });
    expect(await service.execute(request('reset-password', { email: 'test@example.com' })))
      .toMatchObject({ ok: true, message: expect.stringContaining('如该邮箱已注册') });
    const sent = cloud.fetcher.mock.calls.find(([url]) => String(url).includes('accounts:sendOobCode'));
    expect(JSON.parse(sent?.[1]?.body as string)).toEqual({
      requestType: 'PASSWORD_RESET', email: 'test@example.com',
    });
    expect(sessions.state).not.toHaveProperty('lunatoc:cloud:auth:session:v1');
  });

  it('identifies revoked Firebase host permission instead of a bare Failed to fetch', async () => {
    const local = storage(), sessions = storage(), cloud = firebaseHarness();
    const contains = vi.fn(async () => false);
    vi.stubGlobal('chrome', { permissions: { contains } });
    try {
      cloud.fetcher.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
      const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
        async () => true, cloud.fetcher as unknown as typeof fetch,
        { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo',
          authDomain: 'lunatoc-demo.firebaseapp.com' });
      const result = await service.execute(request('login', {
        email: 'test@example.com', password: 'a-secure-test-password',
      }));
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Firebase 网络权限不足') });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('identitytoolkit.googleapis.com') });
      expect(contains).toHaveBeenCalledWith({
        origins: ['https://identitytoolkit.googleapis.com/*'],
      });
      expect(sessions.state).not.toHaveProperty('lunatoc:cloud:auth:session:v1');
      expect(local.state).not.toHaveProperty(CLOUD_AUTO_SYNC_KEY);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('identifies Firebase network failure when optional permissions are already granted', async () => {
    const local = storage(), sessions = storage(), cloud = firebaseHarness();
    const contains = vi.fn(async () => true);
    vi.stubGlobal('chrome', { permissions: { contains } });
    try {
      cloud.fetcher.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
      const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
        async () => true, cloud.fetcher as unknown as typeof fetch,
        { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo',
          authDomain: 'lunatoc-demo.firebaseapp.com' });
      const result = await service.execute(request('login', {
        email: 'test@example.com', password: 'a-secure-test-password',
      }));
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('无法连接 Firebase') });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('DNS') });
      expect(sessions.state).not.toHaveProperty('lunatoc:cloud:auth:session:v1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects incorrect credentials and short passwords without establishing any session', async () => {
    const local = storage(), sessions = storage(), cloud = firebaseHarness();
    const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
      async () => true, cloud.fetcher as unknown as typeof fetch,
      { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo',
        authDomain: 'lunatoc-demo.firebaseapp.com' });
    expect((await service.execute(request('login', { email: 'test@example.com',
      password: 'short' }))).ok).toBe(false);
    expect((await service.execute(request('login', { email: 'test@example.com',
      password: 'wrong-long-password' }))).ok).toBe(false);
    expect(sessions.state).not.toHaveProperty('lunatoc:cloud:auth:session:v1');
  });

  it('clears the persisted Firebase session when sync is disabled', async () => {
    const local = storage(), cloud = firebaseHarness();
    const { service, sessions } = await ready(local, cloud);
    expect(sessions.state).toHaveProperty('lunatoc:cloud:auth:session:v1');
    await service.execute(request('set-auto-sync', { enabled: true }));
    expect(await service.execute(request('set-auto-sync', { enabled: false })))
      .toMatchObject({ ok: true, autoSyncEnabled: false });
    expect(sessions.state).not.toHaveProperty('lunatoc:cloud:auth:session:v1');
  });

  it('never persists managed Firebase project identifiers to local storage', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service } = await ready(local, remote);
    expect((await service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);
    expect(local.state).not.toHaveProperty('lunatoc:cloud:config:v1');
    expect(JSON.stringify(local.state)).not.toContain('AIzaSy-Test-api-key-public');
  });

  it('uploads only allowed account snapshot after opt-in, never usage or auth secrets', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service } = await ready(local, remote);
    expect(remote.writes()).toBe(0);
    expect(await service.execute(request('sync', { ownerId: owner }))).toMatchObject({ ok: true });
    expect(remote.writes()).toBe(1);
    const written = [...remote.documents.values()][0].snapshot as Record<string, unknown>;
    expect(written.prompts).toEqual([item]);
    expect(written).not.toHaveProperty('promptUsage');
    expect(JSON.stringify(written)).not.toContain('refresh-token');
    expect(local.state['lunatoc:promptUsage:v1']).toEqual({ 'tip-a': { usageCount: 5, lastUsedAt: 10 } });
    expect(await service.execute(request('sync', { ownerId: owner }))).toMatchObject({ ok: true });
    expect(remote.writes()).toBe(1);
  });
  it('accepts equivalent Chrome storage readback with different nested property ordering', async () => {
    const other = { ...item, id: 'tip-b', ownerId: 'account-2', title: 'Other account' };
    const local = storage({
      [PROMPT_STORAGE_KEY]: [item, other],
      [ACCOUNT_SETTINGS_KEY]: { [owner]: settings, 'account-2': settings },
    });
    const remote = firebaseHarness();
    const { service } = await ready(local, remote);
    const originalGet = local.get.getMockImplementation()!;
    const reorder = <T>(value: T): T => {
      if (Array.isArray(value)) return value.map(reorder) as T;
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).reverse()
          .map(([key, entry]) => [key, reorder(entry)])) as T;
      }
      return value;
    };
    // Simulate Chrome's readback normalization of object key ordering.
    local.get.mockImplementation(async (keys?: string | string[] | null) =>
      reorder(await originalGet(keys)));
    expect(await service.execute(request('sync', { ownerId: owner })))
      .toMatchObject({ ok: true });
    const persisted = local.state[PROMPT_STORAGE_KEY] as typeof item[];
    expect([...persisted].sort((a, b) => a.id.localeCompare(b.id))).toEqual([item, other]);
    expect(local.state[ACCOUNT_SETTINGS_KEY]).toEqual({ [owner]: settings, 'account-2': settings });
    expect(remote.writes()).toBe(1);
    expect(await service.execute(request('sync', { ownerId: owner })))
      .toMatchObject({ ok: true });
    expect(remote.writes()).toBe(1);
  });

  it('still rejects a genuinely corrupted local write and rolls it back', async () => {
    const local = storage(initialLocal());
    const remote = firebaseHarness();
    const { service } = await ready(local, remote);
    const before = structuredClone(local.state);
    const originalSet = local.set.getMockImplementation()!;
    let corruptOnce = true;
    local.set.mockImplementation(async (values: Record<string, unknown>) => {
      await originalSet(values);
      if (corruptOnce && Object.hasOwn(values, PROMPT_STORAGE_KEY)) {
        corruptOnce = false;
        local.state[PROMPT_STORAGE_KEY] = [{ ...item, title: 'Damaged write' }];
      }
    });
    const result = await service.execute(request('sync', { ownerId: owner }));
    expect(result).toMatchObject({
      ok: false, error: expect.stringContaining('本地同步写入后核验失败'),
    });
    expect(local.state).toEqual(before);
    expect(remote.writes()).toBe(1);
    expect(Object.keys(local.state).some((key) => key.startsWith('lunatoc:cloud:baseline:'))).toBe(false);
  });

  it('downloads onto another device without modifying a separate ChatGPT account', async () => {
    const cloud = firebaseHarness();
    const first = storage(initialLocal());
    const a = await ready(first, cloud);
    expect((await a.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);
    const unrelated = { ...item, id: 'other-tip', ownerId: 'account-2' };
    const next = storage({ [PROMPT_STORAGE_KEY]: [unrelated], [ACCOUNT_SETTINGS_KEY]: {
      'account-2': settings,
    } });
    const b = await ready(next, cloud);
    expect((await b.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);
    expect(next.state[PROMPT_STORAGE_KEY]).toEqual([unrelated, item]);
    expect(next.state[ACCOUNT_SETTINGS_KEY]).toEqual({ 'account-2': settings, [owner]: settings });
  });

  it('enables and disables automatic sync without deleting local data', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service } = await ready(local, remote);
    expect(await service.execute(request('set-auto-sync', { enabled: true })))
      .toMatchObject({ ok: true, autoSyncEnabled: true });
    expect(local.state[CLOUD_AUTO_SYNC_KEY]).toBe(true);
    expect(await service.execute(request('set-auto-sync', { enabled: false })))
      .toMatchObject({ ok: true, autoSyncEnabled: false });
    expect(local.state[CLOUD_AUTO_SYNC_KEY]).toBe(false);
    expect(local.state[PROMPT_STORAGE_KEY]).toEqual([item]);
    expect(await service.execute(request('status')))
      .toMatchObject({ ok: true, configured: true, autoSyncEnabled: false });
  });

  it('refuses unverified account syncing even if Firebase is already logged in', async () => {
    const local = storage(initialLocal()), cloud = firebaseHarness();
    const { service } = await ready(local, cloud, async () => false);
    const result = await service.execute(request('sync', { ownerId: owner }));
    expect(result.ok).toBe(false);
    expect(remoteCalls(cloud)).toBe(0);
  });
  it('rejects Firestore permissions errors without modifying local data', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service } = await ready(local, remote);
    const original = structuredClone(local.state);
    const previous = remote.fetcher.getMockImplementation()!;
    remote.fetcher.mockImplementation(async (url, options) => {
      if (String(url).includes('firestore.googleapis.com')) {
        return Response.json({ error: { message: 'PERMISSION_DENIED' } }, { status: 403 });
      }
      return previous(url, options);
    });
    const response = await service.execute(request('sync', { ownerId: owner }));
    expect(response).toMatchObject({ ok: false, error: expect.stringContaining('PERMISSION_DENIED') });
    expect(local.state).toEqual(original);
    expect(remote.writes()).toBe(0);
  });

  it('does not apply a cloud merge if an optimistic PATCH precondition fails', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service } = await ready(local, remote);
    const before = structuredClone(local.state);
    const previous = remote.fetcher.getMockImplementation()!;
    remote.fetcher.mockImplementation(async (url, options) => {
      if (String(url).includes('firestore.googleapis.com') && options?.method === 'PATCH') {
        return Response.json({ error: { message: 'FAILED_PRECONDITION' } }, { status: 412 });
      }
      return previous(url, options);
    });
    const response = await service.execute(request('sync', { ownerId: owner }));
    expect(response).toMatchObject({ ok: false, error: expect.stringContaining('FAILED_PRECONDITION') });
    expect(local.state).toEqual(before);
    expect(remote.writes()).toBe(0);
  });

  it('reports network failure without deleting local data or claiming success', async () => {
    const local = storage(initialLocal()), cloud = firebaseHarness();
    const { service } = await ready(local, cloud);
    cloud.fetcher.mockImplementation(async () => { throw new Error('offline'); });
    expect(await service.execute(request('sync', { ownerId: owner })))
      .toEqual({ ok: false, error: 'offline' });
    expect(local.state[PROMPT_STORAGE_KEY]).toEqual([item]);
    expect(local.state[ACCOUNT_SETTINGS_KEY]).toEqual({ [owner]: settings });
  });
});
function remoteCalls(cloud: ReturnType<typeof firebaseHarness>): number {
  return cloud.fetcher.mock.calls.filter(([url]) => String(url).includes('firestore')).length;
}
