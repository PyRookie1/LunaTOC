/**
 * Release ChatGPT's follow-growth and retained-reading state before a TOC jump.
 *
 * The host keeps these flags independently of scrollTop. An upward wheel
 * releases follow-growth, but once following is off it can retain a measured
 * passage from the PREVIOUS jump. Its mouse pointer-down handler on the feed
 * clears that passage and pending animation unconditionally. Pair pointer-up
 * before scrolling so no synthetic scrollbar-drag state remains armed.
 * Dispatch on the feed itself: nested code blocks/composer scrollers must not
 * consume the intent. These events notify handlers; the navigation engine
 * still performs the physical scroll, without changing focus or selection.
 */
import { prepareChatGptNativeScroll } from './nativeScrollClient';

export function prepareChatGptNavigation(container: HTMLElement): void {
  if (!container.isConnected) return;
  if (prepareChatGptNativeScroll(container)) return;
  const pointerOptions: PointerEventInit = {
    pointerType: 'mouse',
    pointerId: 1,
    isPrimary: true,
    button: 0,
    bubbles: true,
    composed: true,
    cancelable: true,
  };
  container.dispatchEvent(new PointerEvent('pointerdown', { ...pointerOptions, buttons: 1 }));
  container.dispatchEvent(new PointerEvent('pointerup', { ...pointerOptions, buttons: 0 }));
  container.dispatchEvent(new WheelEvent('wheel', {
    deltaY: -1,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    bubbles: true,
    composed: true,
    cancelable: true,
  }));
}
