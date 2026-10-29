/** Persisted work marker and bounded retry policy for MV3 automatic sync. */
export const CLOUD_RETRY_STATE_KEY = 'lunatoc:cloud:retry:v1';
export const CLOUD_RETRY_ALARM = 'lunatoc-cloud-retry-v1';
export const CLOUD_POLL_ALARM = 'lunatoc-cloud-poll-v1';
export const CLOUD_POLL_MINUTES = 60;

export interface CloudRetryState {
  pending: true;
  attempt: number;
  nextRetryAt: number;
}

/** 1, 2, 4, 8, 16, 32, then at most 60 minutes; bounded across worker restarts. */
export function cloudRetryDelayMs(attempt: number): number {
  const bounded = Number.isSafeInteger(attempt) ? Math.max(0, Math.min(attempt, 6)) : 0;
  return Math.min(3_600_000, 60_000 * (2 ** bounded));
}

export function parseCloudRetryState(value: unknown): CloudRetryState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return raw.pending === true && typeof raw.attempt === 'number' &&
    Number.isSafeInteger(raw.attempt) && raw.attempt >= 0 && raw.attempt <= 100 &&
    typeof raw.nextRetryAt === 'number' && Number.isFinite(raw.nextRetryAt) &&
    raw.nextRetryAt >= 0
    ? { pending: true, attempt: raw.attempt, nextRetryAt: raw.nextRetryAt } : null;
}

/** Authentication, validation and data conflicts require intervention, not infinite retry. */
export function isTransientCloudError(message: string): boolean {
  return /network|failed to fetch|fetch failed|offline|timed? ?out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|TOO_MANY_REQUESTS|HTTP\s*(?:408|429|5\d\d)\b/i.test(message);
}
