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
  let plainStart = 0;
  let index = 0;
  let openingIndex = -1;
  let foundBold = false;

  while (index < text.length) {
    if (text[index] === '\\') {
      index += Math.min(2, text.length - index);
      continue;
    }

    if (text[index] === BACKTICK) {
      const runLength = countRun(text, index, BACKTICK);
      const codeEnd = findCodeSpanEnd(text, index, runLength);
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

function findCodeSpanEnd(
  text: string,
  start: number,
  delimiterLength: number
): number {
  let index = start + delimiterLength;

  while (index < text.length) {
    if (text[index] !== BACKTICK) {
      index += 1;
      continue;
    }

    const runLength = countRun(text, index, BACKTICK);
    if (runLength === delimiterLength) return index + runLength;
    index += runLength;
  }

  return -1;
}

function containsCodeSpan(text: string): boolean {
  let index = 0;

  while (index < text.length) {
    if (text[index] !== BACKTICK) {
      index += 1;
      continue;
    }

    const runLength = countRun(text, index, BACKTICK);
    if (findCodeSpanEnd(text, index, runLength) !== -1) return true;
    index += runLength;
  }

  return false;
}

function containsMathSyntax(text: string): boolean {
  return /\$\$[\s\S]+?\$\$|\$(?!\s)[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/.test(
    text
  );
}
