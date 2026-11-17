import { describe, expect, it, vi } from 'vitest';
import { createCloudController, CLOUD_MESSAGE_TYPE, CLOUD_AUTO_SYNC_KEY, CLOUD_ACCOUNT_BINDINGS_KEY, FIREBASE_REQUEST_TIMEOUT_MS } from '@/features/cloud/cloudController';
import { createSerialWriteQueue } from '@/features/storage/serialWriteQueue';
import { PROMPT_STORAGE_KEY, PROMPT_DELETED_STORAGE_KEY, PROMPT_COMMIT_TYPE, createPromptWriteCoordinator } from '@/features/myPrompts/promptWriteCoordinator';
import { ACCOUNT_SETTINGS_KEY } from '@/features/storage/accountSettings';
import { createTocAliasWriteCoordinator, TOC_ALIAS_COMMIT_TYPE, TOC_ALIAS_PREFIX, TOC_ALIAS_DELETED_PREFIX, TOC_ALIAS_RECORD_DELETED_PREFIX } from '@/features/conversationPrompts/tocAliasWriteCoordinator';

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
  const documents = new Map<string, {
    snapshot?: unknown; quota?: {
      accountHashes: string[]; lastAccountHash: string;
      dailyWrites: number; windowStart: string; lastWriteAt: string;
    }; updateTime: string;
  }>();
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
      if (url.endsWith('/documents:commit') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as {
          writes: Array<{
            update: { name: string; fields: Record<string, unknown> };
            currentDocument?: { updateTime?: string; exists?: boolean };
            updateTransforms?: Array<{ fieldPath: string; setToServerValue: string }>;
          }>;
        };
        const pending: Array<{ key: string; value: {
          snapshot?: unknown; quota?: {
            accountHashes: string[]; lastAccountHash: string;
            dailyWrites: number; windowStart: string; lastWriteAt: string;
          }; updateTime: string;
        } }> = [];
        const commitTime = new Date(Date.now() + (writes + 1) * 10_000).toISOString();
        for (const write of body.writes) {
          const key = 'https://firestore.googleapis.com/v1/' + write.update.name;
          const previous = documents.get(key);
          const precondition = write.currentDocument;
          if ((precondition?.exists === false && previous) ||
              (precondition?.updateTime && previous?.updateTime !== precondition.updateTime) ||
              (precondition?.updateTime && !previous)) {
            return Response.json({
              error: { status: 'FAILED_PRECONDITION', message: 'FAILED_PRECONDITION' },
            }, { status: 412 });
          }
          const fields = write.update.fields;
          const transforms = write.updateTransforms ?? [];
          const serverTimestamp = (field: string) =>
            transforms.some((entry) => entry.fieldPath === field && entry.setToServerValue === 'REQUEST_TIME');
          if (write.update.name.includes('/accounts/')) {
            const json = (fields.json as { stringValue?: string } | undefined)?.stringValue;
            if (typeof json !== 'string') return Response.json({ error: { message: 'INVALID_ARGUMENT' } }, { status: 400 });
            pending.push({ key, value: {
              snapshot: JSON.parse(json), updateTime: commitTime,
            } });
          } else if (write.update.name.endsWith('/usage/cloudWrites')) {
            const array = (fields.accountHashes as { arrayValue?: { values?: Array<{ stringValue?: string }> } } | undefined)
              ?.arrayValue?.values ?? [];
            const windowStart = serverTimestamp('windowStart')
              ? commitTime
              : (fields.windowStart as { timestampValue?: string } | undefined)?.timestampValue;
            const lastWriteAt = serverTimestamp('lastWriteAt')
              ? commitTime
              : (fields.lastWriteAt as { timestampValue?: string } | undefined)?.timestampValue;
            const quota = {
              accountHashes: array.map((entry) => entry.stringValue ?? ''),
              lastAccountHash: (fields.lastAccountHash as { stringValue?: string } | undefined)?.stringValue ?? '',
              dailyWrites: Number((fields.dailyWrites as { integerValue?: string } | undefined)?.integerValue),
              windowStart: windowStart ?? '',
              lastWriteAt: lastWriteAt ?? '',
            };
            pending.push({ key, value: { quota, updateTime: commitTime } });
          } else {
            return Response.json({ error: { message: 'Unexpected Firestore write path' } }, { status: 400 });
          }
        }
        for (const item of pending) documents.set(item.key, item.value);
        writes += 1;
        return Response.json({ writeResults: body.writes.map(() => ({})), commitTime });
      }

      const result = documents.get(url);
      if (!result) return Response.json({ error: { message: 'NOT_FOUND' } }, { status: 404 });
      if (url.endsWith('/usage/cloudWrites')) {
        const quota = result.quota!;
        return Response.json({
          updateTime: result.updateTime,
          fields: {
            accountHashes: { arrayValue: { values: quota.accountHashes.map((hash) => ({ stringValue: hash })) } },
            lastAccountHash: { stringValue: quota.lastAccountHash },
            dailyWrites: { integerValue: String(quota.dailyWrites) },
            windowStart: { timestampValue: quota.windowStart },
            lastWriteAt: { timestampValue: quota.lastWriteAt },
          },
        });
      }
      return Response.json({
        updateTime: result.updateTime,
        fields: { json: { stringValue: JSON.stringify(result.snapshot) } },
      });
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
    expect([...remote.documents.keys()].some((key) => key.includes('/accounts/'))).toBe(true);
    expect([...remote.documents.keys()].some((key) => key.endsWith('/usage/cloudWrites'))).toBe(true);
    const written = [...remote.documents.values()][0].snapshot as Record<string, unknown>;
    expect(written.prompts).toEqual([item]);
    expect(written).not.toHaveProperty('promptUsage');
    expect(JSON.stringify(written)).not.toContain('refresh-token');
    expect(local.state['lunatoc:promptUsage:v1']).toEqual({ 'tip-a': { usageCount: 5, lastUsedAt: 10 } });
    const quota = [...remote.documents.values()].find((entry) => entry.quota)?.quota;
    expect(quota).toMatchObject({
      accountHashes: [expect.stringMatching(/^acct_[a-f0-9]{64}$/)],
      dailyWrites: 1, lastAccountHash: expect.stringMatching(/^acct_[a-f0-9]{64}$/),
    });
    expect(quota).not.toHaveProperty('version');
    expect(await service.execute(request('sync', { ownerId: owner }))).toMatchObject({ ok: true });
    expect(remote.writes()).toBe(1);
    expect([...remote.documents.values()].find((entry) => entry.quota)?.quota?.dailyWrites).toBe(1);
  });

  it('clears obsolete sync baselines once and rebuilds the cloud snapshot from local data', async () => {
    const staleBaseline = 'lunatoc:cloud:baseline:old-project:firebase-user:legacy';
    const local = storage({ ...initialLocal(), [staleBaseline]: {
      prompts: [{ ...item, id: 'stale-baseline-prompt' }], aliases: {}, settings: null,
      deletedRoutes: [], deletedAliases: [], deletedPrompts: [],
    } });
    const remote = firebaseHarness();
    const { service } = await ready(local, remote);
    expect(await service.execute(request('sync', { ownerId: owner }))).toMatchObject({ ok: true });
    expect((local.state[PROMPT_STORAGE_KEY] as typeof item[]).map((entry) => entry.id)).toEqual(['tip-a']);
    expect(local.state).not.toHaveProperty(staleBaseline);
    expect(Object.keys(local.state).some((key) => key.startsWith('lunatoc:cloud:baseline:'))).toBe(true);
    const snapshot = [...remote.documents.entries()]
      .find(([key]) => key.includes('/accounts/'))?.[1].snapshot as Record<string, unknown>;
    expect(snapshot.prompts).toEqual([item]);
  });

  it('fails closed when a UID has already registered twenty cloud ChatGPT accounts', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service } = await ready(local, remote);
    expect((await service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);
    const accountKey = [...remote.documents.keys()].find((key) => key.includes('/accounts/'))!;
    const ownerHash = accountKey.split('/accounts/')[1];
    const quotaKey = [...remote.documents.keys()].find((key) => key.endsWith('/usage/cloudWrites'))!;
    const current = remote.documents.get(quotaKey)!;
    const accountHashes = [ownerHash, ...Array.from({ length: 19 }, (_, index) =>
      'acct_' + (index + 1).toString(16).padStart(64, '0'))];
    remote.documents.set(quotaKey, {
      updateTime: current.updateTime,
      quota: {
        accountHashes, lastAccountHash: ownerHash, dailyWrites: 1,
        windowStart: new Date().toISOString(), lastWriteAt: new Date().toISOString(),
      },
    });
    const otherPrompt = { ...item, id: 'tip-b', ownerId: 'account-2', title: 'Second account' };
    local.state[PROMPT_STORAGE_KEY] = [item, otherPrompt];
    expect(await service.execute(request('bind-account', { ownerId: 'account-2' })))
      .toMatchObject({ ok: true, boundUid: 'firebase-user' });
    const before = structuredClone(local.state);
    const result = await service.execute(request('sync', { ownerId: 'account-2' }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('20 个 ChatGPT 账号') });
    expect(local.state).toEqual(before);
    expect(remote.writes()).toBe(1);
  });

  it('preserves local data when Firestore enforces the 24-hour daily write quota', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service } = await ready(local, remote);
    expect((await service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);
    const quotaKey = [...remote.documents.keys()].find((key) => key.endsWith('/usage/cloudWrites'))!;
    const current = remote.documents.get(quotaKey)!;
    const now = new Date().toISOString();
    const lastWrite = new Date(Date.now() - 10_000).toISOString();
    remote.documents.set(quotaKey, {
      updateTime: current.updateTime,
      quota: {
        ...current.quota!, dailyWrites: 100, windowStart: now, lastWriteAt: lastWrite,
      },
    });
    const other = { ...item, id: 'tip-b', title: 'Local change' };
    local.state[PROMPT_STORAGE_KEY] = [item, other];
    const before = structuredClone(local.state);
    const original = remote.fetcher.getMockImplementation()!;
    remote.fetcher.mockImplementation(async (url, options) => {
      if (String(url).endsWith('/documents:commit') && options?.method === 'POST') {
        return Response.json({ error: { status: 'PERMISSION_DENIED', message: 'PERMISSION_DENIED' } }, { status: 403 });
      }
      return original(url, options);
    });
    const result = await service.execute(request('sync', { ownerId: owner }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('当前 24 小时配额窗口的 100 次写入上限') });
    expect(local.state).toEqual(before);
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


  it('propagates prompt deletion to an already-synced device and blocks stale first-sync resurrection', async () => {
    const cloud = firebaseHarness();
    const firstLocal = storage(initialLocal());
    const first = await ready(firstLocal, cloud);
    expect((await first.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    const secondLocal = storage(initialLocal());
    const second = await ready(secondLocal, cloud);
    expect((await second.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    const writer = createPromptWriteCoordinator(firstLocal.api, createSerialWriteQueue());
    expect(await writer.commit({
      type: PROMPT_COMMIT_TYPE, action: 'replace-account', ownerId: owner,
      expected: [item], next: [],
    })).toEqual({ ok: true });
    expect(firstLocal.state[PROMPT_DELETED_STORAGE_KEY]).toEqual({ [owner]: ['tip-a'] });
    expect((await first.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    const remoteDocument = [...cloud.documents.values()][0].snapshot as {
      prompts: typeof item[]; deletedPrompts: string[];
    };
    expect(remoteDocument.prompts).toEqual([]);
    expect(remoteDocument.deletedPrompts).toEqual(['tip-a']);

    // Device two has an acknowledged pre-delete baseline, so the remote
    // tombstone wins over its unchanged stale copy and is persisted locally.
    expect(await second.service.execute(request('sync', { ownerId: owner }))).toMatchObject({ ok: true });
    expect(secondLocal.state[PROMPT_STORAGE_KEY]).toEqual([]);
    expect(secondLocal.state[PROMPT_DELETED_STORAGE_KEY]).toEqual({ [owner]: ['tip-a'] });

    // A newly installed/stale device has no baseline. It must stop on the
    // add-versus-tombstone conflict rather than upload the deleted prompt.
    const staleLocal = storage(initialLocal());
    const stale = await ready(staleLocal, cloud);
    const blocked = await stale.service.execute(request('sync', { ownerId: owner }));
    expect(blocked).toMatchObject({ ok: false, error: expect.stringContaining('同时修改') });
    expect(staleLocal.state[PROMPT_STORAGE_KEY]).toEqual([item]);
    expect([...cloud.documents.values()][0].snapshot).toMatchObject({
      prompts: [], deletedPrompts: ['tip-a'],
    });
  });




  it('syncs last-alias deletion without fencing the conversation and supports re-add', async () => {
    const cloud = firebaseHarness();
    const route = 'conversation-123';
    const aliasKey = TOC_ALIAS_PREFIX + route;
    const recordFenceKey = TOC_ALIAS_RECORD_DELETED_PREFIX + route;
    const alias = { ownerId: owner, aliases: { 'message-1': 'Saved heading' } };
    const firstLocal = storage({ ...initialLocal(), [aliasKey]: alias });
    const first = await ready(firstLocal, cloud);
    expect((await first.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    const secondLocal = storage({ ...initialLocal(), [aliasKey]: alias });
    const second = await ready(secondLocal, cloud);
    expect((await second.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    const writer = createTocAliasWriteCoordinator(firstLocal.api, createSerialWriteQueue());
    expect(await writer.commit({
      type: TOC_ALIAS_COMMIT_TYPE, action: 'update', routeKey: route,
      messageId: 'message-1', label: null, ownerId: owner,
    })).toMatchObject({ ok: true, deletedRecord: true });
    expect(firstLocal.state[recordFenceKey]).toMatchObject({ ownerId: owner });
    expect((await first.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    let remote = [...cloud.documents.values()][0].snapshot as {
      aliases: Record<string, unknown>; deletedAliases: string[]; deletedRoutes: string[];
    };
    expect(remote.aliases).toEqual({});
    expect(remote.deletedAliases).toEqual([route]);
    expect(remote.deletedRoutes).toEqual([]);

    expect(await second.service.execute(request('sync', { ownerId: owner }))).toMatchObject({ ok: true });
    expect(secondLocal.state[aliasKey]).toBeUndefined();
    expect(secondLocal.state[recordFenceKey]).toMatchObject({ ownerId: owner });
    expect(secondLocal.state[TOC_ALIAS_DELETED_PREFIX + route]).toBeUndefined();

    const staleLocal = storage({ ...initialLocal(), [aliasKey]: alias });
    const stale = await ready(staleLocal, cloud);
    expect(await stale.service.execute(request('sync', { ownerId: owner })))
      .toMatchObject({ ok: false, error: expect.stringContaining('同时修改') });
    expect(staleLocal.state[aliasKey]).toEqual(alias);

    // A deliberate later label write removes only the record tombstone.
    const secondWriter = createTocAliasWriteCoordinator(secondLocal.api, createSerialWriteQueue());
    expect(await secondWriter.commit({
      type: TOC_ALIAS_COMMIT_TYPE, action: 'update', routeKey: route,
      messageId: 'message-1', label: 'Restored heading', ownerId: owner,
    })).toMatchObject({ ok: true, record: { ownerId: owner } });
    expect(secondLocal.state[recordFenceKey]).toBeUndefined();
    expect((await second.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);
    remote = [...cloud.documents.values()][0].snapshot as {
      aliases: Record<string, unknown>; deletedAliases: string[]; deletedRoutes: string[];
    };
    expect(remote.aliases[route]).toEqual({
      ownerId: owner, aliases: { 'message-1': 'Restored heading' },
    });
    expect(remote.deletedAliases).toEqual([]);
    expect(remote.deletedRoutes).toEqual([]);
  });

  it('propagates owner-bound conversation deletion fences across devices', async () => {
    const cloud = firebaseHarness();
    const route = 'conversation-123';
    const aliasKey = TOC_ALIAS_PREFIX + route;
    const alias = { ownerId: owner, aliases: { 'message-1': 'Saved heading' } };
    const firstLocal = storage({ ...initialLocal(), [aliasKey]: alias });
    const first = await ready(firstLocal, cloud);
    expect((await first.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    const secondLocal = storage({ ...initialLocal(), [aliasKey]: alias });
    const second = await ready(secondLocal, cloud);
    expect((await second.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    const aliasWriter = createTocAliasWriteCoordinator(firstLocal.api, createSerialWriteQueue());
    expect(await aliasWriter.commit({
      type: TOC_ALIAS_COMMIT_TYPE, action: 'delete-conversation', routeKey: route, ownerId: owner,
    })).toEqual({ ok: true, deleted: true });
    expect(firstLocal.state[TOC_ALIAS_DELETED_PREFIX + route])
      .toMatchObject({ ownerId: owner });
    expect((await first.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    const remote = [...cloud.documents.values()][0].snapshot as {
      aliases: Record<string, unknown>; deletedRoutes: string[];
    };
    expect(remote.aliases).toEqual({});
    expect(remote.deletedRoutes).toEqual([route]);

    expect(await second.service.execute(request('sync', { ownerId: owner }))).toMatchObject({ ok: true });
    expect(secondLocal.state[aliasKey]).toBeUndefined();
    expect(secondLocal.state[TOC_ALIAS_DELETED_PREFIX + route])
      .toMatchObject({ ownerId: owner });

    const staleLocal = storage({ ...initialLocal(), [aliasKey]: alias });
    const stale = await ready(staleLocal, cloud);
    const blocked = await stale.service.execute(request('sync', { ownerId: owner }));
    expect(blocked).toMatchObject({ ok: false, error: expect.stringContaining('同时修改') });
    expect(staleLocal.state[aliasKey]).toEqual(alias);
    expect([...cloud.documents.values()][0].snapshot).toMatchObject({
      aliases: {}, deletedRoutes: [route],
    });
  });

  it('keeps an offline deletion through service-worker restart and syncs it after reconnect', async () => {
    const cloud = firebaseHarness();
    const local = storage(initialLocal());
    const first = await ready(local, cloud);
    expect((await first.service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    const writer = createPromptWriteCoordinator(local.api, createSerialWriteQueue());
    expect(await writer.commit({
      type: PROMPT_COMMIT_TYPE, action: 'replace-account', ownerId: owner,
      expected: [item], next: [],
    })).toEqual({ ok: true });
    const persistedTombstones = structuredClone(local.state[PROMPT_DELETED_STORAGE_KEY]);

    const onlineFetcher = cloud.fetcher.getMockImplementation()!;
    cloud.fetcher.mockImplementation(async () => { throw new Error('offline'); });
    expect(await first.service.execute(request('sync', { ownerId: owner })))
      .toEqual({ ok: false, error: 'offline' });
    expect(local.state[PROMPT_STORAGE_KEY]).toEqual([]);
    expect(local.state[PROMPT_DELETED_STORAGE_KEY]).toEqual(persistedTombstones);
    expect([...cloud.documents.values()][0].snapshot).toMatchObject({
      prompts: [item], deletedPrompts: [],
    });

    // Simulate a browser restart: session storage is new, while local deletion
    // fences and the acknowledged cloud baseline remain in chrome.storage.local.
    cloud.fetcher.mockImplementation(onlineFetcher);
    const restarted = await ready(local, cloud);
    expect(await restarted.service.execute(request('sync', { ownerId: owner })))
      .toMatchObject({ ok: true });
    expect([...cloud.documents.values()][0].snapshot).toMatchObject({
      prompts: [], deletedPrompts: ['tip-a'],
    });
    expect(local.state[PROMPT_DELETED_STORAGE_KEY]).toEqual({ [owner]: ['tip-a'] });
  });


  it('does not overwrite a remote edit when a local prompt deletion conflicts', async () => {
    const cloud = firebaseHarness();
    const local = storage(initialLocal());
    const { service } = await ready(local, cloud);
    expect((await service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    const writer = createPromptWriteCoordinator(local.api, createSerialWriteQueue());
    expect(await writer.commit({
      type: PROMPT_COMMIT_TYPE, action: 'replace-account', ownerId: owner,
      expected: [item], next: [],
    })).toEqual({ ok: true });

    const key = [...cloud.documents.keys()][0];
    const current = cloud.documents.get(key)!;
    const currentSnapshot = current.snapshot as { prompts: typeof item[]; [key: string]: unknown };
    const remoteEdit = { ...item, title: 'Edited on device two' };
    cloud.documents.set(key, {
      snapshot: { ...currentSnapshot, prompts: [remoteEdit] },
      updateTime: '2026-10-28T00:00:59Z',
    });
    const writesBefore = cloud.writes();
    const result = await service.execute(request('sync', { ownerId: owner }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('同时修改') });
    expect(local.state[PROMPT_STORAGE_KEY]).toEqual([]);
    expect(local.state[PROMPT_DELETED_STORAGE_KEY]).toEqual({ [owner]: ['tip-a'] });
    expect(cloud.writes()).toBe(writesBefore);
    expect(cloud.documents.get(key)?.snapshot).toMatchObject({ prompts: [remoteEdit] });
  });

  it('retries a stale Firestore updateTime and merges independent changes from two devices', async () => {
    const cloud = firebaseHarness();
    const local = storage(initialLocal());
    const { service } = await ready(local, cloud);
    expect((await service.execute(request('sync', { ownerId: owner }))).ok).toBe(true);

    const writer = createPromptWriteCoordinator(local.api, createSerialWriteQueue());
    const localAddition = { ...item, id: 'local-new', title: 'Local addition' };
    expect(await writer.commit({
      type: PROMPT_COMMIT_TYPE, action: 'replace-account', ownerId: owner,
      expected: [item], next: [item, localAddition],
    })).toEqual({ ok: true });

    const original = cloud.fetcher.getMockImplementation()!;
    let injected = false;
    cloud.fetcher.mockImplementation(async (url, options) => {
      if (!injected && String(url).endsWith('/documents:commit') && options?.method === 'POST') {
        injected = true;
        const key = [...cloud.documents.keys()].find((entry) => entry.includes('/accounts/'))!;
        const current = cloud.documents.get(key)!;
        const snapshot = current.snapshot as { prompts: typeof item[] };
        const remoteAddition = { ...item, id: 'remote-new', title: 'Remote addition' };
        cloud.documents.set(key, {
          snapshot: { ...snapshot, prompts: [...snapshot.prompts, remoteAddition] },
              updateTime: '2026-10-28T00:00:59Z',
        });
        return Response.json({
          error: { status: 'FAILED_PRECONDITION', message: 'FAILED_PRECONDITION' },
        }, { status: 412 });
      }
      return original(url, options);
    });

    expect(await service.execute(request('sync', { ownerId: owner }))).toMatchObject({ ok: true });
    expect(injected).toBe(true);
    const remote = [...cloud.documents.values()][0].snapshot as { prompts: typeof item[] };
    expect(remote.prompts.map((prompt) => prompt.id).sort())
      .toEqual(['local-new', 'remote-new', 'tip-a']);
    expect((local.state[PROMPT_STORAGE_KEY] as typeof item[]).map((prompt) => prompt.id).sort())
      .toEqual(['local-new', 'remote-new', 'tip-a']);
  });

  it('does not apply a cloud merge if an atomic commit precondition fails', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service } = await ready(local, remote);
    const before = structuredClone(local.state);
    const previous = remote.fetcher.getMockImplementation()!;
    remote.fetcher.mockImplementation(async (url, options) => {
      if (String(url).endsWith('/documents:commit') && options?.method === 'POST') {
        return Response.json({ error: { message: 'FAILED_PRECONDITION' } }, { status: 412 });
      }
      return previous(url, options);
    });
    const response = await service.execute(request('sync', { ownerId: owner }));
    expect(response).toMatchObject({ ok: false, error: expect.stringContaining('云端数据或写入配额在同步期间被其他设备更新') });
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
