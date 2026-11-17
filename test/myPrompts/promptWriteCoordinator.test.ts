/** @vitest-environment jsdom */
/** Tests the actual background writer ordering independently of a tab UI. */
import { describe, expect, it, vi } from 'vitest';
import {
  createPromptWriteCoordinator, PROMPT_COMMIT_TYPE, PROMPT_STORAGE_KEY, PROMPT_DELETED_STORAGE_KEY,
  type PromptCommitRequest,
} from '@/features/myPrompts/promptWriteCoordinator';
import type { SavedPrompt } from '@/features/myPrompts/promptStore';

const make = (id: string): SavedPrompt => ({
  id, ownerId: 'account-1', title: id, content: id, createdAt: 1, updatedAt: 1,
});
const request = (next: SavedPrompt[], expected: SavedPrompt[] = []): PromptCommitRequest =>
  ({ type: PROMPT_COMMIT_TYPE, action: 'replace-account', ownerId: 'account-1', expected, next });

function backing(initial: SavedPrompt[] = []) {
  const state: Record<string, unknown> = {
    [PROMPT_STORAGE_KEY]: initial.map((item) => ({ ...item })),
  };
  let rejectNext = false;
  const get = vi.fn(async (keys?: string | string[] | null) => {
    if (keys === undefined || keys === null) return structuredClone(state);
    const selected = typeof keys === 'string' ? [keys] : keys;
    return structuredClone(Object.fromEntries(selected.filter((key) => Object.hasOwn(state, key))
      .map((key) => [key, state[key]])));
  });
  const set = vi.fn(async (values: Record<string, unknown>) => {
    if (rejectNext) { rejectNext = false; throw new Error('quota exceeded'); }
    Object.assign(state, structuredClone(values));
  });
  const remove = vi.fn(async (keys: string | string[]) => {
    for (const key of typeof keys === 'string' ? [keys] : keys) delete state[key];
  });
  return {
    storage: { get, set, remove } as unknown as Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>,
    state,
    current: () => (state[PROMPT_STORAGE_KEY] as SavedPrompt[] ?? []),
    get, set, remove,
    failOnce: () => { rejectNext = true; },
  };
}

describe('background single-tab prompt writer', () => {
  it('writes validated replacements in order', async () => {
    const box = backing([make('initial')]);
    const writer = createPromptWriteCoordinator(box.storage);
    expect(await writer.commit(request([make('initial'), make('a')], [make('initial')]))).toEqual({ ok: true });
    expect(await writer.commit(request([make('initial'), make('a'), make('b')], [make('initial'), make('a')]))).toEqual({ ok: true });
    expect(box.current().map((p) => p.id)).toEqual(['initial', 'a', 'b']);
  });

  it('a restarted worker reads persisted storage', async () => {
    const box = backing([make('initial')]);
    await createPromptWriteCoordinator(box.storage).commit(request([make('first')], [make('initial')]));
    expect(await createPromptWriteCoordinator(box.storage).commit(request([make('second')], [make('first')])))
      .toEqual({ ok: true });
    expect(box.current()).toEqual([make('second')]);
  });

  it('rejects invalid data and duplicate IDs', async () => {
    const box = backing();
    const writer = createPromptWriteCoordinator(box.storage);
    expect(await writer.commit(request([make('same'), make('same')])))
      .toEqual({ ok: false, error: 'Invalid prompt update request' });
    expect(await writer.commit({ type: PROMPT_COMMIT_TYPE, next: [{ id: '__proto__' }] }))
      .toEqual({ ok: false, error: 'Invalid prompt update request' });
    expect(await writer.commit({ type: 'unknown', next: [] }))
      .toEqual({ ok: false, error: 'Invalid prompt update request' });
    expect(box.set).not.toHaveBeenCalled();
  });

  it('preserves prompts belonging to other accounts during account replacement', async () => {
    const other = { ...make('other'), ownerId: 'account-2' };
    const box = backing([make('initial'), other]);
    const writer = createPromptWriteCoordinator(box.storage);
    expect(await writer.commit(request([make('updated')], [make('initial')]))).toEqual({ ok: true });
    expect(box.current()).toEqual([other, make('updated')]);
    const collision = { ...make('other'), ownerId: 'account-1' };
    expect(await writer.commit(request([collision], [make('updated')]))).toEqual({
      ok: false, error: '提示词 ID 与其他账号的数据冲突，未保存。',
    });
    expect(box.current()).toEqual([other, make('updated')]);
  });

  it('protects malformed stored records from replacement', async () => {
    const get = vi.fn(async () => ({ [PROMPT_STORAGE_KEY]: 'unexpected' }));
    const set = vi.fn();
    const writer = createPromptWriteCoordinator({ get, set } as unknown as chrome.storage.StorageArea);
    expect(await writer.commit(request([make('fresh')])))
      .toEqual({ ok: false, error: 'Prompt storage contains invalid data; refusing to overwrite it' });
    expect(set).not.toHaveBeenCalled();
  });

  it('rejects malformed and ownerless stored data without rewriting it', async () => {
    const invalid = [{ id: 'unowned', title: 'Unowned', content: 'Private', createdAt: 1, updatedAt: 1 }];
    const get = vi.fn(async () => ({ [PROMPT_STORAGE_KEY]: invalid }));
    const set = vi.fn();
    const writer = createPromptWriteCoordinator({ get, set } as unknown as chrome.storage.StorageArea);
    expect(await writer.commit(request([make('saved')]))).toEqual({
      ok: false, error: 'Prompt storage contains invalid data; refusing to overwrite it',
    });
    expect(set).not.toHaveBeenCalled();
    expect(await writer.commit({ type: PROMPT_COMMIT_TYPE, action: 'cleanup-unowned' }))
      .toEqual({ ok: false, error: 'Invalid prompt update request' });
  });

  it('rejects unsafe account owners before writing data', async () => {
    const box = backing([make('original')]);
    const writer = createPromptWriteCoordinator(box.storage);
    for (const ownerId of ['__proto__', 'constructor', 'prototype', ' ', '']) {
      expect(await writer.commit({
        type: PROMPT_COMMIT_TYPE, action: 'clear-account', ownerId,
      })).toEqual({ ok: false, error: 'Invalid prompt update request' });
    }
    expect(box.current()).toEqual([make('original')]);
    expect(box.set).not.toHaveBeenCalled();
  });

  it('recovers from a failed storage write', async () => {
    const box = backing([make('original')]);
    const writer = createPromptWriteCoordinator(box.storage);
    box.failOnce();
    expect(await writer.commit(request([], [make('original')]))).toMatchObject({
      ok: false, error: expect.stringContaining('quota exceeded'),
    });
    expect(box.current()).toEqual([make('original')]);
    expect(await writer.commit(request([make('original'), make('new')], [make('original')]))).toEqual({ ok: true });
    expect(box.current().map((p) => p.id)).toEqual(['original', 'new']);
  });

  it('persists owner-scoped deletion fences and rejects stale re-adds', async () => {
    const box = backing([make('deleted')]);
    const writer = createPromptWriteCoordinator(box.storage);
    expect(await writer.commit(request([], [make('deleted')]))).toEqual({ ok: true });
    expect(box.current()).toEqual([]);
    expect(box.state[PROMPT_DELETED_STORAGE_KEY]).toEqual({ 'account-1': ['deleted'] });
    expect(await writer.commit(request([make('deleted')], []))).toEqual({
      ok: false, error: '该提示词 ID 已永久删除；请使用新的提示词 ID 创建副本。',
    });
    expect(box.current()).toEqual([]);
    expect(box.state[PROMPT_DELETED_STORAGE_KEY]).toEqual({ 'account-1': ['deleted'] });
  });

  it('records clear-all deletions and keeps other accounts tombstones isolated', async () => {
    const box = backing([make('one'), make('two')]);
    box.state[PROMPT_DELETED_STORAGE_KEY] = { 'account-2': ['other-deleted'] };
    const writer = createPromptWriteCoordinator(box.storage);
    expect(await writer.commit({
      type: PROMPT_COMMIT_TYPE, action: 'clear-account', ownerId: 'account-1',
      expected: [make('one'), make('two')],
    })).toEqual({ ok: true });
    expect(box.state[PROMPT_DELETED_STORAGE_KEY]).toEqual({
      'account-1': ['one', 'two'],
      'account-2': ['other-deleted'],
    });
  });

  it('does not reuse a prompt ID permanently deleted under another account', async () => {
    const box = backing([]);
    box.state[PROMPT_DELETED_STORAGE_KEY] = { 'account-2': ['foreign-deleted'] };
    const writer = createPromptWriteCoordinator(box.storage);
    const foreign = { ...make('foreign-deleted'), ownerId: 'account-1' };
    expect(await writer.commit({
      type: PROMPT_COMMIT_TYPE, action: 'replace-account', ownerId: 'account-1',
      expected: [], next: [foreign],
    })).toEqual({
      ok: false, error: '提示词 ID 已被另一个 ChatGPT 账号永久删除，未保存。',
    });
    expect(box.current()).toEqual([]);
    expect(box.state[PROMPT_DELETED_STORAGE_KEY]).toEqual({ 'account-2': ['foreign-deleted'] });
  });

  it('fails closed on malformed deletion markers without touching prompts', async () => {
    const box = backing([make('keep')]);
    box.state[PROMPT_DELETED_STORAGE_KEY] = { 'account-1': ['same', 'same'] };
    const before = structuredClone(box.state);
    const writer = createPromptWriteCoordinator(box.storage);
    expect(await writer.commit(request([], [make('keep')]))).toMatchObject({
      ok: false, error: expect.stringContaining('deletion markers contain invalid data'),
    });
    expect(box.state).toEqual(before);
  });

  it('retains the 20,000-entry per-account deletion cap and refuses overflow without deleting prompts', async () => {
    const retained = Array.from({ length: 20_000 }, (_, index) =>
      'p' + String(index).padStart(7, '0'));
    const box = backing([make('keep')]);
    box.state[PROMPT_DELETED_STORAGE_KEY] = { 'account-1': retained };
    const writer = createPromptWriteCoordinator(box.storage);

    expect(await writer.commit(request([make('keep')], [make('keep')]))).toEqual({ ok: true });
    expect(box.state[PROMPT_DELETED_STORAGE_KEY]).toEqual({ 'account-1': retained });
    expect(box.set).not.toHaveBeenCalled();

    expect(await writer.commit(request([], [make('keep')]))).toEqual({
      ok: false, error: '删除记录已达到安全上限；请先完成云同步后再继续删除。',
    });
    expect(box.current()).toEqual([make('keep')]);
    expect(box.state[PROMPT_DELETED_STORAGE_KEY]).toEqual({ 'account-1': retained });
    expect(box.set).not.toHaveBeenCalled();
  });

  it('refuses an already-over-limit persisted deletion map without rewriting prompt data', async () => {
    const retained = Array.from({ length: 20_001 }, (_, index) =>
      'p' + String(index).padStart(7, '0'));
    const box = backing([make('keep')]);
    box.state[PROMPT_DELETED_STORAGE_KEY] = { 'account-1': retained };
    const before = structuredClone(box.state);
    const writer = createPromptWriteCoordinator(box.storage);

    expect(await writer.commit(request([make('keep')], [make('keep')]))).toMatchObject({
      ok: false, error: expect.stringContaining('deletion markers contain invalid data'),
    });
    expect(box.state).toEqual(before);
    expect(box.set).not.toHaveBeenCalled();
  });

  it('avoids redundant storage writes for identical data', async () => {
    const box = backing([make('original')]);
    expect(await createPromptWriteCoordinator(box.storage).commit(request([make('original')], [make('original')])))
      .toEqual({ ok: true });
    expect(box.set).not.toHaveBeenCalled();
  });
  it('rejects stale tab writes instead of erasing another tab addition', async () => {
    const box = backing([make('initial')]);
    const writer = createPromptWriteCoordinator(box.storage);
    const expected = [make('initial')];
    expect(await writer.commit(request([...expected, make('new')], expected)))
      .toEqual({ ok: true });
    expect(await writer.commit(request([...expected, make('stale')], expected)))
      .toEqual({ ok: false, conflict: true });
    expect(box.current().map((prompt) => prompt.id)).toEqual(['initial', 'new']);
  });

  it('rejects stale clear when another tab has created a prompt', async () => {
    const box = backing([make('initial')]);
    const writer = createPromptWriteCoordinator(box.storage);
    expect(await writer.commit(request([make('initial'), make('new')], [make('initial')])))
      .toEqual({ ok: true });
    expect(await writer.commit({
      type: PROMPT_COMMIT_TYPE, action: 'clear-account', ownerId: 'account-1',
      expected: [make('initial')],
    })).toEqual({ ok: false, conflict: true });
    expect(box.current().map((prompt) => prompt.id)).toEqual(['initial', 'new']);
  });

});
