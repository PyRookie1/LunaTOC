/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigatorMocks = vi.hoisted(() => ({
  jumpToAbsoluteEdge: vi.fn(),
  jumpToEdge: vi.fn(),
  jumpToLastPrompt: vi.fn(),
}));

vi.mock('@/navigation/navigatorController', () => ({
  navigatorController: navigatorMocks,
}));

import { createJumpToEdgeControls } from '@/features/sidebar/jumpToEdgeControls';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  document.body.innerHTML = `
    <div class="navigator-jump-controls">
      <button id="toggle-view-mode-btn" type="button"></button>
    </div>
    <div id="navigator-list"></div>
  `;
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('jump-to-edge controls', () => {
  it('places the settings button third and retains the other controls', () => {
    const cluster = createJumpToEdgeControls(() => false);

    expect(Array.from(cluster.children).map((element) => element.id)).toEqual([
      'jump-chat-top-btn',
      'toggle-view-mode-btn',
      'luna-toc-edge-settings-btn',
      'jump-chat-bottom-btn',
    ]);
    expect(
      document.getElementById('jump-chat-top-btn')?.getAttribute('aria-label')
    ).toBe('跳转到顶部');
    expect(
      document.getElementById('jump-chat-bottom-btn')?.getAttribute('aria-label')
    ).toBe('跳转到底部');
    expect(document.getElementById('luna-toc-edge-settings-btn')?.getAttribute('aria-label'))
      .toBe('打开 LunaTOC 设置');
    expect(document.querySelector('#luna-toc-edge-settings-btn svg')).not.toBeNull();
  });

  it('opens the extension settings from the gear without changing navigation', () => {
    const openOptionsPage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { openOptionsPage } });
    createJumpToEdgeControls(() => false);
    document.getElementById('luna-toc-edge-settings-btn')?.click();
    expect(openOptionsPage).toHaveBeenCalledOnce();
    expect(navigatorMocks.jumpToEdge).not.toHaveBeenCalled();
  });

  it('delegates single clicks immediately to jumpToEdge without timer delay', () => {
    createJumpToEdgeControls(() => false);

    document.getElementById('jump-chat-top-btn')?.click();
    expect(navigatorMocks.jumpToEdge).toHaveBeenCalledWith('top');

    document.getElementById('jump-chat-bottom-btn')?.click();
    expect(navigatorMocks.jumpToEdge).toHaveBeenCalledWith('bottom');
    expect(navigatorMocks.jumpToLastPrompt).not.toHaveBeenCalled();
  });

  it('runs only last-prompt navigation for a pointer double-click', async () => {
    createJumpToEdgeControls(() => false);

    const bottomBtn = document.getElementById('jump-chat-bottom-btn')!;

    // Browser event sequence: click -> click -> dblclick
    bottomBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    bottomBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    bottomBtn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    await vi.advanceTimersByTimeAsync(350);
    expect(navigatorMocks.jumpToEdge).not.toHaveBeenCalled();
    expect(navigatorMocks.jumpToLastPrompt).toHaveBeenCalledOnce();
  });

  it('runs a pointer single-click after the double-click decision window', async () => {
    createJumpToEdgeControls(() => false);
    document.getElementById('jump-chat-bottom-btn')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1 })
    );
    expect(navigatorMocks.jumpToEdge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(navigatorMocks.jumpToEdge).toHaveBeenCalledExactlyOnceWith('bottom');
  });

  it('cancels a pending bottom jump when another target is chosen', async () => {
    createJumpToEdgeControls(() => false);
    document.getElementById('jump-chat-bottom-btn')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1 })
    );
    document.getElementById('jump-chat-top-btn')?.click();
    await vi.advanceTimersByTimeAsync(350);
    expect(navigatorMocks.jumpToEdge).toHaveBeenCalledExactlyOnceWith('top');
  });

  it('delegates double-click on top to jumpToAbsoluteEdge', () => {
    createJumpToEdgeControls(() => false);

    document
      .getElementById('jump-chat-top-btn')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(navigatorMocks.jumpToAbsoluteEdge).toHaveBeenCalledWith('top');
  });

  it('scrolls the sidebar list immediately while My Prompts is active', () => {
    const list = document.getElementById('navigator-list') as HTMLElement;
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo;
    Object.defineProperty(list, 'scrollHeight', { value: 480 });

    createJumpToEdgeControls(() => true);
    document.getElementById('jump-chat-top-btn')?.click();
    document.getElementById('jump-chat-bottom-btn')?.click();
    document
      .getElementById('jump-chat-bottom-btn')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(scrollTo).toHaveBeenNthCalledWith(1, {
      top: 0,
      behavior: 'smooth',
    });
    expect(scrollTo).toHaveBeenNthCalledWith(2, {
      top: 480,
      behavior: 'smooth',
    });
    expect(scrollTo).toHaveBeenNthCalledWith(3, {
      top: 480,
      behavior: 'auto',
    });
    expect(navigatorMocks.jumpToEdge).not.toHaveBeenCalled();
    expect(navigatorMocks.jumpToAbsoluteEdge).not.toHaveBeenCalled();
    expect(navigatorMocks.jumpToLastPrompt).not.toHaveBeenCalled();
  });
});
