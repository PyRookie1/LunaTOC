/**
 * Shared tooltips for LunaTOC:
 * 1. Preview tooltip: For viewing truncated prompt text in the sidebar.
 * 2. Button tooltip: For showing fast, custom floating tooltips on buttons and icons.
 */

// 1. Preview Tooltip Module
export interface PreviewTooltipContent {
  title?: string;
  content?: string;
}

/**
 * Reports whether an element's single-line text exceeds its visible width.
 *
 * @example
 * isElementTextTruncated(document.getElementById('navigator-title')!);
 */
export function isElementTextTruncated(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth;
}

export const previewTooltip = (() => {
  const SHOW_DELAY_MS = 500;
  const HIDE_DELAY_MS = 200;
  const HOST_ID = 'luna-toc-private-preview-host';
  const TOOLTIP_ID = 'luna-toc-preview-tooltip';

  const tooltipStyles = `
    :host {
      position: fixed;
      inset: 0;
      z-index: var(--ct-z-popover, 1020);
      pointer-events: none;
    }

    #${TOOLTIP_ID} {
      position: fixed;
      right: 320px;
      top: 80px;
      box-sizing: border-box;
      width: 380px;
      max-width: calc(100vw - 32px);
      max-height: 60vh;
      overflow-y: auto;
      background: var(--ct-bg-tooltip-preview);
      color: var(--ct-text-tooltip-preview);
      border: 1px solid var(--ct-border-tooltip-preview);
      border-radius: 6px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
      padding: 10px 12px;
      white-space: pre-wrap;
      font-size: 13px;
      line-height: 1.45;
      pointer-events: auto;
      display: none;
    }

    #${TOOLTIP_ID}.luna-toc-tooltip-visible {
      display: block;
    }

    .navigator-preview-tooltip-title {
      font-weight: 600;
      color: var(--ct-text-tooltip-title);
      border-bottom: 1px solid var(--ct-border-tooltip-preview);
      padding-bottom: 6px;
      margin-bottom: 8px;
      font-size: 13px;
    }

    .navigator-preview-tooltip-content {
      white-space: pre-wrap;
      font-size: 12.5px;
      line-height: 1.5;
      color: var(--ct-text-tooltip-content);
    }
  `;

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let anchorSelector: string | null = null;
  let tooltipElement: HTMLDivElement | null = null;
  let activeContent: string | PreviewTooltipContent | null = null;

  function getTooltip(): HTMLDivElement | null {
    return tooltipElement?.isConnected ? tooltipElement : null;
  }

  function create(): void {
    if (getTooltip()) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadowRoot = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = tooltipStyles;
    tooltipElement = document.createElement('div');
    tooltipElement.id = TOOLTIP_ID;
    shadowRoot.append(style, tooltipElement);

    const tooltip = tooltipElement;
    tooltip.addEventListener('mouseenter', () => {
      if (hideTimer === null) return;
      clearTimeout(hideTimer);
      hideTimer = null;
      if (activeContent !== null) {
        renderContent(tooltip, activeContent);
        tooltip.classList.add('luna-toc-tooltip-visible');
      }
    });

    tooltip.addEventListener('mouseleave', hide);
    document.body.appendChild(host);
  }

  function renderContent(
    tooltip: HTMLElement,
    content: string | PreviewTooltipContent
  ): void {
    tooltip.replaceChildren();
    if (typeof content === 'object' && content !== null) {
      if (content.title && content.content) {
        const titleEl = document.createElement('div');
        titleEl.className = 'navigator-preview-tooltip-title';
        titleEl.textContent = content.title;

        const contentEl = document.createElement('div');
        contentEl.className = 'navigator-preview-tooltip-content';
        contentEl.textContent = content.content;

        tooltip.append(titleEl, contentEl);
      }
      return;
    }

    const contentEl = document.createElement('div');
    contentEl.className = 'navigator-preview-tooltip-content';
    contentEl.textContent = content;
    tooltip.appendChild(contentEl);
  }

  /**
   * Creates the isolated preview surface. The host is visible to the page,
   * but its closed shadow root and prompt text are not traversable by page JS.
   */
  function init(options: { anchorSelector?: string } = {}): void {
    anchorSelector = options.anchorSelector || null;
    create();
  }

  /**
   * Shows a tooltip with the full prompt text near the hovered row.
   */
  function show(
    text: string | PreviewTooltipContent,
    event: MouseEvent,
    anchorElement?: HTMLElement
  ): void {
    create();
    const tooltip = getTooltip();
    if (!tooltip) return;

    if (hideTimer !== null) clearTimeout(hideTimer);
    if (showTimer !== null) clearTimeout(showTimer);
    hideTimer = null;
    showTimer = null;
    activeContent = text;
    tooltip.classList.remove('luna-toc-tooltip-visible');

    const clientX = event.clientX;
    const clientY = event.clientY;

    showTimer = setTimeout(() => {
      if (activeContent !== text) return;
      renderContent(tooltip, text);
      tooltip.classList.add('luna-toc-tooltip-visible');
      positionTooltip(tooltip, clientX, clientY, anchorElement);
    }, SHOW_DELAY_MS);
  }

  /**
   * Removes prompt text from the DOM immediately. A short hide window is
   * retained so pointer transitions into the tooltip can restore it safely.
   */
  function hide(): void {
    if (hideTimer !== null) clearTimeout(hideTimer);
    if (showTimer !== null) clearTimeout(showTimer);
    showTimer = null;

    const tooltip = getTooltip();
    if (!tooltip) {
      activeContent = null;
      return;
    }

    tooltip.replaceChildren();
    hideTimer = setTimeout(() => {
      tooltip.classList.remove('luna-toc-tooltip-visible');
      activeContent = null;
      hideTimer = null;
    }, HIDE_DELAY_MS);
  }

  function positionTooltip(
    tooltip: HTMLElement,
    clientX: number,
    clientY: number,
    anchorElement?: HTMLElement
  ): void {
    const gap = 8;
    const margin = 16;
    const anchor = anchorSelector
      ? document.querySelector(anchorSelector)
      : null;
    const anchorRect = anchor?.getBoundingClientRect();
    const tooltipAnchorRect = anchorElement?.getBoundingClientRect();

    let y = tooltipAnchorRect ? tooltipAnchorRect.top + 4 : clientY + 15;

    const rect = tooltip.getBoundingClientRect();
    const x = anchorRect
      ? Math.max(margin, anchorRect.left - rect.width - gap)
      : Math.max(margin, clientX - rect.width - gap);

    y = Math.max(margin, y);
    if (y + rect.height > window.innerHeight) {
      y = window.innerHeight - rect.height - margin;
    }

    tooltip.style.left = `${x}px`;
    tooltip.style.right = 'auto';
    tooltip.style.top = `${y}px`;
  }

  return {
    hide,
    init,
    show,
  };
})();

// 2. Button/Icon Label Tooltip Module
export const buttonTooltip = (() => {
  let tooltipElement: HTMLDivElement | null = null;
  let activeTarget: HTMLElement | null = null;

  /**
   * Creates the button tooltip element.
   */
  function create(): void {
    if (document.getElementById('luna-toc-button-tooltip')) return;

    tooltipElement = document.createElement('div');
    tooltipElement.id = 'luna-toc-button-tooltip';
    document.documentElement.appendChild(tooltipElement);
  }

  /**
   * Sets up event delegation for button tooltips.
   */
  function init(): void {
    create();

    // Listen globally for mouseover to implement instant popup
    document.body.addEventListener('mouseover', (event) => {
      const target = getClosestElement(event, '[title], [data-tooltip]');
      if (!target) {
        if (activeTarget) {
          hide();
          activeTarget = null;
        }
        return;
      }

      // Ignore elements outside our extension sidebar and toggle buttons
      const isInsideSidebar = target.closest('#luna-toc-sidebar');
      const isSidebarToggle = target.closest('#luna-toc-toggle-btn');
      const isControls = target.closest('.navigator-jump-controls');
      if (!isInsideSidebar && !isSidebarToggle && !isControls) return;

      if (
        target.dataset.tooltipOverflowOnly === 'true' &&
        !isElementTextTruncated(target)
      ) {
        if (activeTarget) hide();
        activeTarget = null;
        return;
      }

      if (target === activeTarget) return;
      activeTarget = target;

      // Extract title and convert to data-tooltip to disable native slow tooltip
      if (target.hasAttribute('title')) {
        const titleText = target.getAttribute('title');
        if (titleText) target.setAttribute('data-tooltip', titleText);
        target.removeAttribute('title');
      }

      const text = target.getAttribute('data-tooltip');
      if (!text) return;

      show(target, text);
    });

    document.body.addEventListener('mouseout', (event) => {
      const target = getClosestElement(event, '[data-tooltip]');
      if (target && target === activeTarget) {
        hide();
        activeTarget = null;
      }
    });

    // Instantly hide tooltip if the user clicks the button
    document.body.addEventListener('click', (event) => {
      const target = getClosestElement(event, '[data-tooltip]');
      if (target) {
        hide();
        activeTarget = null;
      }
    });
  }

  /**
   * Shows the button tooltip instantly.
   * @param {HTMLElement} element
   * @param {string} text
   */
  function show(element: HTMLElement, text: string): void {
    if (!tooltipElement) create();

    if (!tooltipElement) return;

    tooltipElement.textContent = text;
    tooltipElement.classList.add('luna-toc-tooltip-visible');

    positionTooltip(element);
  }

  /**
   * Hides the button tooltip instantly.
   */
  function hide(): void {
    if (tooltipElement) {
      tooltipElement.classList.remove('luna-toc-tooltip-visible');
    }
  }

  /**
   * Positions the button tooltip relative to its trigger element.
   * @param {HTMLElement} element
   */
  function positionTooltip(element: HTMLElement): void {
    if (!tooltipElement) return;
    const rect = element.getBoundingClientRect();
    const tooltipRect = tooltipElement.getBoundingClientRect();
    const gap = 6;

    let x = 0;
    let y = 0;

    // Check for custom position overrides, or fallback to auto-positioning
    let position = element.getAttribute('data-tooltip-position');
    if (!position) {
      if (rect.right > window.innerWidth - 60) {
        // Near right edge of screen (floating controls)
        position = 'left';
      } else if (rect.top < 60) {
        // Near top of sidebar (header buttons)
        position = 'bottom';
      } else {
        // Default (list items, etc.)
        position = 'top';
      }
    }

    if (position === 'left') {
      x = rect.left - tooltipRect.width - gap;
      y = rect.top + (rect.height - tooltipRect.height) / 2;
    } else if (position === 'bottom') {
      x = rect.left + (rect.width - tooltipRect.width) / 2;
      y = rect.bottom + gap;
    } else {
      // 'top'
      x = rect.left + (rect.width - tooltipRect.width) / 2;
      y = rect.top - tooltipRect.height - gap;
    }

    // Keep tooltip inside screen boundaries
    x = Math.max(8, Math.min(x, window.innerWidth - tooltipRect.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - tooltipRect.height - 8));

    tooltipElement.style.left = `${x}px`;
    tooltipElement.style.top = `${y}px`;
  }

  function getClosestElement(
    event: Event,
    selector: string
  ): HTMLElement | null {
    return event.target instanceof Element
      ? event.target.closest<HTMLElement>(selector)
      : null;
  }

  return {
    init,
    hide,
  };
})();
