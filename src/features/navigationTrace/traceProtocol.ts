/** Temporary, privacy-filtered navigation trace protocol. */
export const TRACE_ENABLED_KEY = 'lunatoc:navigationTrace:enabled:v1';
export const TRACE_CLEAR_KEY = 'lunatoc:navigationTrace:clear:v1';
export const TRACE_FLUSH_KEY = 'lunatoc:navigationTrace:flush:v1';
export const TRACE_SESSION_PREFIX = 'lunatoc:navigationTrace:session:v1:';
export const TRACE_CONTROL_EVENT = 'LUNATOC_NAV_TRACE_CONTROL_V1';
export const TRACE_CONTEXT_EVENT = 'LUNATOC_NAV_TRACE_CONTEXT_V1';
export const TRACE_MAIN_EVENT = 'LUNATOC_NAV_TRACE_MAIN_V1';
export const TRACE_SCHEMA_VERSION = 1;
export const TRACE_MAX_EVENTS = 2500;

export type TraceValue = string | number | boolean | null;
export type TraceDetails = Record<string, TraceValue>;
export interface TraceEvent {
  sequence: number;
  timestamp: number;
  jumpId: string | null;
  layer: 'isolated' | 'main';
  event: string;
  details: TraceDetails;
}
export interface TraceSession {
  schemaVersion: number;
  sessionId: string;
  createdAt: string;
  savedAt: string;
  dropped: number;
  events: TraceEvent[];
}

/** Never write message IDs, URLs, DOM text, account IDs, or arbitrary objects. */
const SAFE_KEYS = new Set([
  'index', 'targetIndex', 'edge', 'strategy', 'result', 'reason', 'phase',
  'operation', 'source', 'attempt', 'scrollTop', 'scrollHeight', 'clientHeight',
  'scrollRange', 'targetTop', 'beforeTop', 'afterTop', 'distance',
  'cachedDistance', 'actualDistance', 'cacheError', 'delta', 'rowTop',
  'rowHeight', 'assistantTop', 'assistantHeight', 'assistantVisible',
  'assistantMounted', 'rowMounted', 'rowCount', 'assistantCount',
  'rowsAdded', 'rowsRemoved', 'assistantsAdded', 'assistantsRemoved',
  'aligned', 'visible', 'isReverse', 'handled', 'success', 'hasController',
  'atBottom', 'mountPending', 'anchorActive', 'released', 'timeMs'
]);
const SAFE_STRINGS = new Set(['edge', 'strategy', 'result', 'reason', 'phase', 'operation', 'source']);

export function sanitizeTraceDetails(input: unknown): TraceDetails {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: TraceDetails = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_KEYS.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = Math.round(value * 100) / 100;
    } else if (typeof value === 'boolean' || value === null) {
      result[key] = value;
    } else if (SAFE_STRINGS.has(key) && typeof value === 'string' &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
      result[key] = value;
    }
  }
  return result;
}

export function sanitizeTraceEventName(event: unknown): string | null {
  return typeof event === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(event) ? event : null;
}
