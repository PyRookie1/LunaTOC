/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectPhase0Report } from '@/features/feasibility/phase0Probe';
import { dispatchTrustedPageHookMessage } from '@/navigation/pageHookMessageTransport';
import { TOC_REFRESH_REQUEST, TOC_REFRESH_RESULT } from '@/navigation/refresh/refreshProtocol';

describe('one-shot feasibility report', () => {
  const originalPath = location.pathname;

  afterEach(() => {
    document.body.replaceChildren();
    history.replaceState(null, '', originalPath);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the complete current branch without including private content or conversation identity', async () => {
    history.replaceState(null, '', '/c/private-conversation-123');
    document.body.innerHTML = '<div class="thread-scroll-container"><div data-message-id="secret-id"><img src="/picture.png"></div></div>';
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.1.2' }) } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, blob: async () => new Blob(['image-bytes'], { type: 'image/png' }),
    }));
    vi.spyOn(window, 'postMessage').mockImplementation((message) => {
      const request = message as { type?: string; routeKey?: string; requestId?: number };
      if (request.type !== TOC_REFRESH_REQUEST) return;
      queueMicrotask(() => dispatchTrustedPageHookMessage({
        type: TOC_REFRESH_RESULT, routeKey: request.routeKey, requestId: request.requestId,
        payload: { activeBranchVerified: true, current_node: 'secret-id',
          page_info: { has_previous_page: false }, messages: [
            { id: 'secret-id', author: { role: 'user' }, content: { parts: ['PRIVATE BODY'] },
              metadata: { attachments: [{ name: 'PRIVATE FILE.pdf' }] } },
            { id: 'answer-id', author: { role: 'assistant' }, content: { parts: ['PRIVATE ANSWER'] } },
          ] },
      }));
    });
    const report = await collectPhase0Report();
    expect(report).toContain('当前对话完整读取：通过');
    expect(report).toContain('已核对的有效分支消息：2 条');
    expect(report).toContain('当前图片可读取');
    expect(report).not.toMatch(/PRIVATE|secret-id|private-conversation-123|picture\.png/);
  });

  it('fails closed when the page hook cannot prove a complete branch', async () => {
    history.replaceState(null, '', '/c/private-conversation-123');
    document.body.innerHTML = '<div class="thread-scroll-container"></div>';
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.1.2' }) } });
    vi.spyOn(window, 'postMessage').mockImplementation((message) => {
      const request = message as { type?: string; routeKey?: string; requestId?: number };
      if (request.type !== TOC_REFRESH_REQUEST) return;
      queueMicrotask(() => dispatchTrustedPageHookMessage({
        type: TOC_REFRESH_RESULT, routeKey: request.routeKey, requestId: request.requestId,
        payload: { activeBranchVerified: true, messages: [{ id: 'partial' }],
          page_info: { has_previous_page: true } },
      }));
    });
    expect(await collectPhase0Report()).toContain('当前对话完整读取：未通过或无法证明完整');
  });
});
