/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYSIS_HIDDEN_CLASS, createAnalysisVisibilityController } from '@/features/analysisVisibility/analysisVisibilityController';

let controller: ReturnType<typeof createAnalysisVisibilityController> | undefined;
const hidden = (selector: string): boolean => !!document.querySelector(selector)?.classList.contains(ANALYSIS_HIDDEN_CLASS);

afterEach(() => {
  controller?.stop();
  controller = undefined;
  document.body.innerHTML = '';
});

describe('analysis visibility', () => {
  it('hides complete analysis cards and standalone status, preserving final answers and unrelated text', () => {
    document.body.innerHTML = `<div class="thread-scroll-container">
      <section data-testid="conversation-turn-1">
        <div class="analysis-card" id="card"><button>Analyzed</button><pre>tool result</pre></div>
        <div class="markdown" id="answer">Analyzed</div>
        <div id="progress">Analyzed manual blend test coverage</div>
        <div id="stopped">Stopped thinking</div>
      </section>
      <div data-message-author-role="user" id="user">已分析</div>
      <form><textarea id="composer">Analysis paused</textarea></form>
    </div>`;
    controller = createAnalysisVisibilityController();
    controller.start();
    expect(hidden('#card')).toBe(true);
    expect(hidden('#stopped')).toBe(true);
    expect(hidden('#answer')).toBe(false);
    expect(hidden('#progress')).toBe(false);
    expect(hidden('#user')).toBe(false);
    expect(hidden('#composer')).toBe(false);
    controller.stop();
    expect(document.querySelector('.' + ANALYSIS_HIDDEN_CLASS)).toBeNull();
    expect(document.querySelector('#card')?.textContent).toContain('tool result');
  });

  it.each(['Analyzed', 'Analysis errored', 'Analysis paused', '已分析', '分析出错', '分析已暂停', 'Stopped thinking Analyzed'])(
    'recognizes compact heading %s', (title) => {
      document.body.innerHTML = `<div class="thread-scroll-container"><div data-message-author-role="assistant">
        <div id="card"><button></button><pre>result</pre></div><p class="markdown">answer</p>
      </div></div>`;
      document.querySelector('button')!.textContent = title;
      controller = createAnalysisVisibilityController();
      controller.start();
      expect(hidden('#card')).toBe(true);
      expect(hidden('.markdown')).toBe(false);
    }
  );

  it('handles lazily mounted cards and restores only LunaTOC-owned display markers', async () => {
    document.body.innerHTML = '<div class="thread-scroll-container"></div>';
    controller = createAnalysisVisibilityController();
    controller.start();
    const thread = document.querySelector('.thread-scroll-container')!;
    thread.insertAdjacentHTML('beforeend', '<div id="new"><button>Analyzed</button><code>tool</code></div>');
    await vi.waitFor(() => expect(hidden('#new')).toBe(true));
    controller.stop();
    expect(hidden('#new')).toBe(false);
    expect(document.querySelector('#new')?.getAttribute('style')).toBeNull();
  });

  it('does not scan the entire page when the thread is absent', () => {
    document.body.innerHTML = '<main><textarea>Analyzed</textarea><button id="outside">Analyzed</button></main>';
    controller = createAnalysisVisibilityController();
    controller.start();
    expect(hidden('#outside')).toBe(false);
  });

  it('leaves an independently hidden element untouched on restore', () => {
    document.body.innerHTML = '<div class="thread-scroll-container"><button id="heading" class="cgptfr-hidden-analyzed">Analyzed</button></div>';
    controller = createAnalysisVisibilityController();
    controller.start();
    controller.stop();
    expect(document.querySelector('#heading')?.classList.contains('cgptfr-hidden-analyzed')).toBe(true);
    expect(hidden('#heading')).toBe(false);
  });
});
