import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteDeletionObserver,
  detectDeletionTarget,
  type DeletionRequestDetails,
} from '@/background/remoteDeletionObserver';
import { TOC_TRUSTED_CONVERSATION_DELETED } from '@/navigation/lifecycle/protocol';

function body(value: unknown): { raw: Array<{ bytes: ArrayBuffer }> } {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { raw: [{ bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }] };
}
function request(overrides: Partial<DeletionRequestDetails> = {}): DeletionRequestDetails {
  return {
    requestId: 'request-1',
    url: 'https://chatgpt.com/backend-api/conversation/conversation-123',
    method: 'DELETE',
    tabId: 12,
    frameId: 0,
    type: 'xmlhttprequest',
    initiator: 'https://chatgpt.com',
    documentUrl: 'https://chatgpt.com/c/conversation-123',
    ...overrides,
  };
}

describe('trusted remote conversation deletion observer', () => {
  it('recognizes only same-origin top-frame DELETE and non-archive visibility removal', () => {
    expect(detectDeletionTarget(request())).toBe('conversation-123');
    expect(detectDeletionTarget(request({
      method: 'PATCH',
      requestBody: body({ is_visible: false }),
    }))).toBe('conversation-123');
    expect(detectDeletionTarget(request({
      method: 'PATCH',
      requestBody: body({ is_visible: false, is_archived: true }),
    }))).toBeNull();
    expect(detectDeletionTarget(request({
      method: 'PATCH', requestBody: body({ is_archived: true }),
    }))).toBeNull();
    expect(detectDeletionTarget(request({ method: 'POST' }))).toBeNull();
    expect(detectDeletionTarget(request({ initiator: 'https://evil.example' }))).toBeNull();
    expect(detectDeletionTarget(request({ url: 'https://evil.example/backend-api/conversation/conversation-123' }))).toBeNull();
    expect(detectDeletionTarget(request({ frameId: 2 }))).toBeNull();
    expect(detectDeletionTarget(request({ tabId: -1 }))).toBeNull();
    expect(detectDeletionTarget(request({ type: 'main_frame' }))).toBeNull();
    expect(detectDeletionTarget(request({ url: 'https://chatgpt.com/backend-api/conversation/local-12345678' }))).toBeNull();
  });

  it('notifies only after a matching browser request completes with 2xx', async () => {
    const send = vi.fn();
    const observer = createRemoteDeletionObserver(send, Date.now, async () => 'account-1');
    observer.onBeforeRequest(request());
    expect(observer.pendingCount()).toBe(1);
    await observer.onCompleted({ requestId: 'request-1', tabId: 12, statusCode: 204 });
    expect(send).toHaveBeenCalledWith(12, 'conversation-123', 'account-1');
    expect(observer.pendingCount()).toBe(0);
  });

  it('fails closed on non-2xx responses, cross-tab completion and network errors', async () => {
    const send = vi.fn();
    const observer = createRemoteDeletionObserver(send, Date.now, async () => 'account-1');
    observer.onBeforeRequest(request({ requestId: 'forbidden' }));
    await observer.onCompleted({ requestId: 'forbidden', tabId: 12, statusCode: 403 });
    observer.onBeforeRequest(request({ requestId: 'wrong-tab' }));
    await observer.onCompleted({ requestId: 'wrong-tab', tabId: 13, statusCode: 200 });
    observer.onBeforeRequest(request({ requestId: 'network-error' }));
    observer.onFailed({ requestId: 'network-error' });
    expect(send).not.toHaveBeenCalled();
    expect(observer.pendingCount()).toBe(0);
  });

  it('binds the completed deletion to the owner captured when the request began', async () => {
    let activeOwner = 'account-1';
    const send = vi.fn();
    const resolveOwner = vi.fn(async () => activeOwner);
    const observer = createRemoteDeletionObserver(send, Date.now, resolveOwner);
    observer.onBeforeRequest(request());
    activeOwner = 'account-2';
    await observer.onCompleted({ requestId: 'request-1', tabId: 12, statusCode: 204 });
    expect(resolveOwner).toHaveBeenCalledWith(12);
    expect(send).toHaveBeenCalledWith(12, 'conversation-123', 'account-1');
  });

  it('does not notify when the request-time ChatGPT owner cannot be verified', async () => {
    const send = vi.fn();
    const observer = createRemoteDeletionObserver(send, Date.now, async () => null);
    observer.onBeforeRequest(request());
    await observer.onCompleted({ requestId: 'request-1', tabId: 12, statusCode: 204 });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not retain pending requests beyond the TTL', () => {
    let time = 100;
    const observer = createRemoteDeletionObserver(vi.fn(), () => time, async () => 'account-1');
    observer.onBeforeRequest(request({ requestId: 'stale' }));
    time += 60_001;
    observer.onBeforeRequest(request({ requestId: 'fresh' }));
    expect(observer.pendingCount()).toBe(1);
    expect(TOC_TRUSTED_CONVERSATION_DELETED).toBe('LUNA_TOC_TRUSTED_CONVERSATION_DELETED_V1');
  });
});
