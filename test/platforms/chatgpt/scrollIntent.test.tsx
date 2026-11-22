/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareChatGptNavigation } from '@/platforms/chatgpt/scrollIntent';

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('ChatGPT scroll intent', () => {
  it.each([true, false])('clears retained reading state before a jump when following=%s', async (initialFollowing) => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    let following = initialFollowing;
    let retainedPassage = true;
    let pendingAnimation = true;
    let scrollbarDrag = false;
    const events: string[] = [];
    const received: WheelEvent[] = [];
    await act(async () => root!.render(
      <div className="thread-scroll-container" onWheel={(event) => {
        received.push(event.nativeEvent);
        if (event.defaultPrevented || event.ctrlKey || event.shiftKey ||
            Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
            !event.nativeEvent.composedPath().includes(event.currentTarget)) return;
        if (event.deltaY < 0) {
          events.push('wheel');
          // The real host releases the measured passage on an upward wheel
          // only while following. Subsequent TOC clicks need the pointer path.
          if (following) {
            following = false;
            retainedPassage = false;
            pendingAnimation = false;
          }
        }
      }} />
    ));
    const feed = host.firstElementChild as HTMLElement;
    feed.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.target === feed) {
        events.push('pointerdown');
        retainedPassage = false;
        pendingAnimation = false;
        scrollbarDrag = true;
      }
    });
    feed.addEventListener('pointerup', () => { events.push('pointerup'); scrollbarDrag = false; });
    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.focus();
    editor.value = 'keep selection';
    editor.setSelectionRange(2, 6);
    feed.scrollTop = 2400;
    prepareChatGptNavigation(feed);
    expect(following).toBe(false);
    expect(retainedPassage).toBe(false);
    expect(pendingAnimation).toBe(false);
    expect(scrollbarDrag).toBe(false);
    expect(events).toEqual(['pointerdown', 'pointerup', 'wheel']);
    expect(feed.scrollTop).toBe(2400);
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 6]);
    expect(received).toHaveLength(1);
    expect(received[0].deltaY).toBeLessThan(0);
    expect(received[0].composed).toBe(true);
    expect(received[0].deltaMode).toBe(WheelEvent.DOM_DELTA_PIXEL);
  });

  it('does not send host scroll intent on a detached feed', () => {
    const feed = document.createElement('div');
    const listener = vi.fn();
    feed.addEventListener('wheel', listener);
    feed.addEventListener('pointerdown', listener);
    feed.addEventListener('pointerup', listener);
    prepareChatGptNavigation(feed);
    expect(listener).not.toHaveBeenCalled();
  });
});
