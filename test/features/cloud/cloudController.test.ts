import { describe, expect, it, vi } from 'vitest';
import { createCloudController, CLOUD_CONFIG_KEY, CLOUD_MESSAGE_TYPE } from '@/features/cloud/cloudController';
import { createSerialWriteQueue } from '@/features/storage/serialWriteQueue';
import { PROMPT_STORAGE_KEY } from '@/features/myPrompts/promptWriteCoordinator';
import { ACCOUNT_SETTINGS_KEY } from '@/features/storage/accountSettings';

const owner = 'account-1';
const item = { id: 'tip-a', ownerId: owner, title: 'Saved', content: 'Private content',
  createdAt: 1, updatedAt: 2 };
const settings = { theme: { followChatGPT: true, manualTheme: 'dark' },
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
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('accounts:signInWithPassword')) return Response.json({
      idToken: 'id-token', refreshToken: 'refresh-token', localId: 'firebase-user', expiresIn: '3600',
    });
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
  return { documents, fetcher, writes: () => writes };
}
const initialLocal = () => ({ [PROMPT_STORAGE_KEY]: [item],
  [ACCOUNT_SETTINGS_KEY]: { [owner]: settings },
  'lunaToc:promptUsageV1': { 'tip-a': { usageCount: 5, lastUsedAt: 10 } },
});
async function ready(local: ReturnType<typeof storage>, cloud: ReturnType<typeof firebaseHarness>,
  verified = async () => true) {
  const sessions = storage();
  const service = createCloudController(local.api, sessions.api, createSerialWriteQueue(),
    verified, cloud.fetcher as unknown as typeof fetch);
  const config = await service.execute(request('configure', {
    config: { apiKey: 'AIzaSy-Test-api-key-public', projectId: 'lunatoc-demo' },
  }));
  expect(config.ok).toBe(true);
  const login = await service.execute(request('sign-in', {
    email: 'test@example.com', password: 'sixcharacters',
  }));
  expect(login).toMatchObject({ ok: true, uid: 'firebase-user' });
  return { service, sessions };
}
describe('Firebase REST account sync', () => {
  it('uploads only allowed account snapshot on explicit sync, never usage or auth secrets', async () => {
    const local = storage(initialLocal()), remote = firebaseHarness();
    const { service } = await ready(local, remote);
    expect(remote.writes()).toBe(0);
    expect(await service.execute(request('sync', { ownerId: owner }))).toMatchObject({ ok: true });
    expect(remote.writes()).toBe(1);
    const written = [...remote.documents.values()][0].snapshot as Record<string, unknown>;
    expect(written.prompts).toEqual([item]);
    expect(written).not.toHaveProperty('promptUsage');
    expect(JSON.stringify(written)).not.toContain('refresh-token');
    expect(local.state['lunaToc:promptUsageV1']).toEqual({ 'tip-a': { usageCount: 5, lastUsedAt: 10 } });
    expect(await service.execute(request('sync', { ownerId: owner }))).toMatchObject({ ok: true });
    expect(remote.writes()).toBe(1);
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
