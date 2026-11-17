/**
 * Removes supported Markdown bold delimiters from plain-text labels.
 * This helper does not modify rendered ChatGPT answer DOM.
 */
const BACKTICK = String.fromCharCode(96);

interface MarkdownBoldSegment {
  text: string;
  bold: boolean;
}

export function stripMarkdownBoldMarkers(text: string): string {
  return parseUnrenderedBoldMarkdown(text)
    ?.map((segment) => segment.text)
    .join('') ?? text;
}

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

/**
 * Keep paired inline or display math delimiters opaque to Markdown bold parsing.
 * Prose bold markers in the same text node can still be parsed.
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
