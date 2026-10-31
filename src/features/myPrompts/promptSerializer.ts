/**
 * Serializes and deserializes saved prompts to and from Markdown format.
 * Import parsing is deliberately bounded to protect the ChatGPT tab from large files.
 */
import type { SavedPrompt } from './promptStore';

export const MAX_MARKDOWN_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_MARKDOWN_IMPORT_PROMPTS = 500;
export const MAX_MARKDOWN_IMPORT_LINES = 100_000;
export const MAX_MARKDOWN_PROMPT_TITLE_LENGTH = 1_000;
export const MAX_MARKDOWN_PROMPT_CONTENT_LENGTH = 100_000;

/**
 * Returns a Markdown fence that does not occur in the prompt content.
 */
function getMarkdownFence(content: string): string {
  const backtickRuns = content.match(/`+/g) || [];
  const longestRun = backtickRuns.reduce(
    (length, run) => Math.max(length, run.length),
    0
  );
  return '`'.repeat(Math.max(3, longestRun + 1));
}

/** Counts UTF-8 bytes without allocating a second full-size buffer. */
function exceedsUtf8ByteLimit(value: string, maximum: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff &&
        index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 &&
        value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > maximum) return true;
  }
  return false;
}

/** Reads one line without allocating an array for every line in the document. */
function readLine(
  source: string,
  offset: number
): { line: string; next: number } | null {
  if (offset > source.length) return null;
  const newline = source.indexOf('\n', offset);
  const end = newline === -1 ? source.length : newline;
  const lineEnd = end > offset && source.charCodeAt(end - 1) === 13 ? end - 1 : end;
  return {
    line: source.slice(offset, lineEnd),
    next: newline === -1 ? source.length + 1 : newline + 1,
  };
}

/**
 * Formats prompts as editable Markdown sections.
 */
export function formatPromptsAsMarkdown(prompts: SavedPrompt[]): string {
  return prompts
    .map(({ title, content }) => {
      const fence = getMarkdownFence(content);
      const closingNewline = content.endsWith('\n') ? '' : '\n';
      return `# ${title}\n\n${fence}prompt\n${content}${closingNewline}${fence}`;
    })
    .join('\n\n');
}

/**
 * Parses the Markdown format created by the exporter. Parsing is bounded by
 * UTF-8 file size, line count, prompt count, title length and content length.
 */
export function parseMarkdownPrompts(
  markdown: string
): Array<Pick<SavedPrompt, 'title' | 'content'>> {
  if (typeof markdown !== 'string') throw new Error('Markdown 文件内容无效。');
  if (exceedsUtf8ByteLimit(markdown, MAX_MARKDOWN_IMPORT_BYTES)) {
    throw new Error('Markdown 文件超过 5 MiB 限制，请拆分文件后重新导入。');
  }

  const prompts: Array<Pick<SavedPrompt, 'title' | 'content'>> = [];
  let linesRead = 0;
  const nextLine = (offset: number): { line: string; next: number } | null => {
    const line = readLine(markdown, offset);
    if (line && ++linesRead > MAX_MARKDOWN_IMPORT_LINES) {
      throw new Error(`Markdown 文件超过 ${MAX_MARKDOWN_IMPORT_LINES.toLocaleString()} 行限制。`);
    }
    return line;
  };
  let current = nextLine(0);

  while (current) {
    if (!current.line.startsWith('# ')) {
      current = nextLine(current.next);
      continue;
    }

    const title = current.line.slice(2).trim();
    current = nextLine(current.next);
    while (current?.line === '') current = nextLine(current.next);

    const openingFence = current?.line.match(/^(`{3,})prompt\s*$/);
    if (!title || !openingFence) {
      // Match the legacy parser's behavior: skip the first non-empty line
      // after a heading that does not introduce a supported prompt block.
      current = current ? nextLine(current.next) : null;
      continue;
    }
    if (title.length > MAX_MARKDOWN_PROMPT_TITLE_LENGTH) {
      throw new Error(`提示词标题超过 ${MAX_MARKDOWN_PROMPT_TITLE_LENGTH} 个字符限制。`);
    }

    const fence = openingFence[1];
    const contentLines: string[] = [];
    let contentLength = 0;
    let hasNonWhitespace = false;
    current = nextLine(current.next);

    while (current && current.line !== fence) {
      const nextLength = contentLength + current.line.length +
        (contentLines.length > 0 ? 1 : 0);
      if (nextLength > MAX_MARKDOWN_PROMPT_CONTENT_LENGTH) {
        throw new Error(
          `单条提示词内容超过 ${MAX_MARKDOWN_PROMPT_CONTENT_LENGTH.toLocaleString()} 个字符限制。`
        );
      }
      contentLength = nextLength;
      if (current.line.trim()) hasNonWhitespace = true;
      contentLines.push(current.line);
      current = nextLine(current.next);
    }

    // An incomplete block is ignored, as in the previous parser.
    if (!current) break;

    if (hasNonWhitespace) {
      if (prompts.length >= MAX_MARKDOWN_IMPORT_PROMPTS) {
        throw new Error(
          `单次最多导入 ${MAX_MARKDOWN_IMPORT_PROMPTS.toLocaleString()} 条提示词，请拆分文件后重新导入。`
        );
      }
      prompts.push({ title, content: contentLines.join('\n') });
    }
    current = nextLine(current.next);
  }

  return prompts;
}

/** Check File.size before reading it, so an oversized file is never loaded into memory. */
export async function parseMarkdownImportFile(
  file: Pick<File, 'size' | 'text'>
): Promise<Array<Pick<SavedPrompt, 'title' | 'content'>>> {
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new Error('无法读取所选 Markdown 文件的大小。');
  }
  if (file.size > MAX_MARKDOWN_IMPORT_BYTES) {
    throw new Error('Markdown 文件超过 5 MiB 限制，请拆分文件后重新导入。');
  }
  return parseMarkdownPrompts(await file.text());
}
