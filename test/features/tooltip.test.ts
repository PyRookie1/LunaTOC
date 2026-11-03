// @vitest-environment jsdom
/**
 * Tests shared tooltip visibility helpers and private prompt preview behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isElementTextTruncated, previewTooltip } from '@/features/tooltip';

describe('isElementTextTruncated', () => {
  it('returns true when content is wider than the visible element', () => {
    const element = {
      clientWidth: 120,
      scrollWidth: 180,
    } as HTMLElement;

    expect(isElementTextTruncated(element)).toBe(true);
  });

  it('returns false when the full content fits', () => {
    const element = {
      clientWidth: 120,
      scrollWidth: 120,
    } as HTMLElement;

    expect(isElementTextTruncated(element)).toBe(false);
  });
});

describe('previewTooltip privacy', () => {
  let closedRoot: ShadowRoot | null;
  let originalAttachShadow: typeof Element.prototype.attachShadow;

  beforeEach(() => {
    closedRoot = null;
    vi.useFakeTimers();
    originalAttachShadow = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
      this: Element,
      init: ShadowRootInit
    ): ShadowRoot {
      const root = originalAttachShadow.call(this, init);
      if (init.mode === 'closed') closedRoot = root;
      return root;
    });
    previewTooltip.init();
  });

  afterEach(() => {
    previewTooltip.hide();
    vi.runOnlyPendingTimers();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders prompt text only inside a closed shadow root', () => {
    previewTooltip.show(
      { title: 'Private title', content: 'Private prompt body' },
      new MouseEvent('mouseenter', { clientX: 120, clientY: 140 })
    );
    vi.advanceTimersByTime(500);

    const host = document.getElementById('luna-toc-private-preview-host');
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).toBeNull();
    expect(document.body.textContent).not.toContain('Private prompt body');
    expect(closedRoot?.textContent).toContain('Private prompt body');
  });

  it('clears prompt text from the shadow DOM immediately when hidden', () => {
    previewTooltip.show(
      { title: 'Private title', content: 'Private prompt body' },
      new MouseEvent('mouseenter', { clientX: 120, clientY: 140 })
    );
    vi.advanceTimersByTime(500);

    expect(closedRoot?.textContent).toContain('Private prompt body');
    previewTooltip.hide();
    expect(closedRoot?.textContent).not.toContain('Private prompt body');

    vi.advanceTimersByTime(200);
    expect(closedRoot?.querySelector('#luna-toc-preview-tooltip')?.classList.contains(
      'luna-toc-tooltip-visible'
    )).toBe(false);
  });

  it('restores the preview only when the pointer enters its private tooltip during the hide window', () => {
    previewTooltip.show(
      { title: 'Private title', content: 'Private prompt body' },
      new MouseEvent('mouseenter', { clientX: 120, clientY: 140 })
    );
    vi.advanceTimersByTime(500);
    previewTooltip.hide();

    const tooltip = closedRoot?.querySelector('#luna-toc-preview-tooltip');
    tooltip?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(closedRoot?.textContent).toContain('Private prompt body');
  });
});
