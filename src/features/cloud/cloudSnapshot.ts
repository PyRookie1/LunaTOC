/** Conservative account-scoped cloud snapshots. No ChatGPT message bodies are included. */
import type { SavedPrompt } from '@/features/myPrompts/promptStore';
import type { TocAliasRecord } from '@/features/conversationPrompts/tocAliasWriteCoordinator';
import type { AccountSettingsRecord } from '@/features/storage/accountSettings';
import { isValidAccountOwnerId } from '@/features/storage/accountSettings';
import { isPermanentConversationId } from '@/navigation/lifecycle/protocol';
import { BACKUP_FORMAT, BACKUP_VERSION, parseLocalBackup } from '@/features/backup/localBackup';

export const CLOUD_MAX_BYTES = 240_000;
/** Hard ceiling, not a cleanup threshold: the current sync protocol has no per-device acknowledgement registry. */
export const CLOUD_MAX_TOMBSTONES_PER_KIND = 20_000;
export interface CloudSnapshot {
  prompts: SavedPrompt[];
  aliases: Record<string, TocAliasRecord>;
  settings: AccountSettingsRecord | null;
  deletedRoutes: string[];
  deletedAliases: string[];
  deletedPrompts: string[];
}
export function emptyCloudSnapshot(): CloudSnapshot {
  return { prompts: [], aliases: {}, settings: null, deletedRoutes: [], deletedAliases: [], deletedPrompts: [] };
}

export function validateCloudSnapshot(value: unknown, ownerId: string): CloudSnapshot {
  if (!isValidAccountOwnerId(ownerId) || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('云端账号或快照格式无效');
  }
  const raw = value as Record<string, unknown>;
  const deletedRoutes = raw.deletedRoutes;
  const deletedPrompts = raw.deletedPrompts === undefined ? [] : raw.deletedPrompts;
  const deletedAliases = raw.deletedAliases === undefined ? [] : raw.deletedAliases;
  if (Object.keys(raw).some((key) => !['prompts', 'aliases', 'settings', 'deletedRoutes', 'deletedAliases', 'deletedPrompts'].includes(key)) ||
      !Array.isArray(deletedRoutes) || deletedRoutes.length > CLOUD_MAX_TOMBSTONES_PER_KIND ||
      deletedRoutes.some((route: unknown) => !isPermanentConversationId(route)) ||
      new Set(deletedRoutes).size !== deletedRoutes.length ||
      !Array.isArray(deletedAliases) || deletedAliases.length > CLOUD_MAX_TOMBSTONES_PER_KIND ||
      deletedAliases.some((route: unknown) => !isPermanentConversationId(route)) ||
      new Set(deletedAliases).size !== deletedAliases.length ||
      deletedAliases.some((route: unknown) => deletedRoutes.includes(route)) ||
      !Array.isArray(deletedPrompts) || deletedPrompts.length > CLOUD_MAX_TOMBSTONES_PER_KIND ||
      deletedPrompts.some((id: unknown) => typeof id !== 'string' || !id || id.length > 256) ||
      new Set(deletedPrompts).size !== deletedPrompts.length) {
    throw new Error('云端快照字段或删除标记无效');
  }
  const parsed = parseLocalBackup(JSON.stringify({
    format: BACKUP_FORMAT, version: BACKUP_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    data: {
      prompts: raw.prompts, promptUsage: {}, aliases: raw.aliases,
      settings: raw.settings === null ? {} : { [ownerId]: raw.settings },
    },
  }));
  if (parsed.data.prompts.some((item) => item.ownerId !== ownerId || deletedPrompts.includes(item.id)) ||
      Object.values(parsed.data.aliases).some((item) => item.ownerId !== ownerId) ||
      Object.keys(parsed.data.aliases).some((route) => deletedRoutes.includes(route) || deletedAliases.includes(route))) {
    throw new Error('云端数据包含其他 ChatGPT 账号或冲突的删除标记');
  }
  const snapshot: CloudSnapshot = {
    prompts: parsed.data.prompts,
    aliases: parsed.data.aliases,
    settings: raw.settings === null ? null : parsed.data.settings[ownerId],
    deletedRoutes: [...deletedRoutes].sort(),
    deletedAliases: [...deletedAliases].sort(),
    deletedPrompts: [...deletedPrompts].sort(),
  };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > CLOUD_MAX_BYTES) {
    throw new Error('云端数据超过 240 KB 安全上限；请先精简提示词或目录别名');
  }
  return snapshot;
}

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const map = value as Record<string, unknown>;
  return '{' + Object.keys(map).sort().map((key) =>
    JSON.stringify(key) + ':' + canonical(map[key])).join(',') + '}';
}
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);

/** Item-level three-way reconciliation: changed-vs-changed conflicts fail closed.
 * Omission relative to an acknowledged baseline is a deletion, not an empty value.
 */
export function mergeAccountSnapshots(
  base: CloudSnapshot, local: CloudSnapshot, remote: CloudSnapshot, ownerId: string
): CloudSnapshot {
  const before = validateCloudSnapshot(base, ownerId);
  const here = validateCloudSnapshot(local, ownerId);
  const there = validateCloudSnapshot(remote, ownerId);
  function mergeKeys<T>(b: Record<string, T>, l: Record<string, T>, r: Record<string, T>, label: string) {
    const result: Record<string, T> = Object.create(null) as Record<string, T>;
    const keys = new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)]);
    for (const key of keys) {
      const original = b[key], ours = l[key], theirs = r[key];
      const localChanged = !same(ours, original), remoteChanged = !same(theirs, original);
      if (localChanged && remoteChanged && !same(ours, theirs)) {
        throw new Error('云端与本地同时修改了' + label + '「' + key + '」，已停止同步；请先备份并手动解决冲突');
      }
      const chosen = localChanged ? ours : theirs;
      if (chosen !== undefined) result[key] = chosen;
    }
    return result;
  }
  type PromptValue = SavedPrompt | { deleted: true };
  const promptKeys = (snapshot: CloudSnapshot): Record<string, PromptValue> => {
    const map: Record<string, PromptValue> = Object.create(null) as Record<string, PromptValue>;
    for (const item of snapshot.prompts) map[item.id] = item;
    for (const id of snapshot.deletedPrompts) map[id] = { deleted: true };
    return map;
  };
  const basePromptMap = promptKeys(before);
  const localPromptMap = promptKeys(here);
  const remotePromptMap = promptKeys(there);
  // Older snapshots represented deletion by omission. Normalize omissions against
  // the acknowledged baseline into durable tombstones before merging.
  for (const id of new Set([...Object.keys(basePromptMap), ...before.deletedPrompts])) {
    if (!Object.hasOwn(localPromptMap, id)) localPromptMap[id] = { deleted: true };
    if (!Object.hasOwn(remotePromptMap, id)) remotePromptMap[id] = { deleted: true };
  }
  const mergedPromptMap = mergeKeys(basePromptMap, localPromptMap, remotePromptMap, '提示词');
  const prompts: SavedPrompt[] = [];
  const deletedPrompts: string[] = [];
  for (const [id, value] of Object.entries(mergedPromptMap)) {
    if ('deleted' in value) deletedPrompts.push(id);
    else prompts.push(value);
  }
  const aliasKeys = (snapshot: CloudSnapshot) => {
    const map: Record<string, TocAliasRecord | { deleted: true }> =
      Object.assign(Object.create(null), snapshot.aliases);
    for (const route of [...snapshot.deletedAliases, ...snapshot.deletedRoutes]) {
      map[route] = { deleted: true };
    }
    return map;
  };
  const baseAliasMap = aliasKeys(before);
  const localAliasMap = aliasKeys(here);
  const remoteAliasMap = aliasKeys(there);
  // Old builds represented removal of the last label by omitting the record.
  // Normalize omissions against the acknowledged baseline to a durable record
  // tombstone so a stale device with no baseline cannot resurrect that alias.
  for (const route of Object.keys(baseAliasMap)) {
    if (!Object.hasOwn(localAliasMap, route)) localAliasMap[route] = { deleted: true };
    if (!Object.hasOwn(remoteAliasMap, route)) remoteAliasMap[route] = { deleted: true };
  }
  const mergedAliases = mergeKeys(baseAliasMap, localAliasMap, remoteAliasMap, '目录别名');
  const routeDeletionKeys = (snapshot: CloudSnapshot) => Object.fromEntries(
    snapshot.deletedRoutes.map((route) => [route, { deleted: true as const }])
  );
  const baseRouteDeletionMap = routeDeletionKeys(before);
  const localRouteDeletionMap = routeDeletionKeys(here);
  const remoteRouteDeletionMap = routeDeletionKeys(there);
  // Conversation deletions are permanent. A missing legacy marker cannot
  // clear an acknowledged conversation deletion during normal sync.
  for (const route of before.deletedRoutes) {
    if (!Object.hasOwn(localRouteDeletionMap, route)) localRouteDeletionMap[route] = { deleted: true };
    if (!Object.hasOwn(remoteRouteDeletionMap, route)) remoteRouteDeletionMap[route] = { deleted: true };
  }
  const mergedRouteDeletions = mergeKeys(
    baseRouteDeletionMap, localRouteDeletionMap, remoteRouteDeletionMap, '会话删除'
  );
  const deletedRoutes = Object.keys(mergedRouteDeletions).sort();
  const routeDeletionSet = new Set(deletedRoutes);
  const aliases: Record<string, TocAliasRecord> = Object.create(null) as Record<string, TocAliasRecord>;
  const deletedAliases: string[] = [];
  for (const [route, value] of Object.entries(mergedAliases)) {
    if (routeDeletionSet.has(route)) continue;
    if ('deleted' in value) deletedAliases.push(route);
    else aliases[route] = value;
  }
  // Reconcile independent setting fields, while rejecting delete-versus-edit conflicts.
  function mergeSettings(): AccountSettingsRecord | null {
    if (here.settings === null || there.settings === null) {
      return mergeKeys(
        { settings: before.settings }, { settings: here.settings },
        { settings: there.settings }, '账号偏好'
      ).settings ?? null;
    }
    const defaults: AccountSettingsRecord = {
      theme: { followChatGPT: false, manualTheme: 'light' },
      sidebar: { layoutMode: 'overlay', backgroundColor: 'default', revealTint: false },
    };
    const original = before.settings ?? defaults;
    function fields<T extends object>(base: T, local: T, remote: T, label: string): T {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(local) as Array<keyof T & string>) {
        const previous = base[key], ours = local[key], theirs = remote[key];
        const localChanged = !same(ours, previous), remoteChanged = !same(theirs, previous);
        if (localChanged && remoteChanged && !same(ours, theirs)) {
          throw new Error('云端与本地同时修改了' + label + '「' + key + '」，已停止同步');
        }
        result[key] = localChanged ? ours : theirs;
      }
      return result as T;
    }
    return {
      theme: fields(original.theme, here.settings.theme, there.settings.theme, '主题设置'),
      sidebar: fields(original.sidebar, here.settings.sidebar, there.settings.sidebar, '侧边栏设置'),
    };
  }
  const settingsValue = mergeSettings();
  return validateCloudSnapshot({
    prompts: prompts.sort((x, y) => x.id.localeCompare(y.id)),
    aliases, settings: settingsValue, deletedRoutes, deletedAliases, deletedPrompts,
  }, ownerId);
}
