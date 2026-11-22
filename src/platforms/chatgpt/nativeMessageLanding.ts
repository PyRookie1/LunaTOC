import { APP_CONFIG } from '@/config/config';

export const CHATGPT_PROMPT_TOP_OFFSET_PX = APP_CONFIG.platforms.chatgpt.promptTopOffsetPx;

/** Compute the host-controller distance needed to place a prompt below ChatGPT's top fade. */
export function getNativeMessageLandingDistanceFromBottomPx(
  container: HTMLElement,
  target: HTMLElement | null
): number | null {
  const feed = container.getBoundingClientRect();
  const rect = target?.getBoundingClientRect();
  const connected = Boolean(container.isConnected && target?.isConnected && container.contains(target));
  if (!connected || !rect || rect.height <= 0) return null;

  const scale = container.offsetHeight > 0 ? feed.height / container.offsetHeight : 1;
  if (!Number.isFinite(scale) || scale <= 0 || container.clientHeight <= 0) return null;

  const topDelta = rect.top - feed.top - (container.clientTop + CHATGPT_PROMPT_TOP_OFFSET_PX) * scale;
  const range = Math.max(0, container.scrollHeight - container.clientHeight);
  const reverse = getComputedStyle(container).flexDirection === 'column-reverse';
  const min = reverse ? -range : 0;
  const max = reverse ? 0 : range;
  const requested = container.scrollTop + topDelta / scale;
  const attainable = Math.max(min, Math.min(max, requested));

  return reverse ? -attainable : range - attainable;
}

/** Validate that the selected prompt is visible and aligned below the host's top fade. */
export function measureNativeMessageLanding(container: HTMLElement, target: HTMLElement | null) {
  const feed = container.getBoundingClientRect();
  const rect = target?.getBoundingClientRect();
  const connected = Boolean(container.isConnected && target?.isConnected && container.contains(target));
  const visible = Boolean(connected && rect && rect.height > 0 && rect.bottom > feed.top && rect.top < feed.bottom);
  const scale = container.offsetHeight > 0 ? feed.height / container.offsetHeight : 1;
  const topDelta = connected && rect
    ? rect.top - feed.top - (container.clientTop + CHATGPT_PROMPT_TOP_OFFSET_PX) * scale
    : null;
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
