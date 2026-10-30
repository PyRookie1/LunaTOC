/**
 * Repairs only unrendered Markdown bold delimiters inside ChatGPT assistant
 * Markdown containers. It never reparses HTML or changes the source response.
 */
const ASSISTANT_SELECTOR =
  '[data-chatgpt-search-unit-key$=":assistant"], [data-message-author-role="assistant"]';
const MARKDOWN_SELECTOR = '.markdown';
const BACKTICK = String.fromCharCode(96);
const SKIP_TEXT_SELECTOR = [
  'pre',
  'code',
  'kbd',
  'samp',
  'script',
  'style',
  'textarea',
  'input',
  'button',
  'svg',
  'math',
  'strong',
  'b',
  '[contenteditable="true"]',
  '[role="math"]',
  '[data-luna-toc-markdown-bold]',
  '.katex',
  '.MathJax',
  '.math',
  '.math-inline',
  '.math-block',
].join(',');

export interface MarkdownBoldSegment {
  text: string;
  bold: boolean;
}

export function startMarkdownBoldRepair(
  root: Document = document
): () => void {
  repairMountedAssistantResponses(root);

  const observer = new MutationObserver((mutations) => {
    const pending = new Set<Text>();

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        if (mutation.target.nodeType === Node.TEXT_NODE) {
          const textNode = mutation.target as Text;
          if (isEligibleTextNode(textNode)) pending.add(textNode);
        }
        continue;
      }

      if (mutation.type !== 'childList') continue;

      for (const addedNode of Array.from(mutation.addedNodes)) {
        collectChangedNode(addedNode, pending);
      }
    }

    for (const textNode of pending) {
      repairMarkdownBoldTextNode(textNode);
    }
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // document_start may run before the HTML parser has attached all answer nodes.
  // A one-time scan after parsing closes that gap even if parser insertions were
  // not observable in the initial mutation stream.
  const repairAfterInitialDocumentParse = () =>
    repairMountedAssistantResponses(root);
  if (root.readyState === 'loading') {
    root.addEventListener('DOMContentLoaded', repairAfterInitialDocumentParse, {
      once: true,
    });
  }

  return () => {
    observer.disconnect();
    root.removeEventListener('DOMContentLoaded', repairAfterInitialDocumentParse);
  };
}

export function repairMarkdownBoldTextNode(textNode: Text): boolean {
  const original = textNode.data;
  if (!original.includes('**') || !isEligibleTextNode(textNode)) return false;

  const segments = parseUnrenderedBoldMarkdown(original);
  if (!segments) return false;

  const fragment = textNode.ownerDocument.createDocumentFragment();

  for (const segment of segments) {
    if (!segment.bold) {
      fragment.appendChild(textNode.ownerDocument.createTextNode(segment.text));
      continue;
    }

    const strong = textNode.ownerDocument.createElement('strong');
    strong.dataset.lunaTocMarkdownBold = 'true';
    strong.textContent = segment.text;
    fragment.appendChild(strong);
  }

  textNode.replaceWith(fragment);
  return true;
}

/**
 * Scan bold markers once, without restarting a search from each unmatched
 * opener. A later delimiter supersedes an earlier unclosed opener, which
 * preserves the existing behavior for nested/malformed marker sequences.
 */
export function parseUnrenderedBoldMarkdown(
  text: string
): MarkdownBoldSegment[] | null {
  const segments: MarkdownBoldSegment[] = [];
  const codeSpanEnds = findAllCodeSpanEnds(text);
  const mathSpanEnds = indexMathSpanEnds(text);
  let plainStart = 0;
  let index = 0;
  let openingIndex = -1;
  let foundBold = false;

  while (index < text.length) {
    const mathEnd = mathSpanEnds.get(index);
    if (mathEnd !== undefined) {
      index = mathEnd;
      continue;
    }
    if (text[index] === '\\') {
      index += Math.min(2, text.length - index);
      continue;
    }

    if (text[index] === BACKTICK) {
      const runLength = countRun(text, index, BACKTICK);
      const codeEnd = codeSpanEnds.get(index) ?? -1;
      index = codeEnd === -1 ? index + runLength : codeEnd;
      continue;
    }

    if (!isDoubleStarDelimiter(text, index)) {
      index += 1;
      continue;
    }

    if (openingIndex !== -1 && !isWhitespace(text[index - 1])) {
      const content = text.slice(openingIndex + 2, index);
      if (isValidBoldContent(content) &&
          !containsCodeSpan(content) && !containsMathSyntax(content)) {
        if (openingIndex > plainStart) {
          segments.push({ text: text.slice(plainStart, openingIndex), bold: false });
        }
        segments.push({ text: content, bold: true });
        foundBold = true;
        index += 2;
        plainStart = index;
        openingIndex = -1;
        continue;
      }
    }

    // Every unmatched marker invalidates the earlier candidate. It may
    // itself start a new pair, unless the next character is whitespace.
    openingIndex = isWhitespace(text[index + 2]) ? -1 : index;
    index += 2;
  }

  if (!foundBold) return null;
  if (plainStart < text.length) {
    segments.push({ text: text.slice(plainStart), bold: false });
  }
  return segments;
}

function repairMountedAssistantResponses(root: Node): void {
  const pending = new Set<Text>();

  for (const assistantRoot of findAssistantRoots(root)) {
    collectOwnedMarkdownTextNodes(assistantRoot, pending);
  }

  for (const textNode of pending) {
    repairMarkdownBoldTextNode(textNode);
  }
}

function collectChangedNode(node: Node, pending: Set<Text>): void {
  const assistantRoots = findAssistantRoots(node);

  for (const assistantRoot of assistantRoots) {
    collectOwnedMarkdownTextNodes(assistantRoot, pending);
  }

  const owner = findNearestAssistantRoot(node);
  if (owner && isWithinOwnedMarkdown(node, owner)) {
    collectEligibleTextNodes(node, pending);
  }
}

function findAssistantRoots(root: Node): HTMLElement[] {
  const roots: HTMLElement[] = [];

  if (
    root.nodeType === Node.ELEMENT_NODE &&
    (root as Element).matches(ASSISTANT_SELECTOR)
  ) {
    roots.push(root as HTMLElement);
  }

  const queryable = root as Node & ParentNode;
  if (typeof queryable.querySelectorAll === 'function') {
    roots.push(
      ...queryable.querySelectorAll<HTMLElement>(ASSISTANT_SELECTOR)
    );
  }

  return Array.from(new Set(roots));
}

function collectOwnedMarkdownTextNodes(
  assistantRoot: HTMLElement,
  pending: Set<Text>
): void {
  const containers = Array.from(
    assistantRoot.querySelectorAll<HTMLElement>(MARKDOWN_SELECTOR)
  ).filter((container) => {
    const owner = findNearestAssistantRoot(container);
    const nestedMarkdown = container.parentElement?.closest(MARKDOWN_SELECTOR);
    return owner === assistantRoot && !nestedMarkdown;
  });

  for (const container of containers) {
    collectEligibleTextNodes(container, pending);
  }
}

function collectEligibleTextNodes(node: Node, pending: Set<Text>): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    if (isEligibleTextNode(textNode)) pending.add(textNode);
    return;
  }

  if (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).matches(SKIP_TEXT_SELECTOR)
  ) {
    return;
  }

  for (const child of Array.from(node.childNodes)) {
    collectEligibleTextNodes(child, pending);
  }
}

function isEligibleTextNode(textNode: Text): boolean {
  if (!textNode.isConnected || !textNode.data.includes('**')) return false;

  const owner = findNearestAssistantRoot(textNode);
  if (!owner || !isWithinOwnedMarkdown(textNode, owner)) return false;

  let current = textNode.parentElement;
  while (current && current !== owner) {
    if (current.matches(SKIP_TEXT_SELECTOR)) return false;
    current = current.parentElement;
  }

  return true;
}

function findNearestAssistantRoot(node: Node): HTMLElement | null {
  let current =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;

  while (current) {
    if (current.matches(ASSISTANT_SELECTOR)) return current as HTMLElement;
    current = current.parentElement;
  }

  return null;
}

function isWithinOwnedMarkdown(node: Node, owner: HTMLElement): boolean {
  let current =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  let insideMarkdown = false;

  while (current) {
    if (current.matches(MARKDOWN_SELECTOR)) insideMarkdown = true;
    if (current.matches(ASSISTANT_SELECTOR)) {
      return current === owner && insideMarkdown;
    }
    current = current.parentElement;
  }

  return false;
}

/**
 * Keep paired inline or display math delimiters opaque to bold repair.
 * Prose bold markers in the same text node can still be repaired.
 */
/**
 * Find math delimiters once. Sorted lists and binary lookups avoid scanning
 * an entire unfinished expression for every repeated '$' or '\\(' opener.
 */
function indexMathSpanEnds(text: string): Map<number, number> {
  const inlineClosers: number[] = [];
  const displayClosers: number[] = [];
  const parenClosers: number[] = [];
  const bracketClosers: number[] = [];
  const linebreaks: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') linebreaks.push(index);
    if (text.startsWith('$$', index)) displayClosers.push(index);
    if (text[index] === '$' && !isEscapedAt(text, index) &&
        !isWhitespace(text[index - 1])) inlineClosers.push(index);
    if (text.startsWith('\\)', index)) parenClosers.push(index);
    if (text.startsWith('\\]', index)) bracketClosers.push(index);
  }

  const firstAfter = (indices: number[], minimum: number): number => {
    let low = 0;
    let high = indices.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (indices[mid] < minimum) low = mid + 1;
      else high = mid;
    }
    return low < indices.length ? indices[low] : -1;
  };

  const spans = new Map<number, number>();
  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith('\\(', index) || text.startsWith('\\[', index)) {
      if (isEscapedAt(text, index)) continue;
      const closes = text[index + 1] === '(' ? parenClosers : bracketClosers;
      const end = firstAfter(closes, index + 3);
      if (end !== -1) spans.set(index, end + 2);
      continue;
    }
    if (text[index] !== '$' || isEscapedAt(text, index)) continue;
    if (text.startsWith('$$', index)) {
      const end = firstAfter(displayClosers, index + 2);
      if (end > index + 2) spans.set(index, end + 2);
      continue;
    }
    if (text[index + 1] === '$' || isWhitespace(text[index + 1])) continue;
    const end = firstAfter(inlineClosers, index + 2);
    const linebreak = firstAfter(linebreaks, index + 1);
    if (end !== -1 && (linebreak === -1 || end < linebreak)) {
      spans.set(index, end + 1);
    }
  }
  return spans;
}

function isValidBoldContent(content: string): boolean {
  return (
    content.length > 0 &&
    !isWhitespace(content[0]) &&
    !isWhitespace(content[content.length - 1])
  );
}

function isDoubleStarDelimiter(text: string, index: number): boolean {
  return (
    text.startsWith('**', index) &&
    text[index - 1] !== '*' &&
    text[index + 2] !== '*' &&
    !isEscapedAt(text, index)
  );
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
    backslashes += 1;
  }

  return backslashes % 2 === 1;
}

function isWhitespace(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

function countRun(text: string, start: number, character: string): number {
  let end = start;
  while (end < text.length && text[end] === character) end += 1;
  return end - start;
}

/**
 * Index matching backtick runs from right to left. A lookup is constant-time,
 * even if thousands of runs have no partner.
 */
function findAllCodeSpanEnds(text: string): Map<number, number> {
  const runs: Array<{ start: number; length: number }> = [];
  for (let index = 0; index < text.length;) {
    if (text[index] !== BACKTICK) {
      index += 1;
      continue;
    }
    const length = countRun(text, index, BACKTICK);
    runs.push({ start: index, length });
    index += length;
  }

  const nextByLength = new Map<number, number>();
  const ends = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    const next = nextByLength.get(run.length);
    if (next !== undefined) ends.set(run.start, next + run.length);
    nextByLength.set(run.length, run.start);
  }
  return ends;
}

function containsCodeSpan(text: string): boolean {
  return findAllCodeSpanEnds(text).size > 0;
}

function containsMathSyntax(text: string): boolean {
  return indexMathSpanEnds(text).size > 0;
}
