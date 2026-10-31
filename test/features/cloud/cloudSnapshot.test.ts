import { describe, expect, it } from 'vitest';
import {
  emptyCloudSnapshot, validateCloudSnapshot, mergeAccountSnapshots, CLOUD_MAX_BYTES,
  type CloudSnapshot,
} from '@/features/cloud/cloudSnapshot';

const owner = 'account-1';
const prompt = (id: string, content = id) => ({
  id, ownerId: owner, title: id, content, createdAt: 1, updatedAt: 2,
});
const snapshot = (prompts: ReturnType<typeof prompt>[] = []): CloudSnapshot =>
  ({ ...emptyCloudSnapshot(), prompts });
describe('cloud snapshots and three-way merge', () => {
  it('never accepts a foreign account, invalid alias or oversized payload', () => {
    expect(() => validateCloudSnapshot(snapshot([{ ...prompt('a'), ownerId: 'account-2' }]), owner)).toThrow('其他');
    expect(() => validateCloudSnapshot({
      ...snapshot(), aliases: { 'conversation-1': { ownerId: 'account-2', aliases: { msg: 'title' } } },
    }, owner)).toThrow('其他');
    expect(() => validateCloudSnapshot({ ...snapshot(), deletedRoutes: ['invalid'] }, owner)).toThrow();
    expect(CLOUD_MAX_BYTES).toBeLessThan(1_000_000);
  });
  it('merges independent edits from different devices and retains both', () => {
    const b = snapshot([prompt('common')]);
    const a = snapshot([prompt('common'), prompt('local')]);
    const r = snapshot([prompt('common'), prompt('remote')]);
    expect(mergeAccountSnapshots(b, a, r, owner).prompts.map((p) => p.id))
      .toEqual(['common', 'local', 'remote']);
  });
  it('propagates deletions and fails closed on simultaneous conflicting edits', () => {
    const b = snapshot([prompt('common')]);
    expect(mergeAccountSnapshots(b, snapshot(), b, owner).prompts).toEqual([]);
    expect(mergeAccountSnapshots(b, b, snapshot(), owner).prompts).toEqual([]);
    expect(() => mergeAccountSnapshots(b, snapshot([prompt('common', 'left')]),
      snapshot([prompt('common', 'right')]), owner)).toThrow('同时修改');
  });
  it('propagates durable conversation deletion fences without resurrection', () => {
    const b = { ...snapshot(), aliases: {
      'conversation-123': { ownerId: owner, aliases: { msg: 'saved' } },
    } };
    const local = { ...snapshot(), deletedRoutes: ['conversation-123'] };
    const merged = mergeAccountSnapshots(b, local, b, owner);
    expect(merged.deletedRoutes).toEqual(['conversation-123']);
    expect(merged.aliases).toEqual({});
  });
  it('merges independent theme and sidebar fields from two devices', () => {
    const baseSettings = {
      theme: { followChatGPT: false, manualTheme: 'dark' as const },
      sidebar: { layoutMode: 'overlay' as const, backgroundColor: 'default' as const, revealTint: false },
    };
    const base = { ...snapshot(), settings: baseSettings };
    const local = { ...snapshot(), settings: {
      ...baseSettings, theme: { ...baseSettings.theme, manualTheme: 'light' as const },
    } };
    const remote = { ...snapshot(), settings: {
      ...baseSettings, sidebar: { ...baseSettings.sidebar, revealTint: true },
    } };
    const merged = mergeAccountSnapshots(base, local, remote, owner);
    expect(merged.settings?.theme.manualTheme).toBe('light');
    expect(merged.settings?.sidebar.revealTint).toBe(true);
  });

  it('rejects concurrent divergent edits to the same settings field', () => {
    const base = { ...snapshot(), settings: {
      theme: { followChatGPT: false, manualTheme: 'dark' as const },
      sidebar: { layoutMode: 'overlay' as const, backgroundColor: 'default' as const, revealTint: false },
    } };
    const local = { ...snapshot(), settings: {
      ...base.settings, sidebar: { ...base.settings.sidebar, backgroundColor: 'blue' as const },
    } };
    const remote = { ...snapshot(), settings: {
      ...base.settings, sidebar: { ...base.settings.sidebar, backgroundColor: 'green' as const },
    } };
    expect(() => mergeAccountSnapshots(base, local, remote, owner)).toThrow('同时修改');
  });

  it('preserves remote custom preferences when local defaults are unchanged', () => {
    const base = { ...snapshot(), settings: null };
    const local = { ...snapshot(), settings: {
      theme: { followChatGPT: false, manualTheme: 'light' as const },
      sidebar: { layoutMode: 'overlay' as const, backgroundColor: 'default' as const, revealTint: false },
    } };
    const remote = { ...snapshot(), settings: {
      theme: { followChatGPT: false, manualTheme: 'dark' as const },
      sidebar: { layoutMode: 'overlay' as const, backgroundColor: 'default' as const, revealTint: true },
    } };
    const merged = mergeAccountSnapshots(base, local, remote, owner);
    expect(merged.settings).toEqual(remote.settings);
  });

  it('refuses diverging edits to the same directory record or settings object', () => {
    const b = snapshot();
    const left = { ...snapshot(), aliases: {
      'conversation-123': { ownerId: owner, aliases: { msg: 'left' } },
    } };
    const right = { ...snapshot(), aliases: {
      'conversation-123': { ownerId: owner, aliases: { msg: 'right' } },
    } };
    expect(() => mergeAccountSnapshots(b, left, right, owner)).toThrow('同时修改');
  });
});
