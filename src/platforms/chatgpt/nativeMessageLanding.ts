/** The host scrollToKey({align:'top'}) leaves a 10px inset. */
export function measureNativeMessageLanding(container: HTMLElement, target: HTMLElement | null) {
  const feed = container.getBoundingClientRect();
  const rect = target?.getBoundingClientRect();
  const connected = Boolean(container.isConnected && target?.isConnected && container.contains(target));
  const visible = Boolean(connected && rect && rect.height > 0 && rect.bottom > feed.top && rect.top < feed.bottom);
  const scale = container.offsetHeight > 0 ? feed.height / container.offsetHeight : 1;
  const topDelta = connected && rect ? rect.top - feed.top - (container.clientTop + 10) * scale : null;
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
