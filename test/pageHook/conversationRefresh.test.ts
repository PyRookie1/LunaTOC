/**
 * @vitest-environment jsdom
 * Verifies on-demand refresh for project conversations and incomplete responses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installConversationRefresh } from '@/pageHook/conversationRefresh';
import { TOC_REFRESH_REQUEST, TOC_REFRESH_RESULT } from '@/navigation/refresh/refreshProtocol';
import { getActivePlatform } from '@/platforms';

describe('conversation refresh on sidebar opening', () => {
  const originalPath = location.pathname;
  const hookListeners: EventListenerOrEventListenerObject[] = [];

  function installHook(originalFetch: typeof fetch): ReturnType<typeof installConversationRefresh> {
    const spy = vi.spyOn(window, 'addEventListener');
    const observeHeaders = installConversationRefresh(originalFetch, getActivePlatform('chatgpt.com'));
    for (const [type, listener] of spy.mock.calls) {
      if (type === 'message') hookListeners.push(listener);
    }
    spy.mockRestore();
    return observeHeaders;
  }

  afterEach(() => {
    history.replaceState(null, '', originalPath);
    for (const listener of hookListeners.splice(0)) {
      window.removeEventListener('message', listener);
    }
    vi.restoreAllMocks();
  });

  it('refreshes a project conversation using captured headers, and rejects incomplete fallback data', async () => {
    const routeKey = 'project-conversation-123';
    history.replaceState(null, '', `/g/g-p-workspace/c/${routeKey}`);

    const user = {
      id: 'user-1',
      author: { role: 'user' },
      content: { parts: ['Current question'] },
      create_time: 1,
    };
    const reply = {
      id: 'reply-1',
      author: { role: 'assistant' },
      content: { parts: ['Current answer'] },
      create_time: 2,
    };

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: 'reply-1',
          mapping: {
            'user-1': { parent: null, message: user },
            'reply-1': { parent: 'user-1', message: reply },
          },
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [user],
          page_info: { has_previous_page: true },
        }),
      });

    const observeHeaders = installHook(mockFetch as unknown as typeof fetch);
    observeHeaders(routeKey, { authorization: 'Bearer captured-token' });

    const received: Array<{ type?: string; requestId?: number; payload?: unknown }> = [];
    const onResult = (event: MessageEvent) => {
      if (event.data?.type === TOC_REFRESH_RESULT) received.push(event.data);
    };
    window.addEventListener('message', onResult);

    try {
      const request = (requestId: number) => {
        window.dispatchEvent(new MessageEvent('message', {
          source: window,
          origin: location.origin,
          data: { type: TOC_REFRESH_REQUEST, routeKey, requestId },
        }));
      };

      request(1);
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0].payload).toMatchObject({
        messages: [user, reply],
        current_node: 'reply-1',
        activeBranchVerified: true,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/backend-api/conversation/${routeKey}`),
        expect.objectContaining({
          credentials: 'include',
          headers: { authorization: 'Bearer captured-token' },
        })
      );

      request(2);
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(received[1].payload).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener('message', onResult);
    }
  });
  it('filters inactive flat branches with parent links across complete pagination', async () => {
    const routeKey = 'flat-parent-conversation-123';
    history.replaceState(null, '', `/c/${routeKey}`);
    const user = (id: string, parent: string | null) => ({
      id, parent, author: { role: 'user' }, content: { parts: [id] },
    });
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        current_node: 'edited',
        messages: [user('old-edit', 'root'), user('edited', 'root')],
        page_info: { has_previous_page: true, start_cursor: 'older' },
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        messages: [user('root', null)],
        page_info: { has_previous_page: false },
      }) });
    installHook(mockFetch as unknown as typeof fetch);
    const received: Array<{ type?: string; payload?: unknown }> = [];
    const onResult = (event: MessageEvent) => {
      if (event.data?.type === TOC_REFRESH_RESULT) received.push(event.data);
    };
    window.addEventListener('message', onResult);
    try {
      window.dispatchEvent(new MessageEvent('message', {
        source: window, origin: location.origin,
        data: { type: TOC_REFRESH_REQUEST, routeKey, requestId: 100 },
      }));
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0].payload).toMatchObject({
        activeBranchVerified: true,
        messages: [{ id: 'root' }, { id: 'edited' }],
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener('message', onResult);
    }
  });

  it('reports uncertainty instead of confirming a flat response without parents', async () => {
    const routeKey = 'unlinked-conversation-123';
    history.replaceState(null, '', `/c/${routeKey}`);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        current_node: 'edited',
        messages: [
          { id: 'old', author: { role: 'user' } },
          { id: 'edited', author: { role: 'user' } },
        ],
        page_info: { has_previous_page: false },
      }) });
    installHook(mockFetch as unknown as typeof fetch);
    const received: Array<{ type?: string; payload?: unknown }> = [];
    const onResult = (event: MessageEvent) => {
      if (event.data?.type === TOC_REFRESH_RESULT) received.push(event.data);
    };
    window.addEventListener('message', onResult);
    try {
      window.dispatchEvent(new MessageEvent('message', {
        source: window, origin: location.origin,
        data: { type: TOC_REFRESH_REQUEST, routeKey, requestId: 101 },
      }));
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0].payload).toBeNull();
    } finally {
      window.removeEventListener('message', onResult);
    }
  });

  it('isolates capture requests from an earlier navigator refresh and cancels only their own waiter', async () => {
    const routeKey = 'isolated-capture-conversation';
    history.replaceState(null, '', `/c/${routeKey}`);
    const pending: Array<{ resolve: (value: unknown) => void; signal: AbortSignal }> = [];
    const mockFetch = vi.fn((_url: string, options: RequestInit) => new Promise(resolve => {
      pending.push({ resolve, signal: options.signal as AbortSignal });
    }));
    installHook(mockFetch as unknown as typeof fetch);
    const received: Array<{ requestId?: number }> = [];
    const onResult = (event: MessageEvent) => {
      if (event.data?.type === TOC_REFRESH_RESULT) received.push(event.data);
    };
    window.addEventListener('message', onResult);
    try {
      for (const data of [
        { type: TOC_REFRESH_REQUEST, routeKey, requestId: 200 },
        { type: TOC_REFRESH_REQUEST, routeKey, requestId: 201, purpose: 'capture' },
      ]) window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin, data }));
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin,
        data: { type: 'LUNA_TOC_REFRESH_CANCEL', routeKey, requestId: 201, purpose: 'capture' } }));
      expect(pending[1].signal.aborted).toBe(true);
      expect(pending[0].signal.aborted).toBe(false);
      const tree = { current_node: 'root', mapping: { root: { parent: null,
        message: { id: 'root', author: { role: 'user' }, content: { parts: ['hello'] } } } } };
      pending[0].resolve({ ok: true, json: async () => tree });
      pending[1].resolve({ ok: true, json: async () => tree });
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0].requestId).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cache: 'no-store' }));
    } finally { window.removeEventListener('message', onResult); }
  });

  it('phase 0: exposes the mixed-revision risk when an older page changes during pagination', async () => {
    const routeKey = 'mixed-revision-conversation';
    history.replaceState(null, '', `/c/${routeKey}`);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        current_node: 'reply',
        messages: [{ id: 'reply', parent: 'question', author: { role: 'assistant' },
          content: { parts: ['Answer from version A'] } }],
        page_info: { has_previous_page: true, start_cursor: 'older' },
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        // The same ancestor is edited between the two independent requests.
        messages: [{ id: 'question', parent: null, author: { role: 'user' },
          content: { parts: ['Question from version B'] } }],
        page_info: { has_previous_page: false },
      }) });
    installHook(mockFetch as unknown as typeof fetch);
    const received: Array<{ type?: string; payload?: { activeBranchVerified?: boolean;
      messages?: Array<{ content?: { parts?: string[] } }> } }> = [];
    const onResult = (event: MessageEvent) => {
      if (event.data?.type === TOC_REFRESH_RESULT) received.push(event.data);
    };
    window.addEventListener('message', onResult);
    try {
      window.dispatchEvent(new MessageEvent('message', {
        source: window, origin: location.origin,
        data: { type: TOC_REFRESH_REQUEST, routeKey, requestId: 102 },
      }));
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0].payload?.activeBranchVerified).toBe(true);
      expect(received[0].payload?.messages?.map((message) => message.content?.parts?.[0]))
        .toEqual(['Question from version B', 'Answer from version A']);
    } finally {
      window.removeEventListener('message', onResult);
    }
  });

});
