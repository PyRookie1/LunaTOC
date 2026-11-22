/** @vitest-environment jsdom */
/** Regression for the D4 field trace: delayed page measurement evicts target 5. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as adapter from '@/platforms/chatgpt/virtualSearchAdapter';
const callbacks = vi.hoisted(() => ({ failed: vi.fn(), progress: vi.fn(), clear: vi.fn() }));
vi.mock('@/platforms', () => ({ getActivePlatform: () => ({
  navigation: {
    getScrollContainer: adapter.getChatGptScrollContainer,
    findRenderedPrompt: adapter.findRenderedChatGptPrompt,
    findRenderedPromptByText: adapter.findRenderedChatGptPromptByText,
    readMountedWithSidebarIdx: adapter.readMountedWithSidebarIdx,
    promptTopOffsetPx: 16,
  },
  config: { selectors: { userMessage: '[data-chatgpt-search-unit-key$=":user"]', assistantMessage: '[data-chatgpt-search-unit-key$=":assistant"]' } },
  diagnostics: { createJumpId: () => 'trace-regression', logEvent: () => {} },
}) }));
import { cancelPromptNavigation, initializePromptNavigation, jumpToMessage } from '@/navigation/jump/promptNavigation';

let feed: HTMLElement;
let height: number;
const messages = Array.from({ length: 7 }, (_, i) => ({ id: `p${i + 1}`, text: `Prompt ${i + 1}`, canMatchByText: true, createTime: i }));
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  height = 97881;
  feed = document.createElement('div'); feed.className = 'thread-scroll-container'; feed.style.overflowY = 'auto';
  Object.defineProperties(feed, { scrollHeight: { get: () => height }, clientHeight: { value: 849 } });
  feed.getBoundingClientRect = () => ({ top: 0, bottom: 849, height: 849 } as DOMRect);
  feed.scrollTop = 4349;
  document.body.append(feed);
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 849 });
  initializePromptNavigation({ getVirtualSearchContext: () => ({ conversationKey: 'trace-case', prompts: messages }),
    setJumpProgress: callbacks.progress, clearJumpProgress: callbacks.clear, notifyJumpFailed: callbacks.failed });
});
afterEach(() => { cancelPromptNavigation(); vi.clearAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); });

function mount(id: string, absoluteTop: number): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('data-chatgpt-search-unit-key', `${id}:user`);
  element.setAttribute('data-chatgpt-search-message-ids', id);
  element.getBoundingClientRect = () => ({ top: absoluteTop - feed.scrollTop, bottom: absoluteTop - feed.scrollTop + 610, height: 610 } as DOMRect);
  feed.append(element);
  return element;
}

describe('field-trace virtual remount regression', () => {
  it('waits for delayed measurement instead of racing through the fifth prompt window', async () => {
    mount('p4', 4365);
    let measuring = false, started = false, rushed = false;
    let target: HTMLElement | null = null;
    feed.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
      if (measuring) rushed = true;
      feed.scrollTop = typeof options === 'number' ? y! : options?.top ?? 0;
      if (started) return;
      started = true; measuring = true;
      // The uploaded trace first changes mounts after ~280ms, then measures
      // and compensates again after ~520ms, while total height changes.
      setTimeout(() => { height = 93597; feed.scrollTop = 3240; target = mount('p5', 3339); }, 280);
      setTimeout(() => {
        height = 100165;
        if (rushed) { target?.remove(); feed.scrollTop = 4890; }
        measuring = false;
      }, 520);
    });
    jumpToMessage(messages[4], 4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rushed).toBe(false);
    expect(adapter.findRenderedChatGptPrompt('p5')?.isConnected).toBe(true);
    expect(adapter.findRenderedChatGptPrompt('p5')!.getBoundingClientRect().top).toBe(16);
    expect(callbacks.failed).not.toHaveBeenCalled();
  });

  it('reloads an evicted target rather than waiting on its detached DOM reference', async () => {
    mount('p4', 4365);
    const first = mount('p5', 5000);
    let evicted = false;
    let remounted = false;
    feed.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
      feed.scrollTop = typeof options === 'number' ? y! : options?.top ?? 0;
      if (evicted && !remounted) {
        remounted = true;
        setTimeout(() => mount('p5', 5000), 180);
      }
    });
    jumpToMessage(messages[4], 4);
    setTimeout(() => { first.remove(); evicted = true; feed.scrollTop = 4349; }, 200);
    await vi.advanceTimersByTimeAsync(5000);
    const latest = adapter.findRenderedChatGptPrompt('p5');
    expect(latest).not.toBe(first);
    expect(latest?.getBoundingClientRect().top).toBe(16);
    expect(callbacks.failed).not.toHaveBeenCalled();
  });
});
