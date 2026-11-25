/**
 * Analysis disclosure matching adapted from the MIT-licensed ChatGPT Black Box
 * by Pinky_and_The_Brain; Chinese version by XiaoXi918.
 * Source: https://greasyfork.org/scripts/606199
 */
export const ANALYSIS_HIDDEN_CLASS = 'luna-toc-analysis-hidden';

const THREAD = '.thread-scroll-container, [data-thread-find-target="conversation"], #thread';
const DISCLOSURE = 'button, [role="button"], summary, [aria-expanded], [data-state]';
const CANDIDATES = `${DISCLOSURE}, [data-testid*="analysis" i], [class*="analysis" i], span, div, p`;
const BODY = '[class*="MarkdownRoot"], .markdown, .prose, [data-markdown-text-style]';
const COMPOSER = '#prompt-textarea, textarea, input, [contenteditable="true"], .ProseMirror, form';
const USER = '[data-message-author-role="user"], [data-user-message-bubble], [class*="group/user-message"]';
const HEADING = /^(?:(?:Stopped thinking|已停止思考|停止思考)[\s:：]*)?(?:Analyzed|Analysis errored|Analysis paused|已分析|分析出错|分析已暂停)$/i;
const STOPPED = /^(?:Stopped thinking|已停止思考|停止思考)$/i;
const START = /^(?:(?:Stopped thinking|已停止思考|停止思考)[\s:：]*)?(?:Analyzed|Analysis errored|Analysis paused|已分析|分析出错|分析已暂停)(?=$|[\s:：,，。；;]|[A-Za-z0-9])/i;
const SIGNAL = /(?:Analyzed|Analysis errored|Analysis paused|Stopped thinking|已分析|分析出错|分析已暂停|已停止思考|停止思考)/i;
const ARTIFACT = /^(?:Result|STDOUT\/STDERR|结果|标准输出\/标准错误|标准输出|标准错误)$/i;

function text(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function label(element: Element): string {
  return (element.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
}

function protectedElement(element: Element): boolean {
  return !!element.closest(`${BODY}, ${COMPOSER}, ${USER}`) ||
    !!element.querySelector(COMPOSER);
}

function heading(element: Element): boolean {
  return HEADING.test(text(element)) || HEADING.test(label(element));
}

function boundary(element: Element, thread: Element): boolean {
  return element === thread || element.matches('[data-testid^="conversation-turn-"], [data-message-author-role]') ||
    !!element.querySelector(`${BODY}, ${USER}, ${COMPOSER}`) ||
    /^(?:You said|ChatGPT said|你说|ChatGPT 说|ChatGPT 回复)\s*[:：]/i.test(text(element));
}

function disclosureTarget(element: Element, thread: Element): Element | null {
  if (!thread.contains(element) || protectedElement(element)) return null;
  let target = element.closest(DISCLOSURE) ?? element;
  if (!thread.contains(target) || protectedElement(target)) return null;
  let best = target;
  // Keep the analysis body and tool result together; stop before a message or progress stream.
  for (let depth = 0; depth < 8 && target.parentElement; depth++) {
    const parent = target.parentElement;
    if (!thread.contains(parent) || boundary(parent, thread) || protectedElement(parent)) break;
    const parentText = text(parent);
    if (!START.test(parentText)) break;
    const hasContents = !!parent.querySelector('pre, code, [data-testid*="tool" i], [class*="tool" i], [class*="analysis" i]');
    const hasHeading = Array.from(parent.querySelectorAll(DISCLOSURE + ', span, p')).some(heading);
    const hasArtifact = Array.from(parent.querySelectorAll('span, p')).some(node => ARTIFACT.test(text(node)));
    if (!hasContents && !hasHeading && !hasArtifact && !HEADING.test(parentText)) break;
    best = target = parent;
  }
  return best;
}

function stoppedTarget(element: Element, thread: Element): Element {
  let target = element;
  for (let depth = 0; depth < 3 && target.parentElement; depth++) {
    const parent = target.parentElement;
    if (!thread.contains(parent) || boundary(parent, thread) || protectedElement(parent) ||
        !STOPPED.test(text(parent))) break;
    target = parent;
  }
  return target;
}

export interface AnalysisVisibilityController {
  start(): void;
  stop(): void;
  scanAll(): number;
  readonly running: boolean;
}

export function createAnalysisVisibilityController(doc: Document = document): AnalysisVisibilityController {
  const view = doc.defaultView;
  if (!view) throw new Error('Analysis visibility requires a browsing context');
  const pageView = view;
  const marked = new Set<Element>();
  let running = false;
  let observer: MutationObserver | null = null;
  let scanTimer: number | null = null;
  let retryTimer: number | null = null;

  function scanAll(): number {
    if (!running) return 0;
    for (const node of marked) if (!node.isConnected) marked.delete(node);
    const thread = doc.querySelector(THREAD);
    if (!thread) return 0;
    let count = 0;
    for (const candidate of thread.querySelectorAll(CANDIDATES)) {
      if (protectedElement(candidate)) continue;
      const isHeading = heading(candidate);
      const isStopped = !isHeading && STOPPED.test(text(candidate));
      if (!isHeading && !isStopped) continue;
      const target = isHeading ? disclosureTarget(candidate, thread) : stoppedTarget(candidate, thread);
      if (!target || boundary(target, thread) || protectedElement(target) ||
          target.classList.contains(ANALYSIS_HIDDEN_CLASS)) continue;
      target.classList.add(ANALYSIS_HIDDEN_CLASS);
      marked.add(target);
      count++;
    }
    return count;
  }

  function hasSignal(node: Node): boolean {
    if (node.nodeType === 3) return SIGNAL.test(node.textContent ?? '') &&
      !!node.parentElement && (heading(node.parentElement) || STOPPED.test(text(node.parentElement)));
    if (node.nodeType !== 1) return false;
    const element = node as Element;
    if (protectedElement(element) || element.matches(COMPOSER)) return false;
    if (heading(element) || STOPPED.test(text(element)) || HEADING.test(label(element))) return true;
    // A mounted card may contain its heading and body as separate descendants.
    if (!SIGNAL.test((element.textContent ?? '').slice(0, 1200))) return false;
    return Array.from(element.querySelectorAll(CANDIDATES)).some(item =>
      !protectedElement(item) && (heading(item) || STOPPED.test(text(item))));
  }

  function scheduleScan(): void {
    if (scanTimer !== null) return; // Leading throttle: streaming updates cannot postpone the scan.
    scanTimer = pageView.setTimeout(() => {
      scanTimer = null;
      if (running) scanAll();
    }, 90);
    if (retryTimer !== null) pageView.clearTimeout(retryTimer);
    retryTimer = pageView.setTimeout(() => {
      retryTimer = null;
      if (running) scanAll();
    }, 280);
  }

  return {
    get running() { return running; },
    scanAll,
    start() {
      if (running) return;
      running = true;
      scanAll();
      observer = new MutationObserver(records => {
        const thread = doc.querySelector(THREAD);
        for (const record of records) {
          const parent = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
          if (!thread || !parent || !thread.contains(parent)) {
            if (record.type === 'childList' && Array.from(record.addedNodes).some(node =>
              node.nodeType === 1 && ((node as Element).matches(THREAD) || !!(node as Element).querySelector(THREAD)))) {
              scheduleScan();
              break;
            }
            continue;
          }
          if (record.type === 'attributes' && hasSignal(parent) ||
              record.type === 'characterData' && hasSignal(record.target) ||
              record.type === 'childList' && (parent.classList.contains(ANALYSIS_HIDDEN_CLASS) ||
                Array.from(record.addedNodes).some(hasSignal))) {
            scheduleScan();
            break;
          }
        }
      });
      observer.observe(doc.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['aria-label', 'aria-expanded', 'data-state'],
      });
    },
    stop() {
      if (!running) return;
      running = false;
      observer?.disconnect();
      observer = null;
      if (scanTimer !== null) pageView.clearTimeout(scanTimer);
      if (retryTimer !== null) pageView.clearTimeout(retryTimer);
      scanTimer = retryTimer = null;
      for (const element of marked) element.classList.remove(ANALYSIS_HIDDEN_CLASS);
      marked.clear();
    },
  };
}
