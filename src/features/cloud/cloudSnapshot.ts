/** Conservative account-scoped cloud snapshots. No ChatGPT message bodies are included. */
import type { SavedPrompt } from '@/features/myPrompts/promptStore';
import type { TocAliasRecord } from '@/features/conversationPrompts/tocAliasWriteCoordinator';
import type { AccountSettingsRecord } from '@/features/storage/accountSettings';
import { isValidAccountOwnerId } from '@/features/storage/accountSettings';
import { isPermanentConversationId } from '@/navigation/lifecycle/protocol';
import { BACKUP_FORMAT, BACKUP_VERSION, parseLocalBackup } from '@/features/backup/localBackup';

export const CLOUD_MAX_BYTES = 240_000;
export interface CloudSnapshot {
  version: 1;
  prompts: SavedPrompt[];
  aliases: Record<string, TocAliasRecord>;
  settings: AccountSettingsRecord | null;
  deletedRoutes: string[];
}
export function emptyCloudSnapshot(): CloudSnapshot {
  return { version: 1, prompts: [], aliases: {}, settings: null, deletedRoutes: [] };
}

export function validateCloudSnapshot(value: unknown, ownerId: string): CloudSnapshot {
  if (!isValidAccountOwnerId(ownerId) || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('云端账号或快照格式无效');
  }
  const raw = value as Record<string, unknown>;
  const deletedRoutes = raw.deletedRoutes;
  if (raw.version !== 1 ||
      Object.keys(raw).some((key) => !['version', 'prompts', 'aliases', 'settings', 'deletedRoutes'].includes(key)) ||
      !Array.isArray(deletedRoutes) || deletedRoutes.length > 20_000 ||
      deletedRoutes.some((route: unknown) => !isPermanentConversationId(route)) ||
      new Set(deletedRoutes).size !== deletedRoutes.length) {
    throw new Error('云端快照版本、字段或删除标记无效');
  }
  const parsed = parseLocalBackup(JSON.stringify({
    format: BACKUP_FORMAT, version: BACKUP_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    data: {
      prompts: raw.prompts, promptUsage: {}, aliases: raw.aliases,
      settings: raw.settings === null ? {} : { [ownerId]: raw.settings },
    },
  }));
  if (parsed.data.prompts.some((item) => item.ownerId !== ownerId) ||
      Object.values(parsed.data.aliases).some((item) => item.ownerId !== ownerId) ||
      Object.keys(parsed.data.aliases).some((route) => deletedRoutes.includes(route))) {
    throw new Error('云端数据包含其他 ChatGPT 账号或冲突的删除标记');
  }
  const snapshot: CloudSnapshot = {
    version: 1,
    prompts: parsed.data.prompts,
    aliases: parsed.data.aliases,
    settings: raw.settings === null ? null : parsed.data.settings[ownerId],
    deletedRoutes: [...deletedRoutes].sort(),
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
  const toMap = (items: SavedPrompt[]) => Object.fromEntries(items.map((item) => [item.id, item]));
  const prompts = Object.values(mergeKeys(toMap(before.prompts), toMap(here.prompts), toMap(there.prompts), '提示词'));
  const aliasKeys = (snapshot: CloudSnapshot) => {
    const map: Record<string, TocAliasRecord | { deleted: true }> = { ...snapshot.aliases };
    for (const route of snapshot.deletedRoutes) map[route] = { deleted: true };
    return map;
  };
  const mergedAliases = mergeKeys(aliasKeys(before), aliasKeys(here), aliasKeys(there), '目录别名');
  const aliases: Record<string, TocAliasRecord> = {};
  const deletedRoutes: string[] = [];
  for (const [route, value] of Object.entries(mergedAliases)) {
    if ('deleted' in value) deletedRoutes.push(route);
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
      theme: { followChatGPT: true, manualTheme: 'dark' },
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
    version: 1, prompts: prompts.sort((x, y) => x.id.localeCompare(y.id)),
    aliases, settings: settingsValue, deletedRoutes,
  }, ownerId);
}
