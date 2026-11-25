/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalysisVisibilityLifecycle } from '@/features/analysisVisibility/analysisVisibilityLifecycle';
import { ANALYSIS_HIDDEN_CLASS } from '@/features/analysisVisibility/analysisVisibilityController';
import { CHATGPT_MESSAGE_TYPES } from '@/platforms/chatgpt/messages';

let lifecycle: ReturnType<typeof createAnalysisVisibilityLifecycle> | null = null;
afterEach(() => {
  lifecycle?.stop();
  lifecycle = null;
  document.body.innerHTML = '';
});

describe('analysis visibility lifecycle', () => {
  it('starts disabled, responds to storage changes, and ignores a stale initial read', async () => {
    document.body.innerHTML = '<div class="thread-scroll-container"><button id="heading">已分析</button></div>';
    let resolveRead!: (enabled: boolean) => void;
    let change!: (enabled: boolean) => void;
    lifecycle = createAnalysisVisibilityLifecycle(document, () => () => {}, {
      readEnabled: () => new Promise(resolve => { resolveRead = resolve; }),
      subscribeEnabled: listener => { change = listener; return () => {}; },
    });
    const heading = document.querySelector('#heading')!;
    expect(heading.classList.contains(ANALYSIS_HIDDEN_CLASS)).toBe(false);
    change(true);
    expect(heading.classList.contains(ANALYSIS_HIDDEN_CLASS)).toBe(true);
    resolveRead(false);
    await Promise.resolve();
    expect(heading.classList.contains(ANALYSIS_HIDDEN_CLASS)).toBe(true);
    change(false);
    expect(heading.classList.contains(ANALYSIS_HIDDEN_CLASS)).toBe(false);
  });

  it('rescans a replaced virtual thread after a trusted route change', async () => {
    document.body.innerHTML = '<div class="thread-scroll-container"><button>Analyzed</button></div>';
    let route!: (event: MessageEvent) => void;
    lifecycle = createAnalysisVisibilityLifecycle(document, callback => {
      route = callback;
      return () => {};
    }, { readEnabled: async () => true, subscribeEnabled: () => () => {} });
    await vi.waitFor(() => expect(lifecycle!.controller.running).toBe(true));
    document.body.innerHTML = '<div class="thread-scroll-container"><button id="new">Analysis paused</button></div>';
    route(new MessageEvent('message', {
      source: window, origin: window.location.origin,
      data: { type: CHATGPT_MESSAGE_TYPES.routeChanged },
    }));
    await vi.waitFor(() => expect(document.querySelector('#new')?.classList.contains(ANALYSIS_HIDDEN_CLASS)).toBe(true));
    lifecycle.stop();
    expect(document.querySelector('#new')?.classList.contains(ANALYSIS_HIDDEN_CLASS)).toBe(false);
  });
});
