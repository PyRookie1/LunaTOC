/**
 * Tests that content capture ignores requests outside the active ChatGPT origin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inspectFetchRequest } from '@/platforms/chatgpt/contentCapture';

describe('inspectFetchRequest origin guard', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'https://chatgpt.com' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('classifies a same-origin ChatGPT conversation request', () => {
    const args: Parameters<typeof fetch> = [
      '/backend-api/conversations/conversation-1',
    ];
    expect(inspectFetchRequest(args, 'fallback-route')).toMatchObject({
      isConversationGet: true,
      isInitialConversationLoad: true,
      isSendMessage: false,
      routeKey: 'conversation-1',
    });
  });

  it('ignores a foreign URL with the same conversation API path', () => {
    const args: Parameters<typeof fetch> = [
      'https://example.com/backend-api/conversations/conversation-1',
    ];
    expect(inspectFetchRequest(args, 'fallback-route')).toBeNull();
  });

  it('ignores relative API paths when running on a non-ChatGPT page', () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.com' } });
    const args: Parameters<typeof fetch> = [
      '/backend-api/conversations/conversation-1',
    ];
    expect(inspectFetchRequest(args, 'fallback-route')).toBeNull();
  });

  it('still identifies ChatGPT send-message requests on the active origin', () => {
    const args: Parameters<typeof fetch> = [
      '/backend-api/f/conversation',
      { method: 'POST' },
    ];
    expect(inspectFetchRequest(args, 'fallback-route')).toMatchObject({
      isConversationGet: false,
      isInitialConversationLoad: false,
      isSendMessage: true,
    });
  });
});
