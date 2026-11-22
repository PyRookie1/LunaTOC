/** @vitest-environment jsdom */
/** Tests configuration-based routing between ChatGPT navigation strategies. */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  findPrompt: vi.fn(),
  findText: vi.fn(),
  getContainer: vi.fn(),
  prepareForNavigation: vi.fn(),
  navigateToMessage: vi.fn(),
  createJumpId: vi.fn(() => 'jump-id-stub'),
  getTestConfig: vi.fn(() => null),
  logEvent: vi.fn(),
  setJumpProgress: vi.fn(),
  clearJumpProgress: vi.fn(),
  notifyJumpFailed: vi.fn(),
}));

vi.mock('@/platforms', () => ({
  getActivePlatform: () => ({
    id: 'chatgpt',
    navigation: {
      getScrollContainer: mocks.getContainer,
      prepareForNavigation: mocks.prepareForNavigation,
      navigateToMessage: mocks.navigateToMessage,
      findRenderedPrompt: mocks.findPrompt,
      findRenderedPromptByText: mocks.findText,
      readMountedWithSidebarIdx: vi.fn(() => []),
      promptTopOffsetPx: 100,
    },
    diagnostics: {
      createJumpId: mocks.createJumpId,
      getTestConfig: mocks.getTestConfig,
      logEvent: mocks.logEvent,
    },
    config: {
      selectors: {
        userMessage: '[data-chatgpt-search-unit-key$=":user"]',
        assistantMessage: '[data-chatgpt-search-unit-key$=":assistant"]',
        messageId: 'data-chatgpt-search-message-ids',
      },
    },
  }),
}));

vi.mock('@/navigation/follow/follow', () => ({
  keepFollowing: vi.fn(),
}));

import {
  cancelPromptNavigation,
  initializePromptNavigation,
  jumpToMessage,
} from '@/navigation/jump/promptNavigation';
import { prepareChatGptNavigation } from '@/platforms/chatgpt/scrollIntent';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.prepareForNavigation.mockReset();
  mocks.navigateToMessage.mockReset();
  document.body.innerHTML = '';
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds: number[] = [];

      disconnect(): void {}
      observe(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    })
  );

  initializePromptNavigation({
    getVirtualSearchContext: () => ({
      conversationKey: 'conversation-1',
      prompts: [
        {
          id: 'prompt-1',
          text: 'Prompt',
          canMatchByText: true,
          createTime: 0,
        },
      ],
    }),
    setJumpProgress: mocks.setJumpProgress,
    clearJumpProgress: mocks.clearJumpProgress,
    notifyJumpFailed: mocks.notifyJumpFailed,
  });
});

afterEach(() => {
  cancelPromptNavigation();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('prompt navigation strategy', () => {
  it('highlights the first presented prompt before background verification completes', async () => {
    const feed = document.createElement('div'); document.body.append(feed);
    const target = document.createElement('div'); feed.append(target);
    mocks.getContainer.mockReturnValue(feed);
    mocks.findPrompt.mockReturnValue(target);
    let reveal!: (shown: boolean) => void;
    let verify!: (result: 'found' | 'failed' | 'cancelled') => void;
    mocks.navigateToMessage.mockReturnValue({
      ready: new Promise<boolean>(resolve => { reveal = resolve; }),
      finished: new Promise(resolve => { verify = resolve; }), cancel: vi.fn(),
    });
    jumpToMessage({ id: 'prompt-1', text: 'Prompt', canMatchByText: true, createTime: 0 }, 0);
    reveal(true); await Promise.resolve();
    expect(target.style.outline).toBe('2px solid #60a5fa');
    expect(mocks.clearJumpProgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(target.style.outline).toBe('');
    verify('found'); await Promise.resolve();
    expect(target.style.outline).toBe('');
    expect(mocks.clearJumpProgress).toHaveBeenCalledOnce();
  });

  it('ignores a late ready notification from a superseded directory click', async () => {
    const feed = document.createElement('div'); document.body.append(feed);
    const target = document.createElement('div'); feed.append(target);
    mocks.getContainer.mockReturnValue(feed); mocks.findPrompt.mockReturnValue(target);
    let oldReady!: (shown: boolean) => void;
    mocks.navigateToMessage.mockReturnValueOnce({
      ready: new Promise<boolean>(resolve => { oldReady = resolve; }),
      finished: new Promise(() => {}), cancel: vi.fn(),
    }).mockReturnValueOnce({ finished: new Promise(() => {}), cancel: vi.fn() });
    const message = { id: 'prompt-1', text: 'Prompt', canMatchByText: true, createTime: 0 };
    jumpToMessage(message, 0); jumpToMessage(message, 0);
    oldReady(true); await Promise.resolve();
    expect(mocks.findPrompt).not.toHaveBeenCalled();
    expect(target.style.outline).toBe('');
  });

  it('does not run pixel scans or landing corrections during an accepted native jump', async () => {
    const feed = document.createElement('div'); document.body.append(feed);
    feed.scrollTo = vi.fn();
    mocks.getContainer.mockReturnValue(feed);
    const cancel = vi.fn();
    let complete!: (result: 'found' | 'failed') => void;
    mocks.navigateToMessage.mockReturnValue({ cancel, finished: new Promise(resolve => { complete = resolve; }) });
    jumpToMessage({ id: 'prompt-1', text: 'Prompt', canMatchByText: true, createTime: 0 }, 0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(feed.scrollTo).not.toHaveBeenCalled();
    expect(mocks.findPrompt).not.toHaveBeenCalled();
    complete('failed'); await Promise.resolve();
    expect(mocks.notifyJumpFailed).toHaveBeenCalledOnce();
    expect(feed.scrollTo).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels native navigation when switching to another directory or cancelling navigation', () => {
    const feed = document.createElement('div'); document.body.append(feed);
    mocks.getContainer.mockReturnValue(feed);
    const cancel = vi.fn();
    mocks.navigateToMessage.mockReturnValue({ cancel, finished: new Promise(() => {}) });
    const message = { id: 'prompt-1', text: 'Prompt', canMatchByText: true, createTime: 0 };
    jumpToMessage(message, 0); jumpToMessage(message, 0);
    expect(cancel).toHaveBeenCalledOnce();
    cancelPromptNavigation();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('does not restore the fourth prompt after five consecutive jumps with following already off', async () => {
    const feed = document.createElement('div');
    document.body.append(feed);
    Object.defineProperties(feed, {
      scrollHeight: { value: 5000 }, clientHeight: { value: 600 },
    });
    feed.getBoundingClientRect = () => ({ top: 0, bottom: 600 } as DOMRect);
    feed.scrollTop = 4400;
    const messages = Array.from({ length: 5 }, (_, i) => ({
      id: `prompt-${i + 1}`, text: `Prompt ${i + 1}`, canMatchByText: true, createTime: i,
    }));
    const elements = messages.map((message, i) => {
      const prompt = document.createElement('div');
      prompt.textContent = message.text;
      prompt.getBoundingClientRect = () => {
        const top = 200 + i * 500 - feed.scrollTop;
        return { top, bottom: top + 50, height: 50 } as DOMRect;
      };
      feed.append(prompt);
      return prompt;
    });
    let following = true;
    let readingScrollTop: number | null = null;
    let dragging = false;
    feed.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.target === feed) {
        readingScrollTop = null;
        dragging = true;
      }
    });
    feed.addEventListener('pointerup', () => { dragging = false; });
    feed.addEventListener('wheel', (event) => {
      if (event.deltaY < 0 && following) {
        following = false;
        readingScrollTop = null;
      }
    });
    mocks.getContainer.mockReturnValue(feed);
    mocks.findPrompt.mockImplementation((id: string) => elements[messages.findIndex(message => message.id === id)] ?? null);
    mocks.prepareForNavigation.mockImplementation(prepareChatGptNavigation);
    initializePromptNavigation({
      getVirtualSearchContext: () => ({ conversationKey: 'conversation-1', prompts: messages }),
      setJumpProgress: mocks.setJumpProgress,
      clearJumpProgress: mocks.clearJumpProgress,
      notifyJumpFailed: mocks.notifyJumpFailed,
    });
    for (let i = 0; i < messages.length; i++) {
      jumpToMessage(messages[i], i);
      if (i === 4) {
        // A late virtual-turn measurement restores the previous reading
        // passage unless the navigation explicitly released it.
        setTimeout(() => {
          if (readingScrollTop !== null) feed.scrollTop = readingScrollTop;
        }, 2500);
      }
      await vi.advanceTimersByTimeAsync(3000);
      expect(elements[i].getBoundingClientRect().top).toBe(100);
      expect(dragging).toBe(false);
      // The host captures a new passage after each settled scroll.
      readingScrollTop = feed.scrollTop;
    }
    expect(mocks.notifyJumpFailed).not.toHaveBeenCalled();
  });

  it('releases persistent host follow before landing, including resizes after the correction window', async () => {
    const feed = document.createElement('div');
    const prompt = document.createElement('div');
    feed.append(prompt);
    document.body.append(feed);
    Object.defineProperties(feed, {
      scrollHeight: { value: 3000 }, clientHeight: { value: 600 },
    });
    feed.getBoundingClientRect = () => ({ top: 0, bottom: 600 } as DOMRect);
    prompt.getBoundingClientRect = () => ({
      top: 200 - feed.scrollTop, bottom: 250 - feed.scrollTop, height: 50,
    } as DOMRect);
    feed.scrollTop = 2400;
    let following = true;
    const intent = vi.fn((event: WheelEvent) => {
      if (event.deltaY < 0) following = false;
    });
    feed.addEventListener('wheel', intent);
    mocks.getContainer.mockReturnValue(feed);
    mocks.findPrompt.mockReturnValue(prompt);
    mocks.prepareForNavigation.mockImplementation(prepareChatGptNavigation);
    jumpToMessage({ id: 'prompt-1', text: 'Prompt', canMatchByText: true, createTime: 0 }, 0);
    // Host resize / follow work continues after the old 1.6s retry window.
    for (const delay of [200, 1800, 2600, 4000]) {
      setTimeout(() => { if (following) feed.scrollTop = 2400; }, delay);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(prompt.getBoundingClientRect().top).toBe(100);
    expect(intent).toHaveBeenCalledOnce();
    expect(mocks.notifyJumpFailed).not.toHaveBeenCalled();
  });

  it.each([false, true])('verifies a bottom-to-prompt landing after a delayed host snap and remount (reverse=%s)', async (reverse) => {
    const container = document.createElement('div');
    container.style.flexDirection = reverse ? 'column-reverse' : 'column';
    container.style.scrollBehavior = 'smooth';
    Object.defineProperties(container, {
      scrollHeight: { value: 3000 }, clientHeight: { value: 600 },
    });
    container.getBoundingClientRect = () => ({ top: 0, bottom: 600 } as DOMRect);
    const bottom = reverse ? 0 : 2400;
    container.scrollTop = bottom;
    container.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
      container.scrollTop = typeof options === 'number' ? y! : options?.top ?? 0;
    });
    document.body.append(container);
    const mount = (): HTMLElement => {
      const node = document.createElement('div');
      node.scrollIntoView = vi.fn(() => { container.scrollTop = reverse ? -2320 : 80; });
      node.getBoundingClientRect = () => {
        const top = 200 - container.scrollTop - (reverse ? 2400 : 0);
        return { top, bottom: top + 50, height: 50 } as DOMRect;
      };
      container.replaceChildren(node);
      return node;
    };
    let live = mount();
    mocks.getContainer.mockReturnValue(container);
    mocks.findPrompt.mockImplementation(() => live);
    const message = { id: 'prompt-1', text: 'Prompt', canMatchByText: true, createTime: 0 };
    jumpToMessage(message, 0);
    expect(live.getBoundingClientRect().top).toBe(100);
    setTimeout(() => { live = mount(); container.scrollTop = bottom; }, 300);
    await vi.advanceTimersByTimeAsync(1700);
    expect(live.getBoundingClientRect().top).toBe(100);
    expect(container.scrollTo).toHaveBeenCalledWith({ top: reverse ? -2320 : 80, behavior: 'instant' });
    expect(mocks.notifyJumpFailed).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.anything(), 'JUMP_FINISHED', expect.objectContaining({status:'found-and-settled'}), undefined);
  });

  it('does not use text fallback for a prompt containing attachments', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mocks.getContainer.mockReturnValue(container);
    mocks.findPrompt.mockReturnValue(null);
    const message = { id: 'file-prompt', text: '[文件] attachment', canMatchByText: false, createTime: 0 };
    initializePromptNavigation({
      getVirtualSearchContext: () => ({ conversationKey: 'conversation-1', prompts: [message] }),
      setJumpProgress: mocks.setJumpProgress,
      clearJumpProgress: mocks.clearJumpProgress,
      notifyJumpFailed: mocks.notifyJumpFailed,
    });
    jumpToMessage(message, 0);
    expect(mocks.findText).not.toHaveBeenCalled();
  });

  it('rejects text fallback for repeated prompts even when one is mounted', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mocks.getContainer.mockReturnValue(container);
    mocks.findPrompt.mockReturnValue(null);
    const messages = ['first', 'second'].map((id) => ({
      id, text: 'Repeat this prompt', canMatchByText: true, createTime: 0,
    }));
    initializePromptNavigation({
      getVirtualSearchContext: () => ({ conversationKey: 'conversation-1', prompts: messages }),
      setJumpProgress: mocks.setJumpProgress,
      clearJumpProgress: mocks.clearJumpProgress,
      notifyJumpFailed: mocks.notifyJumpFailed,
    });
    jumpToMessage(messages[1], 1);
    expect(mocks.findText).not.toHaveBeenCalled();
  });

  it('jumps to a currently mounted prompt by exact identity', () => {
    const container = document.createElement('div');
    const target = document.createElement('div');
    document.body.append(container, target);
    target.scrollIntoView = vi.fn();
    mocks.getContainer.mockReturnValue(container);
    mocks.findPrompt.mockReturnValue(target);
    jumpToMessage({ id: 'prompt-1', text: 'Prompt', canMatchByText: true, createTime: 0 }, 0);
    expect(target.scrollIntoView).toHaveBeenCalledOnce();
    expect(mocks.notifyJumpFailed).not.toHaveBeenCalled();
  });

  it('navigates directly via fast-path when target is rendered in independent-virtual strategy', async () => {
    const container = document.createElement('div');
    const target = document.createElement('div');
    document.body.append(container, target);
    target.scrollIntoView = vi.fn();
    mocks.getContainer.mockReturnValue(container);
    mocks.findPrompt.mockReturnValue(target);

    jumpToMessage(
      {
        id: 'prompt-1',
        text: 'Prompt',
        canMatchByText: true,
        createTime: 0,
      },
      0
    );

    expect(target.scrollIntoView).toHaveBeenCalledOnce();
    expect(target.scrollIntoView).toHaveBeenLastCalledWith({
      behavior: 'instant',
      container: 'nearest',
      block: 'start',
    });
    expect(target.style.outline).toBe('2px solid #60a5fa');
    expect(mocks.clearJumpProgress).toHaveBeenCalled();
    expect(mocks.notifyJumpFailed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(599);
    expect(target.style.outline).toBe('2px solid #60a5fa');
    await vi.advanceTimersByTimeAsync(1);
    expect(target.style.outline).toBe('');
    expect(target.style.borderRadius).toBe('');
  });

  it('scrolls to the bottom of the selected answer, not the whole conversation', () => {
    const container = document.createElement('div');
    const user = document.createElement('div');
    user.setAttribute('data-chatgpt-search-unit-key', 'turn-1:user');
    const answer = document.createElement('div');
    answer.setAttribute('data-chatgpt-search-unit-key', 'turn-1:assistant');
    const nextUser = document.createElement('div');
    nextUser.setAttribute('data-chatgpt-search-unit-key', 'turn-2:user');
    const nextAnswer = document.createElement('div');
    nextAnswer.setAttribute('data-chatgpt-search-unit-key', 'turn-2:assistant');
    user.scrollIntoView = vi.fn();
    answer.scrollIntoView = vi.fn();
    nextAnswer.scrollIntoView = vi.fn();
    document.body.append(user, answer, nextUser, nextAnswer);
    document.body.append(container);
    mocks.getContainer.mockReturnValue(container);
    mocks.findPrompt.mockReturnValue(user);

    jumpToMessage({ id: 'prompt-1', text: 'Prompt', canMatchByText: true, createTime: 0 }, 0, 'bottom');
    expect(answer.scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant',
      container: 'nearest', block: 'end' });
    expect(nextAnswer.scrollIntoView).not.toHaveBeenCalled();
    expect(user.scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not cross into the next prompt when the selected answer is absent', () => {
    const container = document.createElement('div');
    const user = document.createElement('div');
    user.setAttribute('data-chatgpt-search-unit-key', 'turn-1:user');
    const nextUser = document.createElement('div');
    nextUser.setAttribute('data-chatgpt-search-unit-key', 'turn-2:user');
    const nextAnswer = document.createElement('div');
    nextAnswer.setAttribute('data-chatgpt-search-unit-key', 'turn-2:assistant');
    user.scrollIntoView = vi.fn();
    nextAnswer.scrollIntoView = vi.fn();
    document.body.append(user, nextUser, nextAnswer);
    document.body.append(container);
    mocks.getContainer.mockReturnValue(container);
    mocks.findPrompt.mockReturnValue(user);

    jumpToMessage({ id: 'prompt-1', text: 'Prompt', canMatchByText: true, createTime: 0 }, 0, 'bottom');
    expect(user.scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant',
      container: 'nearest', block: 'end' });
    expect(nextAnswer.scrollIntoView).not.toHaveBeenCalled();
  });

  it('initiates virtual step-loading when target is not rendered in the DOM', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mocks.getContainer.mockReturnValue(container);
    mocks.findPrompt.mockReturnValue(null);

    jumpToMessage(
      {
        id: 'prompt-1',
        text: 'Prompt',
        canMatchByText: true,
        createTime: 0,
      },
      0
    );

    expect(mocks.setJumpProgress).toHaveBeenCalledWith({
      active: true,
      targetIndex: 0,
      remainingSteps: 50,
    });
  });

  it('starts independent virtual search without calling the legacy path', async () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'scrollHeight', {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(container, 'clientHeight', {
      value: 600,
      configurable: true,
    });
    container.scrollTop = 400;
    document.body.appendChild(container);
    mocks.getContainer.mockReturnValue(container);
    mocks.findPrompt.mockReturnValue(null);

    jumpToMessage(
      {
        id: 'prompt-1',
        text: 'Prompt',
        canMatchByText: true,
        createTime: 0,
      },
      0
    );

    expect(mocks.setJumpProgress).toHaveBeenCalled();

    await Promise.resolve();

    expect(mocks.notifyJumpFailed).toHaveBeenCalledOnce();
    expect(mocks.clearJumpProgress).toHaveBeenCalled();
    expect(container.scrollTop).toBe(400);
  });
});
