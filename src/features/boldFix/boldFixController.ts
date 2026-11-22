/**
 * DOM repair engine migrated from the MIT-licensed
 * "ChatGPT粗体异常修复" userscript (v1.0.0).
 *
 * This module deliberately has no import-time side effects. The content-script
 * lifecycle will own when the controller is started and stopped.
 */

const MESSAGE =
  '[data-markdown-text-style="assistant-message"],[data-message-author-role="assistant"]';
const FALLBACK_BODY = '.markdown,.prose';
const USER = '[data-message-author-role="user"],[data-user-message-bubble]';
const BLOCK = 'p,li,blockquote,td,th,h1,h2,h3,h4,h5,h6,dd,dt,figcaption';
const CODE = 'code,[data-markdown-copy="inline-code"]';
const SKIP =
  'pre,script,style,textarea,input,select,kbd,samp,math,svg,button,[role="button"],' +
  '[contenteditable]:not([contenteditable="false"]),[data-chatgpt-md-fix-skip],[data-chatgpt-md-fix]';

type BoldRange = [number, number];

interface TextSegment {
  node?: Text;
  element?: HTMLElement;
  start: number;
  end: number;
}

interface TextView {
  text: string;
  segments: TextSegment[];
}

interface TextPatch {
  original: string;
  rendered: HTMLSpanElement;
  updated: boolean;
  owner: Element;
}

interface CodeStylePatch {
  original: string;
  applied: string;
  owner: Element;
}

export interface BoldFixController {
  /** Starts observing the page and performs an initial full scan. */
  start(): void;
  /** Stops observing and restores all changes still owned by this controller. */
  stop(): void;
  /** Re-runs the full scan while the controller is running. */
  scanAll(): number;
  readonly running: boolean;
}

/**
 * Creates an isolated bold-repair controller for one document.
 *
 * The implementation preserves the userscript's matching, range calculation,
 * exclusion selectors, DOM patch tracking, incremental observer handling and
 * restore safeguards. It does not subscribe to route changes or read settings;
 * those belong to the next integration stage.
 */
export function createBoldFixController(doc: Document = document): BoldFixController {
  const view = doc.defaultView;
  if (!view) {
    throw new Error('Bold repair requires a document with a browsing context.');
  }

  const patches = new Map<Text, TextPatch>();
  const codeStyles = new Map<HTMLElement, CodeStylePatch>();
  const pendingMessages = new Set<Element>();
  const watch: MutationObserverInit = {
    childList: true,
    subtree: true,
    characterData: true,
  };

  let boldTimer: number | null = null;
  let isRunning = false;

  function conversationRoot(): Element | null {
    return (
      doc.querySelector('[data-thread-find-target="conversation"]') ||
      doc.querySelector('#thread') ||
      doc.querySelector('main') ||
      doc.body ||
      doc.documentElement
    );
  }

  function nodeElement(node: Node): Element | null {
    if (node instanceof view.Element) {
      return node;
    }
    return node.parentElement instanceof view.Element ? node.parentElement : null;
  }

  function assistantRoots(): Element[] {
    const scope = conversationRoot();
    if (!scope) return [];

    let found = Array.from(scope.querySelectorAll<Element>(MESSAGE));
    if (scope.matches(MESSAGE)) found.unshift(scope);
    found = found.filter((element) => !element.closest(USER));

    if (!found.length) {
      found = Array.from(scope.querySelectorAll<Element>(FALLBACK_BODY));
      if (scope.matches(FALLBACK_BODY)) found.unshift(scope);
      found = found.filter(
        (element) => !element.closest(USER) && !element.closest(SKIP)
      );
    }

    return found.filter(
      (element) =>
        !found.some((other) => other !== element && other.contains(element))
    );
  }

  function messageOwner(node: Node): Element | null {
    const element = nodeElement(node);
    const scope = conversationRoot();

    if (
      !element ||
      !scope ||
      !scope.contains(element) ||
      element.closest(USER)
    ) {
      return null;
    }

    let owner: Element | null = null;
    for (
      let current: Element | null = element;
      current && scope.contains(current);
      current = current.parentElement
    ) {
      if (current.matches(MESSAGE)) owner = current;
    }
    if (owner) return owner;

    for (
      let current: Element | null = element;
      current && scope.contains(current);
      current = current.parentElement
    ) {
      if (current.matches(FALLBACK_BODY) && !current.closest(SKIP)) {
        owner = current;
      }
    }
    return owner;
  }

  function collectOwnersFromNode(node: Node, output: Set<Element>): void {
    if (!(node instanceof view.Element)) return;

    const direct = messageOwner(node);
    if (direct) output.add(direct);

    const selectors = MESSAGE + ',' + FALLBACK_BODY;
    for (const candidate of node.querySelectorAll<Element>(selectors)) {
      const owner = messageOwner(candidate);
      if (owner) output.add(owner);
    }
  }

  function collectOwnersFromRecords(
    records: MutationRecord[],
    output: Set<Element>
  ): void {
    for (const record of records) {
      if (record.type === 'characterData') {
        const owner = messageOwner(record.target);
        if (owner) output.add(owner);
      } else if (record.type === 'childList') {
        const owner = messageOwner(record.target);
        if (owner) output.add(owner);

        for (const node of record.addedNodes) {
          collectOwnersFromNode(node, output);
        }
      }
    }
  }

  function rememberUpdates(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type !== 'characterData') continue;
      const patch = patches.get(record.target as Text);
      if (patch) patch.updated = true;
    }
  }

  function restoreOwner(owner: Element): void {
    for (const [node, patch] of patches) {
      if (patch.owner !== owner) continue;

      patch.rendered.remove();
      if (!patch.updated) node.data = patch.original;
      patches.delete(node);
    }

    for (const [element, style] of codeStyles) {
      if (style.owner !== owner) continue;

      if (element.style.fontWeight === style.applied) {
        element.style.fontWeight = style.original;
      }
      codeStyles.delete(element);
    }
  }

  function restoreAll(): void {
    for (const [node, patch] of patches) {
      patch.rendered.remove();
      if (!patch.updated) node.data = patch.original;
    }
    patches.clear();

    for (const [element, style] of codeStyles) {
      if (element.style.fontWeight === style.applied) {
        element.style.fontWeight = style.original;
      }
    }
    codeStyles.clear();
  }

  function cleanupDetached(): void {
    const scope = conversationRoot();
    const detached = new Set<Element>();

    for (const patch of patches.values()) {
      if (!patch.owner.isConnected || !scope?.contains(patch.owner)) {
        detached.add(patch.owner);
      }
    }
    for (const style of codeStyles.values()) {
      if (!style.owner.isConnected || !scope?.contains(style.owner)) {
        detached.add(style.owner);
      }
    }
    for (const owner of detached) restoreOwner(owner);
  }

  function textView(scope: Element): TextView {
    let text = '';
    const segments: TextSegment[] = [];

    function visit(node: Node): void {
      if (node.nodeType === view.Node.TEXT_NODE) {
        const textNode = node as Text;
        const start = text.length;
        text += textNode.data;
        segments.push({ node: textNode, start, end: text.length });
        return;
      }

      if (node.nodeType !== view.Node.ELEMENT_NODE) return;

      const element = node as Element;
      if (
        element.matches(SKIP + ',' + USER) ||
        (element !== scope && element.matches(BLOCK))
      ) {
        text += '\0';
      } else if (element.matches(CODE)) {
        segments.push({
          element: element as HTMLElement,
          start: text.length,
          end: text.length + 1,
        });
        text += '\ufffc';
      } else if (element.tagName === 'BR') {
        text += '\n';
      } else {
        element.childNodes.forEach(visit);
      }
    }

    visit(scope);
    return { text, segments };
  }

  function pairs(text: string): BoldRange[] {
    const result: BoldRange[] = [];
    let open = -1;
    const blank = (character: string | undefined): boolean =>
      !character || /[\s\0]/u.test(character);

    for (
      let index = text.indexOf('**');
      index !== -1;
      index = text.indexOf('**', index + 2)
    ) {
      let slashes = 0;
      for (
        let cursor = index - 1;
        cursor >= 0 && text[cursor] === '\\';
        cursor--
      ) {
        slashes++;
      }

      if (
        slashes % 2 ||
        text[index - 1] === '*' ||
        text[index + 2] === '*'
      ) {
        continue;
      }

      if (
        open !== -1 &&
        text.slice(open + 2, index).includes('\0')
      ) {
        open = -1;
      }

      if (open !== -1 && index > open + 2 && !blank(text[index - 1])) {
        result.push([open, index]);
        open = -1;
      } else if (open === -1 && !blank(text[index + 2])) {
        open = index;
      }
    }

    return result;
  }

  function trailingNativeMarker(
    text: string,
    segments: TextSegment[],
    scope: Element
  ): BoldRange | null {
    if (!text.endsWith('**') || text.slice(0, -2).includes('*')) {
      return null;
    }

    const start = text.length - 2;
    const tail = [...segments]
      .reverse()
      .find((segment) => segment.node && segment.end === text.length);

    if (!tail?.node || !tail.node.data.endsWith('**')) return null;

    let slashes = 0;
    for (
      let index = tail.node.data.length - 3;
      index >= 0 && tail.node.data[index] === '\\';
      index--
    ) {
      slashes++;
    }

    if (
      slashes % 2 ||
      !text[start - 1] ||
      /[\s*]/u.test(text[start - 1])
    ) {
      return null;
    }

    const tailParent = tail.node.parentElement;
    if (!tailParent?.closest('strong,b')) return null;
    if (!scope.matches('strong,b') && !scope.querySelector('strong,b')) {
      return null;
    }

    const contentSegments = segments.filter((segment) => {
      const end = Math.min(segment.end, start);
      return text.slice(segment.start, end).trim().length > 0;
    });
    if (!contentSegments.length) return null;

    const allNative = contentSegments.every((segment) => {
      const element = segment.element || segment.node?.parentElement;
      return !!element?.closest('strong,b,em,i');
    });

    return allNative ? [start, text.length] : null;
  }

  function repair(scope: Element, owner: Element): number {
    if (scope.closest(SKIP + ',' + CODE + ',' + USER)) return 0;

    const { text, segments } = textView(scope);
    if (!text) return 0;

    const matches = pairs(text);
    const boldRanges: BoldRange[] = matches.map(
      ([start, end]) => [start + 2, end]
    );
    const removed: BoldRange[] = matches.flatMap(([start, end]) => [
      [start, start + 2] as BoldRange,
      [end, end + 2] as BoldRange,
    ]);

    let extraFixes = 0;
    for (const segment of segments) {
      if (!segment.node?.parentElement?.closest('strong,b')) continue;

      for (const match of segment.node.data.matchAll(/([^\s*])(\*{4})(?=[^\s*])/g)) {
        const starStart = (match.index ?? 0) + match[1].length;
        let slashes = 0;
        for (
          let index = starStart - 1;
          index >= 0 && segment.node.data[index] === '\\';
          index--
        ) {
          slashes++;
        }
        if (slashes % 2) continue;

        const at = segment.start + starStart;
        removed.push([at, at + 4]);
        extraFixes++;
      }
    }

    if (!matches.length) {
      const tail = trailingNativeMarker(text, segments, scope);
      if (tail) {
        removed.push(tail);
        extraFixes++;
      }
    }

    const inside = (ranges: BoldRange[], at: number): boolean =>
      ranges.some(([start, end]) => at >= start && at < end);

    for (const segment of segments) {
      if (segment.element) {
        if (inside(boldRanges, segment.start)) {
          if (!codeStyles.has(segment.element)) {
            codeStyles.set(segment.element, {
              original: segment.element.style.fontWeight,
              applied: '600',
              owner,
            });
          }
          segment.element.style.fontWeight = '600';
        }
        continue;
      }

      const node = segment.node;
      if (!node || segment.end <= segment.start) continue;

      const cuts = [
        segment.start,
        segment.end,
        ...[...boldRanges, ...removed]
          .flat()
          .filter((value) => value > segment.start && value < segment.end),
      ]
        .filter((value, index, array) => array.indexOf(value) === index)
        .sort((left, right) => left - right);

      const rendered = doc.createElement('span');
      rendered.dataset.chatgptMdFix = 'text';
      let changed = false;

      for (let index = 0; index < cuts.length - 1; index++) {
        const at = cuts[index];
        const value = text.slice(at, cuts[index + 1]);

        if (inside(removed, at)) {
          changed = true;
          continue;
        }

        if (inside(boldRanges, at) && !node.parentElement?.closest('strong,b')) {
          const strong = doc.createElement('strong');
          strong.dataset.chatgptMdFix = 'bold';
          strong.style.fontWeight = '600';
          strong.textContent = value;
          rendered.append(strong);
          changed = true;
        } else {
          rendered.append(value);
        }
      }

      if (changed) {
        patches.set(node, {
          original: node.data,
          rendered,
          updated: false,
          owner,
        });
        node.data = '';
        node.after(rendered);
      }
    }

    return matches.length + extraFixes;
  }

  function scanOwnerContent(owner: Element): number {
    let count = 0;
    const scopes = [...owner.querySelectorAll<Element>(BLOCK), owner];
    for (const scope of scopes) count += repair(scope, owner);
    return count;
  }

  function pauseObserver(): void {
    const pending = observer.takeRecords();
    rememberUpdates(pending);
    observer.disconnect();
  }

  function resumeObserver(): void {
    if (isRunning && doc.documentElement) {
      observer.observe(doc.documentElement, watch);
    }
  }

  function clearBoldTimer(): void {
    if (boldTimer !== null) {
      view.clearTimeout(boldTimer);
      boldTimer = null;
    }
  }

  function scanAll(): number {
    if (!isRunning) return 0;

    clearBoldTimer();
    pendingMessages.clear();
    pauseObserver();

    let count = 0;
    try {
      restoreAll();
      for (const owner of assistantRoots()) {
        count += scanOwnerContent(owner);
      }
    } finally {
      resumeObserver();
    }
    return count;
  }

  function cleanupAndFlush(): void {
    if (!isRunning) return;
    boldTimer = null;

    const pending = observer.takeRecords();
    rememberUpdates(pending);
    collectOwnersFromRecords(pending, pendingMessages);

    const owners = [...pendingMessages];
    pendingMessages.clear();

    if (!owners.length) {
      cleanupDetached();
      return;
    }

    observer.disconnect();
    try {
      for (const owner of owners) {
        restoreOwner(owner);
        const scope = conversationRoot();
        if (owner.isConnected && scope?.contains(owner)) {
          scanOwnerContent(owner);
        }
      }
      cleanupDetached();
    } finally {
      resumeObserver();
    }
  }

  function scheduleBold(): void {
    if (!isRunning) return;
    clearBoldTimer();
    boldTimer = view.setTimeout(cleanupAndFlush, 120);
  }

  const observer = new view.MutationObserver((records) => {
    if (!isRunning) return;

    rememberUpdates(records);
    collectOwnersFromRecords(records, pendingMessages);
    if (pendingMessages.size) scheduleBold();
    cleanupDetached();
  });

  function start(): void {
    if (isRunning) return;
    isRunning = true;
    if (doc.documentElement) observer.observe(doc.documentElement, watch);
    scanAll();
  }

  function stop(): void {
    if (!isRunning) return;

    clearBoldTimer();
    rememberUpdates(observer.takeRecords());
    observer.disconnect();
    isRunning = false;
    pendingMessages.clear();
    restoreAll();
  }

  return {
    start,
    stop,
    scanAll,
    get running(): boolean {
      return isRunning;
    },
  };
}
