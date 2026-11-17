/** Tests ChatGPT full-conversation API path recognition. */
import { describe, expect, it } from 'vitest';

import {
  getConversationIdFromApiPath,
  getConversationMessagesIdFromApiPath,
  isSupportedChatGptRequestUrl,
} from '@/platforms/chatgpt/conversationRequest';

describe('ChatGPT conversation request paths', () => {
  it.each([
    ['/backend-api/conversation/legacy-id', 'legacy-id'],
    ['/backend-api/conversations/current-id', 'current-id'],
    ['/backend-api/conversations/encoded%20id/', 'encoded id'],
  ])('recognizes a full conversation path: %s', (pathname, expectedId) => {
    expect(getConversationIdFromApiPath(pathname)).toBe(expectedId);
  });

  it.each([
    '/backend-api/conversations',
    '/backend-api/conversation/init',
    '/backend-api/conversation/example-id/textdocs',
    '/backend-api/conversations/example-id/attachments',
  ])('rejects a non-conversation-resource path: %s', (pathname) => {
    expect(getConversationIdFromApiPath(pathname)).toBeNull();
  });
});

describe('ChatGPT conversation messages paths', () => {
  it.each([
    ['/backend-api/conversations/current-id/messages', 'current-id'],
    ['/backend-api/conversation/legacy-id/messages/', 'legacy-id'],
    ['/backend-api/conversations/encoded%20id/messages', 'encoded id'],
  ])('recognizes a messages sub-path: %s', (pathname, expectedId) => {
    expect(getConversationMessagesIdFromApiPath(pathname)).toBe(expectedId);
  });

  it.each([
    '/backend-api/conversations/current-id',
    '/backend-api/conversations',
    '/backend-api/conversations/current-id/messages/textdocs',
    '/backend-api/conversations/init/messages',
  ])('rejects a non-messages-resource path: %s', (pathname) => {
    expect(getConversationMessagesIdFromApiPath(pathname)).toBeNull();
  });
});

describe('ChatGPT request origin validation', () => {
  it.each([
    ['/backend-api/conversations/current-id', 'https://chatgpt.com'],
    ['https://chatgpt.com/backend-api/conversations/current-id', 'https://chatgpt.com'],
    ['/backend-api/conversations/current-id', 'https://chat.openai.com'],
    ['https://chat.openai.com/backend-api/conversations/current-id', 'https://chat.openai.com'],
  ])('accepts same-origin ChatGPT requests: %s on %s', (requestUrl, pageOrigin) => {
    expect(isSupportedChatGptRequestUrl(requestUrl, pageOrigin)).toBe(true);
  });

  it.each([
    ['https://example.com/backend-api/conversations/current-id', 'https://chatgpt.com'],
    ['https://chatgpt.com.evil.example/backend-api/conversations/current-id', 'https://chatgpt.com'],
    ['//chat.openai.com/backend-api/conversations/current-id', 'https://chatgpt.com'],
    ['/backend-api/conversations/current-id', 'https://example.com'],
    ['/backend-api/conversations/current-id', 'http://chatgpt.com'],
  ])('rejects cross-origin or unsupported requests: %s on %s', (requestUrl, pageOrigin) => {
    expect(isSupportedChatGptRequestUrl(requestUrl, pageOrigin)).toBe(false);
  });
});
