/**
 * The new ChatGPT conversation header/fade occupies the upper part of the
 * feed. Keep directory targets below it using the browser's scroll-margin
 * contract, while retaining the legacy 10px inset when no margin is applied.
 */
export const CHATGPT_PROMPT_SCROLL_MARGIN_TOP_PX = 120;
const LEGACY_NATIVE_LANDING_INSET_PX = 10;

/** Apply the directory landing margin without reducing a larger host margin. */
export function applyChatGptPromptScrollMargin(target: HTMLElement | null): void {
  if (!target) return;
  const current = getChatGptPromptScrollMarginTop(target);
  target.style.scrollMarginTop = `${Math.max(CHATGPT_PROMPT_SCROLL_MARGIN_TOP_PX, current)}px`;
}

/** Read the CSS landing margin; legacy targets retain the host's 10px inset. */
export function getChatGptPromptScrollMarginTop(target: HTMLElement | null): number {
  if (!target) return LEGACY_NATIVE_LANDING_INSET_PX;
  const value = Number.parseFloat(getComputedStyle(target).scrollMarginTop);
  return Number.isFinite(value) && value > 0 ? value : LEGACY_NATIVE_LANDING_INSET_PX;
}

export function measureNativeMessageLanding(container: HTMLElement, target: HTMLElement | null) {
  const feed = container.getBoundingClientRect();
  const rect = target?.getBoundingClientRect();
  const connected = Boolean(container.isConnected && target?.isConnected && container.contains(target));
  const visible = Boolean(connected && rect && rect.height > 0 && rect.bottom > feed.top && rect.top < feed.bottom);
  const scale = container.offsetHeight > 0 ? feed.height / container.offsetHeight : 1;
  const topOffset = getChatGptPromptScrollMarginTop(target);
  const topDelta = connected && rect ? rect.top - feed.top - (container.clientTop + topOffset) * scale : null;
  const range = Math.max(0, container.scrollHeight - container.clientHeight);
  const reverse = getComputedStyle(container).flexDirection === 'column-reverse';
  const min = reverse ? -range : 0;
  const max = reverse ? 0 : range;
  const requested = topDelta === null ? null : container.scrollTop + topDelta / (scale || 1);
  const attainable = requested === null ? null : Math.max(min, Math.min(max, requested));
  const atBoundary = container.clientHeight > 0 && requested !== null && attainable !== null &&
    Math.abs(requested - attainable) > 2 && Math.abs(attainable - container.scrollTop) <= 1;
  return {
    aligned: Boolean(visible && topDelta !== null && (Math.abs(topDelta) <= 3 || atBoundary)),
    visible, topDelta, scrollTop: container.scrollTop, scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight, targetHeight: rect?.height ?? null,
  };
}
