/**
 * Tests that fetch URL rewriting is restricted to the active ChatGPT origin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { maybeBumpChatGptFetchNumTurns } from '@/platforms/chatgpt/chatGptFetchBumper';

const config = { paginationNumTurns: 80, initialLoadNumTurns: 100 };

describe('maybeBumpChatGptFetchNumTurns origin guard', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'https://chatgpt.com' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rewrites same-origin ChatGPT initial-load requests', () => {
    const args: Parameters<typeof fetch> = ['/backend-api/conversations/conversation-1'];
    const [rewritten] = maybeBumpChatGptFetchNumTurns(args, config);
    expect(new URL(rewritten as string).origin).toBe('https://chatgpt.com');
    expect(new URL(rewritten as string).searchParams.get('num_turns')).toBe('100');
  });

  it('rewrites same-origin ChatGPT pagination requests with the configured page size', () => {
    const args: Parameters<typeof fetch> = [
      '/backend-api/conversations/conversation-1/messages?before=message-1',
    ];
    const [rewritten] = maybeBumpChatGptFetchNumTurns(args, config);
    expect(new URL(rewritten as string).searchParams.get('before')).toBe('message-1');
    expect(new URL(rewritten as string).searchParams.get('num_turns')).toBe('80');
  });

  it('preserves same-origin Request objects while applying the existing rewrite', () => {
    const request = new Request(
      'https://chatgpt.com/backend-api/conversations/conversation-1',
      { headers: { 'x-lunatoc-test': 'preserved' } }
    );
    const args: Parameters<typeof fetch> = [request];
    const [rewritten] = maybeBumpChatGptFetchNumTurns(args, config);
    expect(rewritten).toBeInstanceOf(Request);
    expect((rewritten as Request).headers.get('x-lunatoc-test')).toBe('preserved');
    expect(new URL((rewritten as Request).url).searchParams.get('num_turns')).toBe('100');
  });

  it('does not rewrite a foreign URL with a matching ChatGPT API path', () => {
    const args: Parameters<typeof fetch> = [
      'https://example.com/backend-api/conversations/conversation-1',
    ];
    expect(maybeBumpChatGptFetchNumTurns(args, config)).toBe(args);
  });

  it('does not rewrite relative API paths when the current page is not ChatGPT', () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.com' } });
    const args: Parameters<typeof fetch> = ['/backend-api/conversations/conversation-1'];
    expect(maybeBumpChatGptFetchNumTurns(args, config)).toBe(args);
  });

  it('does not rewrite a Request object targeting another origin', () => {
    const args: Parameters<typeof fetch> = [
      new Request('https://example.com/backend-api/conversations/conversation-1'),
    ];
    expect(maybeBumpChatGptFetchNumTurns(args, config)).toBe(args);
  });
});
