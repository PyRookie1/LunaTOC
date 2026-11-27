/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureCheckSession } from '@/features/conversationExport/checkSession';
import { getActiveConversationOwner, setActiveConversationOwner } from '@/navigation/lifecycle/conversationOwner';
import { dispatchTrustedPageHookMessage } from '@/navigation/pageHookMessageTransport';
import { CHATGPT_MESSAGE_TYPES } from '@/platforms/chatgpt/messages';
import { CAPTURE_GENERATION_EVENT, TOC_REFRESH_REQUEST, TOC_REFRESH_RESULT, TOC_REFRESH_CANCEL } from '@/navigation/refresh/refreshProtocol';
import { installCaptureRuntime } from '@/features/conversationExport/runtime';
import type { ConversationSnapshot } from '@/navigation/state/activeBranch';

let sequence = 0;
let route: string;
let current: ConversationSnapshot;
let calls: Array<{ type: string; requestId: number; purpose: string }>;
let sessions: CaptureCheckSession[];
let answerRequests: boolean;
const originalPath = location.pathname;
const body = (text = 'PRIVATE BODY'): ConversationSnapshot => ({
  activeBranchVerified: true, current_node: 'private-answer', page_info: { has_previous_page: false },
  readEvidence: { source: 'pages', pages: 2 }, messages: [
    { id: 'private-user', parent: null, author: { role: 'user' }, content: { parts: [text] },
      metadata: { attachments: [{ name: 'PRIVATE-FILE.pdf' }] } },
    { id: 'private-answer', parent: 'private-user', author: { role: 'assistant' }, content: { parts: ['PRIVATE ANSWER'] } },
  ],
});
const create = (scenario: ConstructorParameters<typeof CaptureCheckSession>[0] = 'stable') => {
  const session = new CaptureCheckSession(scenario); sessions.push(session); return session;
};

beforeEach(() => {
  route = `capture-conversation-${++sequence}`;
  history.replaceState(null, '', '/c/' + route);
  document.body.innerHTML = '<div class="thread-scroll-container"></div>';
  sessions = []; calls = []; current = body(); answerRequests = true;
  vi.stubGlobal('chrome', { runtime: { id: 'extension', getManifest: () => ({ version: '1.1.2' }),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() } } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user: { id: 'private-account' } }) }));
  setActiveConversationOwner('private-account');
  installCaptureRuntime();
  dispatchTrustedPageHookMessage({ type: CHATGPT_MESSAGE_TYPES.conversationData, routeKey: route, payload: current });
  vi.spyOn(window, 'postMessage').mockImplementation(message => {
    calls.push(message);
    if (message.type === TOC_REFRESH_REQUEST && answerRequests) {
      const payload = structuredClone(current);
      queueMicrotask(() => dispatchTrustedPageHookMessage({ type: TOC_REFRESH_RESULT,
        routeKey: route, requestId: message.requestId, payload }));
    }
  });
});

afterEach(() => {
  sessions.forEach(session => session.dispose());
  setActiveConversationOwner(null);
  history.replaceState(null, '', originalPath);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('read-only capture exercises', () => {
  it('checks twice and outputs aggregates without private content or export permission', async () => {
    const session = create(); await session.begin(false);
    expect(session.phase).toBe('done');
    expect(calls.filter(call => call.type === TOC_REFRESH_REQUEST)).toHaveLength(2);
    expect(calls.filter(call => call.type === TOC_REFRESH_REQUEST).every(call => call.purpose === 'capture')).toBe(true);
    const report = session.report();
    expect(report).toContain('范围内节点：2 个');
    expect(report).toContain('点击瞬间内容冻结：尚未验证');
    expect(report).toContain('正式导出许可：未通过');
    expect(report).not.toMatch(/PRIVATE|private-user|private-answer|private-account|capture-conversation|\.pdf/);
  });

  it('checks a completed conversation even when an older active-path turn is still marked pending', async () => {
    current.messages[0] = { ...current.messages[0], status: 'in_progress' } as typeof current.messages[number];
    current.messages[1] = { ...current.messages[1], status: 'finished_successfully', end_turn: true } as typeof current.messages[number];
    const quick = create(); await quick.begin(false);
    expect(quick.report()).toContain('范围内节点：2 个');
    expect(quick.report()).toContain('已完成两次读取核对');
    const boundary = create('append'); await boundary.begin();
    expect(boundary.phase).toBe('waiting');
    current.messages.push({ id: 'new-user', parent: 'private-answer', author: { role: 'user' }, content: { parts: ['new'] } });
    await boundary.finish();
    expect(boundary.report()).toContain('已通过：检测到新增消息且固定范围未改变');
  });

  it('blocks a genuinely unfinished current answer, even when an older answer has finished', async () => {
    current.messages[1] = { ...current.messages[1], status: 'finished_successfully', end_turn: true } as typeof current.messages[number];
    current.messages.push({ id: 'latest-answer', parent: 'private-answer', author: { role: 'assistant' },
      content: { parts: ['Still streaming'] }, status: 'in_progress' } as typeof current.messages[number]);
    const session = create(); await session.begin();
    expect(session.report()).toContain('当前回答仍在生成');
    expect(session.report()).toContain('范围内节点：0 个');
  });

  it('fixes the observed pre-click anchor even if the first read contains an appendix', async () => {
    const session = create('append');
    current.messages.push({ id: 'new-user', parent: 'private-answer', author: { role: 'user' }, content: { parts: ['new'] } });
    await session.begin(); await session.finish();
    expect(session.report()).toContain('范围内节点：2 个');
    expect(session.report()).toContain('已通过：检测到新增消息且固定范围未改变');
  });

  it('aborts on a mixed-revision second read rather than accepting a verified parent chain', async () => {
    const session = create('edit'); await session.begin();
    current = body('Question from another revision');
    await session.finish();
    expect(session.report()).toContain('已检测到历史内容或回答路径变化');
    expect(session.report()).toContain('正式导出许可：未通过');
    expect(session.report()).not.toContain('范围保持一致');
  });

  it('does not call an absent operation a passed branch-change test', async () => {
    const session = create('branch'); await session.begin(); await session.finish();
    expect(session.report()).toContain('未验证：未检测到预期变化');
  });

  it('stops immediately on a route event and ignores a later old response', async () => {
    answerRequests = false;
    const session = create('route'); const pending = session.begin();
    await vi.waitFor(() => expect(calls.some(call => call.type === TOC_REFRESH_REQUEST)).toBe(true));
    history.replaceState(null, '', '/c/another-conversation');
    dispatchTrustedPageHookMessage({ type: CHATGPT_MESSAGE_TYPES.routeChanged });
    await pending;
    expect(session.report()).toContain('已检测到对话切换');
    expect(calls.some(call => call.type === TOC_REFRESH_CANCEL)).toBe(true);
    const report = session.report();
    dispatchTrustedPageHookMessage({ type: TOC_REFRESH_RESULT, routeKey: route,
      requestId: calls.find(call => call.type === TOC_REFRESH_REQUEST)!.requestId, payload: body() });
    expect(session.report()).toBe(report);
  });

  it('cancels on account change and user stop while a request is pending', async () => {
    answerRequests = false;
    const session = create(); const pending = session.begin();
    await vi.waitFor(() => expect(calls.some(call => call.type === TOC_REFRESH_REQUEST)).toBe(true));
    setActiveConversationOwner('another-account'); await pending;
    expect(session.report()).toContain('账号状态已变化');
  });

  it('aborts an in-flight identity read without changing the shared account state', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      signal = options.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true });
    })));
    const session = create(); const pending = session.begin();
    expect(signal).toBeDefined(); session.cancel(); await pending;
    expect(signal!.aborted).toBe(true);
    expect(getActiveConversationOwner()).toBe('private-account');
    expect(session.report()).toContain('用户已停止检查');
  });

  it('blocks an observed generation request even if no stop button exists', async () => {
    dispatchTrustedPageHookMessage({ type: CAPTURE_GENERATION_EVENT, routeKey: route, requestId: 'stream', phase: 'started' });
    const session = create(); await session.begin();
    expect(session.report()).toContain('当前回答仍在生成');
    expect(calls.filter(call => call.type === TOC_REFRESH_REQUEST)).toHaveLength(0);
  });

  it('retires waiting sessions on timeout without periodic polling', async () => {
    vi.useFakeTimers();
    const session = create(); await session.begin();
    await vi.advanceTimersByTimeAsync(180_001);
    expect(session.report()).toContain('检查已超时');
    expect(calls.filter(call => call.type === TOC_REFRESH_REQUEST)).toHaveLength(1);
  });

  it('reports an incomplete read as unverified without leaking exception text', async () => {
    current.page_info!.has_previous_page = true;
    const session = create(); await session.begin(false);
    expect(session.report()).toContain('未能完成当前对话的只读检查');
    expect(session.report()).not.toContain('incomplete');
  });
});
