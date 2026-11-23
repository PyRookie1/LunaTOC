/** Opt-in ISOLATED-world navigation trace buffer. No conversation content is stored. */
import {
  TRACE_ENABLED_KEY, TRACE_CLEAR_KEY, TRACE_FLUSH_KEY, TRACE_SESSION_PREFIX,
  TRACE_CONTROL_EVENT, TRACE_CONTEXT_EVENT, TRACE_MAIN_EVENT, TRACE_SCHEMA_VERSION,
  TRACE_MAX_EVENTS, sanitizeTraceDetails, sanitizeTraceEventName,
  type TraceEvent, type TraceSession,
} from './traceProtocol';

let enabled = false;
let installed = false;
let activeJumpId: string | null = null;
let sessionId = crypto.randomUUID();
let createdAt = new Date().toISOString();
let events: TraceEvent[] = [];
let dropped = 0;
let sequence = 0;
let timer: number | null = null;
let writing = false;
let rewrite = false;

function storageKey(): string { return TRACE_SESSION_PREFIX + sessionId; }
function append(layer: 'isolated' | 'main', name: unknown, details: unknown, at = performance.now()): void {
  if (!enabled) return;
  const event = sanitizeTraceEventName(name);
  if (!event) return;
  const record: TraceEvent = {
    sequence: ++sequence,
    timestamp: Number.isFinite(at) ? Math.round(at * 100) / 100 : performance.now(),
    jumpId: activeJumpId,
    layer,
    event,
    details: sanitizeTraceDetails(details),
  };
  events.push(record);
  if (events.length > TRACE_MAX_EVENTS) { events.shift(); dropped++; }
  scheduleFlush();
}
function scheduleFlush(): void {
  if (timer !== null) return;
  timer = window.setTimeout(() => { timer = null; void flushNavigationTrace(); }, 350);
}
async function flushNavigationTrace(): Promise<void> {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (!events.length) return;
  if (writing) { rewrite = true; return; }
  writing = true;
  try {
    do {
      rewrite = false;
      const record: TraceSession = {
        schemaVersion: TRACE_SCHEMA_VERSION, sessionId, createdAt,
        savedAt: new Date().toISOString(), dropped, events: events.slice(),
      };
      await chrome.storage.local.set({ [storageKey()]: record });
    } while (rewrite);
  } catch (error) {
    console.warn('[LunaTOC navigation trace] Local trace write failed', error);
  } finally {
    writing = false;
  }
}
function notifyMain(): void {
  document.dispatchEvent(new CustomEvent(TRACE_CONTROL_EVENT, { detail: JSON.stringify({ enabled }) }));
}
function resetSession(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  sessionId = crypto.randomUUID();
  createdAt = new Date().toISOString();
  events = [];
  dropped = 0;
  sequence = 0;
  activeJumpId = null;
}
function collectMain(event: Event): void {
  if (!enabled || event.target !== document || !activeJumpId) return;
  const raw = (event as CustomEvent).detail;
  if (typeof raw !== 'string' || raw.length > 2048) return;
  let data: { jumpId?: unknown; event?: unknown; details?: unknown; timestamp?: unknown };
  try { data = JSON.parse(raw); } catch { return; }
  if (data.jumpId !== activeJumpId) return;
  append('main', data.event, data.details,
    typeof data.timestamp === 'number' ? data.timestamp : performance.now());
}
async function pruneOldSessions(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all).filter(([key, value]) =>
      key.startsWith(TRACE_SESSION_PREFIX) && value && typeof value === 'object'
    ).sort((a, b) => String((b[1] as TraceSession).createdAt ?? '')
      .localeCompare(String((a[1] as TraceSession).createdAt ?? '')));
    const expired = entries.filter(([, value]) =>
      Date.now() - Date.parse(String((value as TraceSession).createdAt)) > 48 * 3600_000
    ).map(([key]) => key);
    const excess = entries.slice(8).map(([key]) => key);
    if (expired.length || excess.length) {
      await chrome.storage.local.remove([...new Set([...expired, ...excess])]);
    }
  } catch { /* Trace retention cleanup must never affect navigation. */ }
}
export function installNavigationTraceCollector(): void {
  if (installed) return;
  installed = true;
  document.addEventListener(TRACE_MAIN_EVENT, collectMain);
  let enableChanged = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (TRACE_ENABLED_KEY in changes) {
      enableChanged = true;
      const next = changes[TRACE_ENABLED_KEY].newValue === true;
      if (enabled && !next) void flushNavigationTrace();
      enabled = next;
      notifyMain();
      if (enabled) append('isolated', 'trace-enabled', {});
    }
    if (TRACE_CLEAR_KEY in changes) { resetSession(); }
    if (TRACE_FLUSH_KEY in changes) { void flushNavigationTrace(); }
  });
  void chrome.storage.local.get(TRACE_ENABLED_KEY).then(result => {
    if (!enableChanged) enabled = result[TRACE_ENABLED_KEY] === true;
    notifyMain();
    if (enabled) {
      append('isolated', 'trace-enabled', {});
      void pruneOldSessions();
    }
  }).catch(() => { enabled = false; notifyMain(); });
}
/** The same jump ID is forwarded to MAIN before any navigation writes. */
export function beginNavigationTrace(source: string, targetIndex: number | null, edge: 'top' | 'bottom'): void {
  if (!enabled) return;
  activeJumpId = crypto.randomUUID();
  document.dispatchEvent(new CustomEvent(TRACE_CONTEXT_EVENT, {
    detail: JSON.stringify({ jumpId: activeJumpId, targetIndex, edge, source }),
  }));
  append('isolated', 'navigation-start', { source, targetIndex, edge });
}
export function recordNavigationTrace(name: string, details: Record<string, unknown> = {}): void {
  if (enabled && activeJumpId) append('isolated', name, details);
}
