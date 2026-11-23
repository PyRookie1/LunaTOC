/** MAIN-world read-only virtual-list and host-controller navigation diagnostics. */
import {
  TRACE_CONTROL_EVENT, TRACE_CONTEXT_EVENT, TRACE_MAIN_EVENT,
} from '@/features/navigationTrace/traceProtocol';
import type { ThreadScrollController } from './nativeScrollBridge';

let enabled = false;
let jumpId: string | null = null;
let activeUntil = 0;
let selectedTurnKey: string | null = null; // Never exported.
let feed: HTMLElement | null = null;
let observer: MutationObserver | null = null;
let resize: ResizeObserver | null = null;
let timer: number | null = null;
let lastScrollAt = 0;
let lastSignature = '';
let oldRow: HTMLElement | null = null;
let oldAssistant: HTMLElement | null = null;
let watchedRow: HTMLElement | null = null;
let getController: ((container: HTMLElement) => ThreadScrollController | null) | null = null;

export function recordMainNavigationTrace(event: string, details: Record<string, unknown> = {}): void {
  if (!enabled || !jumpId || performance.now() > activeUntil) return;
  document.dispatchEvent(new CustomEvent(TRACE_MAIN_EVENT, {
    detail: JSON.stringify({ jumpId, event, details, timestamp: performance.now() }),
  }));
}
export function setMainNavigationTraceTarget(turnKey: string): void {
  if (!enabled || !jumpId) return;
  selectedTurnKey = turnKey;
  sample('target-selected');
}
function getLiveRow(): HTMLElement | null {
  if (!feed || !selectedTurnKey) return null;
  return Array.from(feed.querySelectorAll<HTMLElement>('[data-turn-key]'))
    .find(row => row.dataset.turnKey === selectedTurnKey) ?? null;
}
function metrics(): Record<string, unknown> {
  if (!feed) return {};
  const range = Math.max(0, feed.scrollHeight - feed.clientHeight);
  const reverse = getComputedStyle(feed).flexDirection === 'column-reverse';
  const actualDistance = reverse ? Math.max(0, -feed.scrollTop)
    : Math.max(0, range - feed.scrollTop);
  let cachedDistance: number | null = null;
  try { cachedDistance = getController?.(feed)?.getLastScrollDistanceFromBottomPx() ?? null; }
  catch { /* Host may swap controllers during a render. */ }
  return {
    scrollTop: feed.scrollTop, scrollHeight: feed.scrollHeight,
    clientHeight: feed.clientHeight, scrollRange: range, isReverse: reverse,
    actualDistance, cachedDistance,
    cacheError: cachedDistance === null ? null : cachedDistance - actualDistance,
  };
}
function sample(reason: string): void {
  if (!feed) return;
  const row = getLiveRow();
  const assistant = row?.querySelector<HTMLElement>(
    '[data-chatgpt-search-unit-key$=":assistant"]'
  ) ?? null;
  if (oldRow !== row) {
    if (oldRow) recordMainNavigationTrace('target-row-unmounted', metrics());
    if (row) recordMainNavigationTrace('target-row-mounted', metrics());
    oldRow = row;
  }
  if (oldAssistant !== assistant) {
    if (oldAssistant) recordMainNavigationTrace('assistant-unmounted', metrics());
    if (assistant) recordMainNavigationTrace('assistant-mounted', metrics());
    oldAssistant = assistant;
  }
  if (row && row !== watchedRow) {
    if (watchedRow) resize?.unobserve(watchedRow);
    resize?.observe(row); watchedRow = row;
  }
  if (!row && watchedRow) { resize?.unobserve(watchedRow); watchedRow = null; }
  const rect = assistant?.getBoundingClientRect();
  const style = assistant ? getComputedStyle(assistant) : null;
  const visible = Boolean(rect && style && rect.height > 0 &&
    style.display !== 'none' && style.visibility !== 'hidden' &&
    Number(style.opacity) > 0 && !assistant?.hidden &&
    assistant?.getAttribute('aria-hidden') !== 'true');
  const state = {
    ...metrics(), rowMounted: Boolean(row), assistantMounted: Boolean(assistant),
    assistantVisible: visible,
    rowTop: row?.getBoundingClientRect().top ?? null,
    rowHeight: row?.getBoundingClientRect().height ?? null,
    assistantTop: rect?.top ?? null, assistantHeight: rect?.height ?? null,
  };
  const signature = JSON.stringify(state);
  if (signature !== lastSignature) {
    lastSignature = signature;
    recordMainNavigationTrace('layout-snapshot', { ...state, reason });
  }
}
function countNodes(nodes: NodeList, selector: string): number {
  let count = 0;
  for (const node of Array.from(nodes).slice(0, 40)) {
    if (!(node instanceof Element)) continue;
    if (node.matches(selector)) count++;
    count += Math.min(40, node.querySelectorAll(selector).length);
  }
  return count;
}
function stopCapture(): void {
  observer?.disconnect(); observer = null;
  resize?.disconnect(); resize = null;
  if (feed) feed.removeEventListener('scroll', onScroll);
  if (timer !== null) clearTimeout(timer);
  timer = null; feed = null; oldRow = null; oldAssistant = null;
  watchedRow = null; selectedTurnKey = null; lastSignature = '';
}
function onScroll(): void {
  const now = performance.now();
  if (now - lastScrollAt < 70) return;
  lastScrollAt = now;
  recordMainNavigationTrace('feed-scroll', metrics());
  sample('scroll');
}
function startCapture(): void {
  stopCapture();
  feed = document.querySelector<HTMLElement>(
    '.thread-scroll-container, [data-app-action-timeline-scroll]'
  );
  if (!feed) { recordMainNavigationTrace('feed-unavailable'); return; }
  recordMainNavigationTrace('capture-start', {
    hasController: Boolean(getController?.(feed)), ...metrics(),
  });
  feed.addEventListener('scroll', onScroll, { passive: true });
  observer = new MutationObserver(mutations => {
    const rowsSelector = '[data-turn-key]';
    const assistantSelector = '[data-chatgpt-search-unit-key$=":assistant"]';
    let rowsAdded = 0, rowsRemoved = 0, assistantsAdded = 0, assistantsRemoved = 0;
    let changed = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        rowsAdded += countNodes(mutation.addedNodes, rowsSelector);
        rowsRemoved += countNodes(mutation.removedNodes, rowsSelector);
        assistantsAdded += countNodes(mutation.addedNodes, assistantSelector);
        assistantsRemoved += countNodes(mutation.removedNodes, assistantSelector);
        changed = true;
      } else if (selectedTurnKey && mutation.target instanceof Element &&
        mutation.target.closest('[data-turn-key]')?.getAttribute('data-turn-key') === selectedTurnKey) {
        changed = true;
      }
    }
    if (rowsAdded || rowsRemoved || assistantsAdded || assistantsRemoved) {
      recordMainNavigationTrace('dom-mutation', {
        rowsAdded, rowsRemoved, assistantsAdded, assistantsRemoved, ...metrics(),
      });
    }
    if (changed) sample('mutation');
  });
  observer.observe(feed, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
  });
  if (typeof ResizeObserver !== 'undefined') {
    resize = new ResizeObserver(() => {
      recordMainNavigationTrace('layout-resize', metrics());
      sample('resize');
    });
    resize.observe(feed);
  }
  sample('begin');
  timer = window.setTimeout(() => {
    recordMainNavigationTrace('capture-window-ended', metrics());
    stopCapture(); jumpId = null;
  }, 16000);
}
function parseTraceDetail(event: Event): Record<string, unknown> | null {
  const raw = (event as CustomEvent).detail;
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}
export function installNavigationTraceMain(
  controllerLookup: (container: HTMLElement) => ThreadScrollController | null
): void {
  getController = controllerLookup;
  document.addEventListener(TRACE_CONTROL_EVENT, event => {
    const detail = parseTraceDetail(event);
    if (typeof detail?.enabled !== 'boolean') return;
    enabled = detail.enabled;
    if (!enabled) { stopCapture(); jumpId = null; }
  });
  document.addEventListener(TRACE_CONTEXT_EVENT, event => {
    const detail = parseTraceDetail(event);
    if (!enabled || typeof detail?.jumpId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(detail.jumpId)) return;
    jumpId = detail.jumpId; activeUntil = performance.now() + 16000;
    startCapture();
  });
  document.addEventListener('click', event => {
    if (!enabled || !jumpId || !(event.target instanceof Element)) return;
    const button = event.target.closest('button');
    if (!button || button.closest('#luna-toc-sidebar')) return;
    const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').toLowerCase();
    if (/bottom|scroll down|到底部|向下/.test(label)) {
      recordMainNavigationTrace('native-bottom-button-click');
    }
  }, true);
}
