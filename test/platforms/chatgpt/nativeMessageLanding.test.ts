/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getNativeMessageLandingDistanceFromBottomPx,
  measureNativeMessageLanding,
} from '@/platforms/chatgpt/nativeMessageLanding';

let feed: HTMLDivElement;
let prompt: HTMLDivElement;
function position(top: number, height = 50): void {
  prompt.getBoundingClientRect = () => ({ top, bottom: top + height, height } as DOMRect);
}
beforeEach(() => {
  feed = document.createElement('div'); prompt = document.createElement('div');
  feed.append(prompt); document.body.append(feed);
  Object.defineProperties(feed, { clientHeight: { value: 600 }, scrollHeight: { value: 3000 } });
  feed.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 } as DOMRect);
  feed.scrollTop = 1000;
});
afterEach(() => document.body.replaceChildren());

describe('native landing validation', () => {
  it('rejects a visible prompt below the preceding answer, and a clipped tall prompt', () => {
    position(400);
    expect(measureNativeMessageLanding(feed, prompt)).toMatchObject({ visible: true, aligned: false, topDelta: 300 });
    position(-100, 800);
    expect(measureNativeMessageLanding(feed, prompt)).toMatchObject({ visible: true, aligned: false });
    position(99.333);
    expect(measureNativeMessageLanding(feed, prompt).aligned).toBe(true);
  });

  it('computes a host-controller distance that lands the prompt at the configured top offset', () => {
    position(10);
    expect(getNativeMessageLandingDistanceFromBottomPx(feed, prompt)).toBe(1490);
    feed.scrollTop = 890;
    position(100);
    expect(measureNativeMessageLanding(feed, prompt).aligned).toBe(true);
  });

  it('accepts the closest attainable position at the physical bottom boundary', () => {
    position(400); feed.scrollTop = 2400;
    expect(measureNativeMessageLanding(feed, prompt).aligned).toBe(true);
    feed.scrollTop = 2000;
    expect(measureNativeMessageLanding(feed, prompt).aligned).toBe(false);
  });

  it('handles reverse layout boundaries and rejects detached messages', () => {
    feed.style.flexDirection = 'column-reverse'; position(400); feed.scrollTop = 0;
    expect(measureNativeMessageLanding(feed, prompt).aligned).toBe(true);
    feed.scrollTop = -1000;
    expect(measureNativeMessageLanding(feed, prompt).aligned).toBe(false);
    prompt.remove();
    expect(measureNativeMessageLanding(feed, prompt)).toMatchObject({ visible: false, aligned: false });
  });
});
