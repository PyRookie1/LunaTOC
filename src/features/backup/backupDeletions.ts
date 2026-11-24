/** Durable deletion state belongs in portable backups; authentication state does not. */
import {
  PROMPT_DELETED_STORAGE_KEY,
  parsePromptDeletionMap,
} from '@/features/myPrompts/promptWriteCoordinator';
import {
  TOC_ALIAS_DELETED_PREFIX,
  TOC_ALIAS_RECORD_DELETED_PREFIX,
  parseTocAliasDeletionFence,
  type TocAliasDeletionFence,
} from '@/features/conversationPrompts/tocAliasWriteCoordinator';
import { isPermanentConversationId } from '@/navigation/lifecycle/protocol';

export interface BackupDeletions {
  prompts: Record<string, string[]>;
  conversations: Record<string, TocAliasDeletionFence | true>;
  aliases: Record<string, TocAliasDeletionFence>;
}
export const emptyBackupDeletions = (): BackupDeletions => ({
  prompts: {},
  conversations: {},
  aliases: {},
});

export function validateBackupDeletions(value: unknown): BackupDeletions {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('备份删除标记格式无效。');
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== 3 ||
    !['prompts', 'conversations', 'aliases'].every((k) => Object.hasOwn(raw, k))
  ) {
    throw new Error('备份删除标记字段无效。');
  }
  function routes(input: unknown, legacy: boolean): Record<string, TocAliasDeletionFence | true> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('会话删除标记无效。');
    const entries = Object.entries(input);
    if (entries.length > 20_000) throw new Error('会话删除标记超过安全上限。');
    return Object.fromEntries(
      entries.map(([route, fence]) => {
        if (!isPermanentConversationId(route) || (!legacy && fence === true))
          throw new Error('会话删除标记无效。');
        const parsed = fence === true ? true : parseTocAliasDeletionFence(fence);
        if (!parsed) throw new Error('会话删除标记缺失。');
        return [route, parsed];
      }),
    );
  }
  const prompts = parsePromptDeletionMap(raw.prompts);
  const owners = new Map<string, string>();
  for (const [owner, ids] of Object.entries(prompts))
    for (const id of ids) {
      if (owners.has(id) && owners.get(id) !== owner)
        throw new Error('提示词删除标记的账号归属冲突。');
      owners.set(id, owner);
    }
  const conversations = routes(raw.conversations, true);
  const aliases = routes(raw.aliases, false) as Record<string, TocAliasDeletionFence>;
  for (const [route, fence] of Object.entries(aliases)) {
    const permanent = Object.hasOwn(conversations, route) ? conversations[route] : undefined;
    if (permanent && permanent !== true && permanent.ownerId !== fence.ownerId)
      throw new Error('会话删除标记的账号归属冲突。');
  }
  return { prompts, conversations, aliases };
}

export function readBackupDeletions(storage: Record<string, unknown>): BackupDeletions {
  return validateBackupDeletions({
    prompts: storage[PROMPT_DELETED_STORAGE_KEY] ?? {},
    conversations: Object.fromEntries(
      Object.entries(storage)
        .filter(([k]) => k.startsWith(TOC_ALIAS_DELETED_PREFIX))
        .map(([k, v]) => [k.slice(TOC_ALIAS_DELETED_PREFIX.length), v]),
    ),
    aliases: Object.fromEntries(
      Object.entries(storage)
        .filter(([k]) => k.startsWith(TOC_ALIAS_RECORD_DELETED_PREFIX))
        .map(([k, v]) => [k.slice(TOC_ALIAS_RECORD_DELETED_PREFIX.length), v]),
    ),
  });
}

export function mergeBackupDeletions(
  local: BackupDeletions,
  imported: BackupDeletions,
): BackupDeletions {
  const prompts = Object.assign(Object.create(null), local.prompts) as Record<string, string[]>;
  for (const [owner, ids] of Object.entries(imported.prompts))
    prompts[owner] = [...new Set([...(prompts[owner] ?? []), ...ids])].sort();
  const conversations = Object.assign(Object.create(null), local.conversations) as BackupDeletions['conversations'];
  const aliases = Object.assign(Object.create(null), local.aliases) as BackupDeletions['aliases'];
  for (const [target, incoming] of [
    [conversations, imported.conversations],
    [aliases, imported.aliases],
  ] as const) {
    for (const [route, fence] of Object.entries(incoming)) {
      const previous = Object.hasOwn(target, route) ? target[route] : undefined;
      if (previous && previous !== true && fence !== true && previous.ownerId !== fence.ownerId) {
        throw new Error('备份删除标记与本地账号归属冲突。');
      }
      // A legacy global conversation fence remains conservative until ownership is known.
      if (previous !== true)
        (target as Record<string, TocAliasDeletionFence | true>)[route] = fence;
    }
  }
  return validateBackupDeletions({ prompts, conversations, aliases });
}

export function deletionStorageValues(state: BackupDeletions): Record<string, unknown> {
  return Object.fromEntries([
    [PROMPT_DELETED_STORAGE_KEY, state.prompts],
    ...Object.entries(state.conversations).map(([route, fence]) => [
      TOC_ALIAS_DELETED_PREFIX + route,
      fence,
    ]),
    ...Object.entries(state.aliases).map(([route, fence]) => [
      TOC_ALIAS_RECORD_DELETED_PREFIX + route,
      fence,
    ]),
  ]);
}
