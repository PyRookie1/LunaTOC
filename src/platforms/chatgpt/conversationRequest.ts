/** Identifies ChatGPT full-conversation API requests across supported paths. */


const SUPPORTED_CHATGPT_ORIGINS = new Set([
  'https://chatgpt.com',
  'https://chat.openai.com',
]);

/**
 * Accept only requests made to the current supported ChatGPT page origin.
 * Relative URLs are resolved against the page origin; cross-origin requests
 * and requests from unrelated host pages are never classified as ChatGPT API calls.
 */
export function isSupportedChatGptRequestUrl(
  requestUrl: string,
  pageOrigin: string
): boolean {
  try {
    const page = new URL(pageOrigin);
    if (!SUPPORTED_CHATGPT_ORIGINS.has(page.origin)) return false;
    const request = new URL(requestUrl, page);
    return request.origin === page.origin;
  } catch {
    return false;
  }
}

const FULL_CONVERSATION_PATH_PATTERN =
  /^\/backend-api\/conversations?\/([^/]+)\/?$/;

const FULL_CONVERSATION_MESSAGES_PATH_PATTERN =
  /^\/backend-api\/conversations?\/([^/]+)\/messages\/?$/;

/**
 * Returns the conversation ID for a full-conversation API path.
 * Subresources such as `/textdocs` are intentionally excluded.
 *
 * @example
 * getConversationIdFromApiPath('/backend-api/conversations/example-id');
 */
export function getConversationIdFromApiPath(
  pathname: string
): string | null {
  const match = pathname.match(FULL_CONVERSATION_PATH_PATTERN);
  const conversationId = match ? decodeURIComponent(match[1]) : null;

  return conversationId === 'init' ? null : conversationId;
}

/**
 * Returns the conversation ID for a paginated messages sub-resource path.
 * The `/messages` suffix marks an older-page request, which ChatGPT issues when
 * scrolling back through history; it returns the same `messages` payload shape.
 *
 * @example
 * getConversationMessagesIdFromApiPath(
 *   '/backend-api/conversations/example-id/messages'
 * );
 */
export function getConversationMessagesIdFromApiPath(
  pathname: string
): string | null {
  const match = pathname.match(FULL_CONVERSATION_MESSAGES_PATH_PATTERN);
  const conversationId = match ? decodeURIComponent(match[1]) : null;

  return conversationId === 'init' ? null : conversationId;
}
