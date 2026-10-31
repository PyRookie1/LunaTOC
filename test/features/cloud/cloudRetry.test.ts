import { describe, expect, it } from 'vitest';
import {
  cloudRetryDelayMs, parseCloudRetryState, isTransientCloudError,
} from '@/features/cloud/cloudRetry';

describe('MV3 automatic cloud-sync recovery policy', () => {
  it('uses bounded exponential backoff after network failures', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 12].map(cloudRetryDelayMs))
      .toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]);
  });
  it('accepts only persisted valid retry markers', () => {
    expect(parseCloudRetryState({ pending: true, attempt: 2, nextRetryAt: 123 }))
      .toEqual({ pending: true, attempt: 2, nextRetryAt: 123 });
    for (const bad of [null, {}, { pending: false, attempt: 1, nextRetryAt: 1 },
      { pending: true, attempt: -1, nextRetryAt: 1 },
      { pending: true, attempt: 1, nextRetryAt: Number.NaN }]) {
      expect(parseCloudRetryState(bad)).toBeNull();
    }
  });
  it('retries temporary network/quota failures, not access or conflict errors', () => {
    for (const message of ['fetch failed', 'offline', 'Firebase 请求失败：HTTP 503',
      'Firebase 请求失败：RESOURCE_EXHAUSTED', 'Firebase 请求失败：HTTP 429',
      'Firebase 网络请求超时（20 秒），本轮操作已停止']) {
      expect(isTransientCloudError(message)).toBe(true);
    }
    for (const message of ['PERMISSION_DENIED', 'ChatGPT 账号已切换',
      '云端与本地同时修改了提示词', '同步文档意外缺失']) {
      expect(isTransientCloudError(message)).toBe(false);
    }
  });
});
