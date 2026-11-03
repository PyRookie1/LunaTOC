import { describe, expect, it } from 'vitest';
import {
  emptyCloudSnapshot, validateCloudSnapshot, mergeAccountSnapshots, CLOUD_MAX_BYTES,
  CLOUD_MAX_TOMBSTONES_PER_KIND,
  type CloudSnapshot,
} from '@/features/cloud/cloudSnapshot';

const owner = 'account-1';
const prompt = (id: string, content = id) => ({
  id, ownerId: owner, title: id, content, createdAt: 1, updatedAt: 2,
});
const snapshot = (prompts: ReturnType<typeof prompt>[] = []): CloudSnapshot =>
  ({ ...emptyCloudSnapshot(), prompts });
describe('cloud snapshots and three-way merge', () => {
  it('uses a versionless cloud snapshot shape and rejects version metadata', () => {
    expect(emptyCloudSnapshot()).toEqual({
      prompts: [], aliases: {}, settings: null, deletedRoutes: [], deletedAliases: [], deletedPrompts: [],
    });
    expect(() => validateCloudSnapshot({ ...snapshot(), version: 1 }, owner)).toThrow('字段');
    expect(() => validateCloudSnapshot({ ...snapshot(), schemaVersion: 1 }, owner)).toThrow('字段');
  });
  it('never accepts a foreign account, invalid alias or oversized payload', () => {
    expect(() => validateCloudSnapshot(snapshot([{ ...prompt('a'), ownerId: 'account-2' }]), owner)).toThrow('其他');
    expect(() => validateCloudSnapshot({
      ...snapshot(), aliases: { 'conversation-1': { ownerId: 'account-2', aliases: { msg: 'title' } } },
    }, owner)).toThrow('其他');
    expect(() => validateCloudSnapshot({ ...snapshot(), deletedRoutes: ['invalid'] }, owner)).toThrow();
    expect(CLOUD_MAX_BYTES).toBeLessThan(1_000_000);
  });
  it('enforces tombstone count and snapshot byte ceilings without pruning markers', () => {
    const ids = (prefix: string) => Array.from(
      { length: CLOUD_MAX_TOMBSTONES_PER_KIND },
      (_, index) => prefix + String(index).padStart(7, '0')
    );
    const routes = ids('r');
    const aliases = ids('a');
    const prompts = ids('p');

    expect(validateCloudSnapshot({ ...snapshot(), deletedRoutes: routes }, owner).deletedRoutes)
      .toHaveLength(CLOUD_MAX_TOMBSTONES_PER_KIND);
    expect(validateCloudSnapshot({ ...snapshot(), deletedAliases: aliases }, owner).deletedAliases)
      .toHaveLength(CLOUD_MAX_TOMBSTONES_PER_KIND);
    expect(validateCloudSnapshot({ ...snapshot(), deletedPrompts: prompts }, owner).deletedPrompts)
      .toHaveLength(CLOUD_MAX_TOMBSTONES_PER_KIND);

    expect(() => validateCloudSnapshot({
      ...snapshot(), deletedRoutes: [...routes, 'r9999999'],
    }, owner)).toThrow('删除标记无效');
    expect(() => validateCloudSnapshot({
      ...snapshot(), deletedAliases: [...aliases, 'a9999999'],
    }, owner)).toThrow('删除标记无效');
    expect(() => validateCloudSnapshot({
      ...snapshot(), deletedPrompts: [...prompts, 'p9999999'],
    }, owner)).toThrow('删除标记无效');

    // Per-kind limits are not permission to exceed Firestore's overall document budget.
    expect(() => validateCloudSnapshot({
      ...snapshot(), deletedRoutes: routes, deletedPrompts: prompts,
    }, owner)).toThrow('240 KB');
  });

  it('never compacts existing deletion markers during repeated no-op merges', () => {
    const base = {
      ...snapshot(),
      deletedRoutes: ['route123'],
      deletedAliases: ['alias123'],
      deletedPrompts: ['prompt123'],
    };
    const first = mergeAccountSnapshots(base, snapshot(), snapshot(), owner);
    const second = mergeAccountSnapshots(first, snapshot(), snapshot(), owner);
    expect(second.deletedRoutes).toEqual(['route123']);
    expect(second.deletedAliases).toEqual(['alias123']);
    expect(second.deletedPrompts).toEqual(['prompt123']);
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

  it('propagates last-alias deletion without deleting the conversation itself', () => {
    const route = 'conversation-123';
    const base = { ...snapshot(), aliases: {
      [route]: { ownerId: owner, aliases: { msg: 'saved label' } },
    } };
    const local = { ...snapshot(), deletedAliases: [route] };
    const merged = mergeAccountSnapshots(base, local, base, owner);
    expect(merged.aliases).toEqual({});
    expect(merged.deletedAliases).toEqual([route]);
    expect(merged.deletedRoutes).toEqual([]);
  });


  it('backfills legacy alias omission and never drops acknowledged conversation tombstones', () => {
    const route = 'conversation-123';
    const base = { ...snapshot(), aliases: {
      [route]: { ownerId: owner, aliases: { msg: 'saved' } },
    } };
    const oldRemote = snapshot();
    const merged = mergeAccountSnapshots(base, base, oldRemote, owner);
    expect(merged.aliases).toEqual({});
    expect(merged.deletedAliases).toEqual([route]);

    const conversationDeleted = { ...snapshot(), deletedRoutes: [route] };
    const legacyLocal = snapshot();
    const legacyRemote = snapshot();
    const preserved = mergeAccountSnapshots(conversationDeleted, legacyLocal, legacyRemote, owner);
    expect(preserved.deletedRoutes).toEqual([route]);
    expect(preserved.deletedAliases).toEqual([]);
  });

  it('blocks stale alias resurrection on a device without a baseline', () => {
    const route = 'conversation-123';
    const staleLocal = { ...snapshot(), aliases: {
      [route]: { ownerId: owner, aliases: { msg: 'stale label' } },
    } };
    const remote = { ...snapshot(), deletedAliases: [route] };
    expect(() => mergeAccountSnapshots(snapshot(), staleLocal, remote, owner))
      .toThrow('同时修改');
  });

  it('fails closed when one device removes the last alias while another edits it', () => {
    const route = 'conversation-123';
    const base = { ...snapshot(), aliases: {
      [route]: { ownerId: owner, aliases: { msg: 'before' } },
    } };
    const local = { ...snapshot(), deletedAliases: [route] };
    const remote = { ...snapshot(), aliases: {
      [route]: { ownerId: owner, aliases: { msg: 'remote edit' } },
    } };
    expect(() => mergeAccountSnapshots(base, local, remote, owner)).toThrow('同时修改');
  });

  it('allows explicit alias restoration and gives conversation deletion precedence', () => {
    const route = 'conversation-123';
    const alias = { ownerId: owner, aliases: { msg: 'restored' } };
    const base = { ...snapshot(), deletedAliases: [route] };
    const restored = { ...snapshot(), aliases: { [route]: alias } };
    expect(mergeAccountSnapshots(base, restored, base, owner).aliases).toEqual({ [route]: alias });

    const original = { ...snapshot(), aliases: { [route]: alias } };
    const localDelete = { ...snapshot(), deletedAliases: [route] };
    const remoteConversationDelete = { ...snapshot(), deletedRoutes: [route] };
    const merged = mergeAccountSnapshots(original, localDelete, remoteConversationDelete, owner);
    expect(merged.deletedRoutes).toEqual([route]);
    expect(merged.deletedAliases).toEqual([]);
    expect(merged.aliases).toEqual({});
  });

  it('accepts snapshots without the optional alias tombstone field', () => {
    const legacy = { ...snapshot(), deletedAliases: undefined } as unknown as CloudSnapshot;
    expect(validateCloudSnapshot(legacy, owner).deletedAliases).toEqual([]);
  });

  it('propagates durable prompt tombstones across devices', () => {
    const base = snapshot([prompt('deleted'), prompt('kept')]);
    const local = { ...snapshot([prompt('kept')]), deletedPrompts: ['deleted'] };
    const remote = base;
    const merged = mergeAccountSnapshots(base, local, remote, owner);
    expect(merged.prompts.map((item) => item.id)).toEqual(['kept']);
    expect(merged.deletedPrompts).toEqual(['deleted']);
  });

  it('does not resurrect a cloud-deleted prompt on a device without a baseline', () => {
    const staleLocal = snapshot([prompt('deleted')]);
    const remote = { ...snapshot(), deletedPrompts: ['deleted'] };
    expect(() => mergeAccountSnapshots(snapshot(), staleLocal, remote, owner))
      .toThrow('同时修改');
  });

  it('fails closed when one device deletes a prompt while another edits that same prompt', () => {
    const base = snapshot([prompt('same', 'before')]);
    const local = { ...snapshot(), deletedPrompts: ['same'] };
    const remote = snapshot([prompt('same', 'remote edit')]);
    expect(() => mergeAccountSnapshots(base, local, remote, owner)).toThrow('同时修改');
  });

  it('merges an offline deletion with an independent addition from another device', () => {
    const base = snapshot([prompt('delete-me')]);
    const local = { ...snapshot(), deletedPrompts: ['delete-me'] };
    const remote = snapshot([prompt('delete-me'), prompt('remote-new')]);
    const merged = mergeAccountSnapshots(base, local, remote, owner);
    expect(merged.prompts.map((item) => item.id)).toEqual(['remote-new']);
    expect(merged.deletedPrompts).toEqual(['delete-me']);
  });

  it('upgrades legacy omission-based prompt deletions to durable tombstones', () => {
    const base = snapshot([prompt('legacy-deleted')]);
    const legacyLocal = { ...snapshot() };
    const merged = mergeAccountSnapshots(base, legacyLocal, base, owner);
    expect(merged.deletedPrompts).toEqual(['legacy-deleted']);
  });

  it('accepts snapshots without the optional prompt tombstone field', () => {
    const legacy = { ...snapshot(), deletedPrompts: undefined } as unknown as CloudSnapshot;
    expect(validateCloudSnapshot(legacy, owner).deletedPrompts).toEqual([]);
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
