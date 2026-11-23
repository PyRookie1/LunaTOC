import { describe, expect, it } from 'vitest';
import {
  sanitizeTraceDetails, sanitizeTraceEventName, TRACE_MAX_EVENTS,
} from '@/features/navigationTrace/traceProtocol';

describe('navigation trace privacy contract', () => {
  it('removes arbitrary identifiers and message content', () => {
    expect(sanitizeTraceDetails({
      messageId: 'private-message-id', url: 'https://chatgpt.com/c/private',
      text: 'secret', html: '<div>secret</div>',
      scrollTop: 124.234, assistantMounted: false, reason: 'native_ready',
    })).toEqual({
      scrollTop: 124.23, assistantMounted: false, reason: 'native_ready',
    });
  });
  it('rejects unbounded strings and non-finite numbers', () => {
    expect(sanitizeTraceDetails({
      reason: 'private conversation title with spaces',
      scrollTop: Infinity, cachedDistance: NaN,
      targetIndex: 2, edge: 'top',
    })).toEqual({ targetIndex: 2, edge: 'top' });
  });
  it('only permits bounded event names and buffers', () => {
    expect(sanitizeTraceEventName('assistant-unmounted')).toBe('assistant-unmounted');
    expect(sanitizeTraceEventName('user response private')).toBeNull();
    expect(TRACE_MAX_EVENTS).toBe(2500);
  });
});
