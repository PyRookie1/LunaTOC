import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationStore } from '@/navigation/state/conversationStore';
import { extractUserMessages } from '@/features/conversationPrompts/message';
import { createCloudController, CLOUD_MESSAGE_TYPE } from '@/features/cloud/cloudController';
import { createSerialWriteQueue } from '@/features/storage/serialWriteQueue';
import { isTransientCloudError } from '@/features/cloud/cloudRetry';
import { createLocalBackup, restoreLocalBackup } from '@/features/backup/localBackup';
import {
  PROMPT_STORAGE_KEY,
  PROMPT_DELETED_STORAGE_KEY,
} from '@/features/myPrompts/promptWriteCoordinator';
import {
  TOC_ALIAS_DELETED_PREFIX,
  TOC_ALIAS_RECORD_DELETED_PREFIX,
} from '@/features/conversationPrompts/tocAliasWriteCoordinator';
import { ACCOUNT_SETTINGS_KEY } from '@/features/storage/accountSettings';
import { setActiveConversationOwner } from '@/navigation/lifecycle/conversationOwner';
import { subscribeThemeSettings } from '@/features/theme/themeSettings';
import { subscribeSidebarPreferences } from '@/features/sidebar/sidebarPreferences';

const authKey = 'lunatoc:cloud:auth:session:v1';
const user = (id: string, time = 1) => ({
  id,
  author: { role: 'user' },
  content: { parts: [id] },
  create_time: time,
});
const assistant = (id: string, time = 2) => ({
  id,
  author: { role: 'assistant' },
  content: { parts: [id] },
  create_time: time,
});
const defaults = {
  theme: { followChatGPT: false, manualTheme: 'light' },
  sidebar: { layoutMode: 'overlay', backgroundColor: 'default', revealTint: false },
};
const cfg = {
  projectId: 'luna-test-project',
  apiKey: 'abcdefghijklmnop',
  authDomain: 'luna-test-project.firebaseapp.com',
};
function storage(initial: Record<string, unknown> = {}) {
  const state = structuredClone(initial);
  const api = {
    async get(keys?: string | string[] | null) {
      return structuredClone(
        keys == null
          ? state
          : Object.fromEntries(
              (typeof keys === 'string' ? [keys] : keys)
                .filter((k) => Object.hasOwn(state, k))
                .map((k) => [k, state[k]]),
            ),
      );
    },
    async set(values: Record<string, unknown>) {
      Object.assign(state, structuredClone(values));
    },
    async remove(keys: string | string[]) {
      for (const k of typeof keys === 'string' ? [keys] : keys) delete state[k];
    },
    async getBytesInUse() {
      return 0;
    },
  };
  return { state, api: api as unknown as chrome.storage.StorageArea };
}
const command = (action: string, rest: Record<string, unknown> = {}) => ({
  type: CLOUD_MESSAGE_TYPE,
  action,
  ...rest,
});
afterEach(() => {
  setActiveConversationOwner(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Review regressions: assertions describe required behavior', () => {
  it('rejects verification results that finish after sign-out even when token refresh already completed', async () => {
    const local = storage(),
      sessions = storage({
        [authKey]: {
          idToken: 'old',
          refreshToken: 'old-refresh',
          uid: 'uid-A',
          expiresAt: 0,
          emailVerified: true,
          email: 'a@example.com',
        },
      });
    let release!: (r: Response) => void, entered!: () => void;
    const waiting = new Promise<void>((r) => (entered = r));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('securetoken'))
        return Response.json({
          id_token: 'renewed',
          refresh_token: 'renewed-refresh',
          user_id: 'uid-A',
          expires_in: '3600',
        });
      entered();
      return new Promise<Response>((r) => (release = r));
    });
    const service = createCloudController(
      local.api,
      sessions.api,
      createSerialWriteQueue(),
      async () => true,
      fetcher as typeof fetch,
      cfg,
    );
    const verification = service.execute(command('check-verification'));
    await waiting;
    await service.execute(command('sign-out'));
    release(
      Response.json({ users: [{ localId: 'uid-A', emailVerified: true, email: 'a@example.com' }] }),
    );
    expect(await verification).toMatchObject({ ok: false, code: 'auth' });
    expect(((await service.execute(command('status'))) as { uid?: string }).uid).toBeUndefined();
  });
  it('R1 retains verified messages after leaving and revisiting a conversation', () => {
    let route = 'conversation-A';
    const s = createConversationStore({ getCurrentRouteKey: () => route });
    s.setCurrentConversationKey(route);
    const data = { activeBranchVerified: true as const, messages: [user('u1'), assistant('a1')] };
    s.replaceWithFreshSnapshot(data, route);
    route = 'conversation-B';
    s.syncRouteState();
    s.resetForCurrentRoute();
    route = 'conversation-A';
    const t = s.syncRouteState();
    s.resetForCurrentRoute({ nextMessages: t.cachedMessages });
    expect(s.getMessages().map((m) => m.id)).toEqual(['u1']);
    s.handleConversationData(data, route, Date.now() + 1000);
    expect(s.getMessages().map((m) => m.id)).toEqual(['u1']);
  });
  it('R2 does not migrate an unsaved new-chat prompt into an existing conversation', () => {
    let route = 'existing-conversation';
    const s = createConversationStore({ getCurrentRouteKey: () => route });
    s.setCurrentConversationKey(route);
    s.handleConversationData({ messages: [user('existing'), assistant('answer')] });
    route = 'new-chat:/';
    s.syncRouteState();
    s.resetForCurrentRoute();
    s.handleNewUserMessage(user('unsaved'), route);
    route = 'existing-conversation';
    const t = s.syncRouteState();
    s.resetForCurrentRoute({
      nextMessages: t.cachedMessages,
      preserveMessages: t.shouldPreserveMessages,
    });
    expect(s.getMessages().map((m) => m.id)).toEqual(['existing']);
  });
  it('R3 retains distinct consecutive user messages in a verified parent chain', () => {
    expect(
      extractUserMessages({
        messages: [
          { ...user('u1'), parent: null },
          { ...user('u2', 2), parent: 'u1' },
          assistant('a2', 3),
        ],
      }).map((m) => m.id),
    ).toEqual(['u1', 'u2']);
  });
  it('R4 cannot restore Firebase login after sign-out while token refresh is pending', async () => {
    const local = storage();
    const session = storage({
      [authKey]: {
        idToken: 'old',
        refreshToken: 'old-refresh',
        uid: 'uid-A',
        expiresAt: 0,
        emailVerified: true,
        email: 'a@example.com',
      },
    });
    let release!: (r: Response) => void;
    let started!: () => void;
    const pending = new Promise<void>((r) => (started = r));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('securetoken')) {
        started();
        return new Promise<Response>((r) => (release = r));
      }
      return Response.json({
        users: [{ localId: 'uid-A', emailVerified: true, email: 'a@example.com' }],
      });
    });
    const c = createCloudController(
      local.api,
      session.api,
      createSerialWriteQueue(),
      async () => true,
      fetcher as typeof fetch,
      cfg,
    );
    const refresh = c.execute(command('check-verification'));
    await pending;
    expect((await c.execute(command('sign-out'))).ok).toBe(true);
    release(
      Response.json({
        id_token: 'renewed',
        refresh_token: 'renewed-refresh',
        user_id: 'uid-A',
        expires_in: '3600',
      }),
    );
    await refresh;
    expect(((await c.execute(command('status'))) as { uid?: string }).uid).toBeUndefined();
  });
  it('R5 retries the controller own translated network and contention errors', () => {
    expect
      .soft(
        isTransientCloudError(
          '无法连接 Firebase（firestore.googleapis.com）：网络请求失败。请检查 Chrome 网络/代理、DNS、防火墙及拦截扩展，并确认 Firebase API 可访问；云同步未开启。',
        ),
      )
      .toBe(true);
    expect
      .soft(
        isTransientCloudError(
          '云端数据或写入配额在同步期间被其他设备更新，已保留本地数据；请重试同步',
        ),
      )
      .toBe(true);
  });
  it('R6 preserves unsynced deletion knowledge when backing up to a new profile', async () => {
    const route = 'conversation-123';
    const source = storage({
      [PROMPT_STORAGE_KEY]: [],
      [PROMPT_DELETED_STORAGE_KEY]: { 'owner-A': ['deleted-tip'] },
      [TOC_ALIAS_DELETED_PREFIX + route]: { ownerId: 'owner-A', deletedAt: 1 },
      [TOC_ALIAS_RECORD_DELETED_PREFIX + 'conversation-456']: { ownerId: 'owner-A', deletedAt: 1 },
    });
    const b = await createLocalBackup(source.api);
    const target = storage();
    await restoreLocalBackup(b, 'replace', target.api);
    expect.soft(target.state[PROMPT_DELETED_STORAGE_KEY]).toEqual({ 'owner-A': ['deleted-tip'] });
    expect
      .soft(target.state[TOC_ALIAS_DELETED_PREFIX + route])
      .toEqual({ ownerId: 'owner-A', deletedAt: 1 });
    expect
      .soft(target.state[TOC_ALIAS_RECORD_DELETED_PREFIX + 'conversation-456'])
      .toEqual({ ownerId: 'owner-A', deletedAt: 1 });
  });
  it('R7 ignores a delayed theme read after owner invalidation', async () => {
    setActiveConversationOwner(null);
    const callbacks: Array<(x: Record<string, unknown>) => void> = [];
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: () => new Promise((r) => callbacks.push(r)) },
        onChanged: { addListener() {}, removeListener() {} },
      },
    });
    setActiveConversationOwner('owner-A');
    const seen: string[] = [];
    const stop = subscribeThemeSettings((x) => seen.push(x.manualTheme));
    setActiveConversationOwner(null);
    setActiveConversationOwner('owner-A');
    setActiveConversationOwner(null);
    callbacks.at(-1)!({
      [ACCOUNT_SETTINGS_KEY]: {
        'owner-A': { ...defaults, theme: { followChatGPT: false, manualTheme: 'dark' } },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    stop();
    expect(seen.at(-1)).toBe('light');
  });
  it('R8 ignores a delayed layout read after owner invalidation', async () => {
    setActiveConversationOwner(null);
    const callbacks: Array<(x: Record<string, unknown>) => void> = [];
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: () => new Promise((r) => callbacks.push(r)) },
        onChanged: { addListener() {}, removeListener() {} },
      },
    });
    setActiveConversationOwner('owner-A');
    const seen: string[] = [];
    const stop = subscribeSidebarPreferences((x) => seen.push(x.layoutMode));
    setActiveConversationOwner(null);
    setActiveConversationOwner('owner-A');
    setActiveConversationOwner(null);
    callbacks.at(-1)!({
      [ACCOUNT_SETTINGS_KEY]: {
        'owner-A': { ...defaults, sidebar: { ...defaults.sidebar, layoutMode: 'side-by-side' } },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    stop();
    expect(seen.at(-1)).toBe('overlay');
  });
  it('R9 receives assistant metadata for a normally appended prompt after verification', () => {
    const route = 'conversation-A';
    const s = createConversationStore({ getCurrentRouteKey: () => route });
    s.setCurrentConversationKey(route);
    s.replaceWithFreshSnapshot(
      { activeBranchVerified: true, messages: [user('u1'), assistant('a1')] },
      route,
    );
    s.handleNewUserMessage(user('u2', 3), route);
    s.handleConversationData(
      { messages: [user('u2', 3), assistant('a2', 4)] },
      route,
      Date.now() + 1000,
    );
    expect(s.getMessages().find((m) => m.id === 'u2')?.answerId).toBe('a2');
  });
});
