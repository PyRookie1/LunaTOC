/** Shared automatic-sync status decisions: only completed uploads are successes. */
import type { CloudAutoSyncStatus } from './cloudController';

export const CLOUD_WAITING_FOR_OWNER_MESSAGE =
  '等待已登录且已绑定的 ChatGPT 页面；尚未进行本轮云同步';

export function pendingCloudSyncStatus(
  message = '本地数据有更改，等待完成云同步',
  updatedAt = Date.now(),
): CloudAutoSyncStatus {
  return { state: 'pending', message, updatedAt };
}

/** A successful no-op with zero verified owners is NOT a completed sync. */
export function completedCloudSyncStatus(
  ownerCount: number,
  errors: string[],
  updatedAt = Date.now(),
): CloudAutoSyncStatus {
  if (errors.length > 0) {
    return { state: 'error', message: errors[0], updatedAt };
  }
  if (ownerCount === 0) {
    return pendingCloudSyncStatus(CLOUD_WAITING_FOR_OWNER_MESSAGE, updatedAt);
  }
  return {
    state: 'success',
    message: '已完成所有已验证 ChatGPT 账号的同步',
    updatedAt,
  };
}
