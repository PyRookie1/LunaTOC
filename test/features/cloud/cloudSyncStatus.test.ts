import { describe, expect, it } from 'vitest';
import {
  completedCloudSyncStatus, pendingCloudSyncStatus,
  CLOUD_WAITING_FOR_OWNER_MESSAGE,
} from '@/features/cloud/cloudSyncStatus';

describe('automatic cloud synchronization status', () => {
  it('never reports success when no bound ChatGPT tab can be verified', () => {
    expect(completedCloudSyncStatus(0, [], 123)).toEqual({
      state: 'pending',
      message: CLOUD_WAITING_FOR_OWNER_MESSAGE,
      updatedAt: 123,
    });
  });

  it('marks new local edits pending instead of reusing an old success', () => {
    expect(pendingCloudSyncStatus('等待上传', 456)).toEqual({
      state: 'pending', message: '等待上传', updatedAt: 456,
    });
  });

  it('reports success only after one or more verified accounts actually sync', () => {
    expect(completedCloudSyncStatus(1, [], 789)).toEqual({
      state: 'success',
      message: '已完成所有已验证 ChatGPT 账号的同步',
      updatedAt: 789,
    });
  });

  it('does not call partial failures successful even with other synced accounts', () => {
    expect(completedCloudSyncStatus(2, ['网络失败'], 200)).toEqual({
      state: 'error', message: '网络失败', updatedAt: 200,
    });
  });
});
