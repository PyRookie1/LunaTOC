/** Tests pure Markdown serialization and parsing for saved prompts. */
import { describe, expect, it } from 'vitest';

import {
  formatPromptsAsMarkdown,
  parseMarkdownPrompts,
  parseMarkdownImportFile,
  MAX_MARKDOWN_IMPORT_BYTES,
  MAX_MARKDOWN_IMPORT_PROMPTS,
  MAX_MARKDOWN_IMPORT_LINES,
  MAX_MARKDOWN_PROMPT_CONTENT_LENGTH,
  MAX_MARKDOWN_PROMPT_TITLE_LENGTH,
} from '@/features/myPrompts/promptSerializer';
import type { SavedPrompt } from '@/features/myPrompts/promptStore';

describe('promptSerializer', () => {
  describe('formatPromptsAsMarkdown', () => {
    it('returns an empty string when given an empty prompt list', () => {
      expect(formatPromptsAsMarkdown([])).toBe('');
    });

    it('formats a single prompt into a Markdown heading and prompt fence', () => {
      const prompts: SavedPrompt[] = [
        {
          id: '1',
          ownerId: 'account-1',
          title: 'Code Reviewer',
          content: 'Review this diff for bugs.',
          createdAt: 1000,
          updatedAt: 1000,
        },
      ];

      const result = formatPromptsAsMarkdown(prompts);
      expect(result).toBe(
        '# Code Reviewer\n\n```prompt\nReview this diff for bugs.\n```'
      );
    });

    it('appends a closing newline to prompt content if absent', () => {
      const prompts: SavedPrompt[] = [
        {
          id: '1',
          ownerId: 'account-1',
          title: 'No Trailing Newline',
          content: 'line 1\nline 2',
          createdAt: 1000,
          updatedAt: 1000,
        },
      ];

      const result = formatPromptsAsMarkdown(prompts);
      expect(result).toBe(
        '# No Trailing Newline\n\n```prompt\nline 1\nline 2\n```'
      );
    });

    it('does not append an extra newline if prompt content already ends with one', () => {
      const prompts: SavedPrompt[] = [
        {
          id: '1',
          ownerId: 'account-1',
          title: 'Has Trailing Newline',
          content: 'line 1\nline 2\n',
          createdAt: 1000,
          updatedAt: 1000,
        },
      ];

      const result = formatPromptsAsMarkdown(prompts);
      expect(result).toBe(
        '# Has Trailing Newline\n\n```prompt\nline 1\nline 2\n```'
      );
    });

    it('dynamically increases the fence backticks to avoid collision with content', () => {
      const prompts: SavedPrompt[] = [
        {
          id: '1',
          ownerId: 'account-1',
          title: 'Code Example',
          content: 'Here is code:\n```ts\nconsole.log(1);\n```',
          createdAt: 1000,
          updatedAt: 1000,
        },
      ];

      const result = formatPromptsAsMarkdown(prompts);
      expect(result).toBe(
        '# Code Example\n\n````prompt\nHere is code:\n```ts\nconsole.log(1);\n```\n````'
      );
    });

    it('separates multiple prompts with a double newline', () => {
      const prompts: SavedPrompt[] = [
        {
          id: '1',
          ownerId: 'account-1',
          title: 'Prompt 1',
          content: 'Content 1',
          createdAt: 1000,
          updatedAt: 1000,
        },
        {
          id: '2',
          ownerId: 'account-1',
          title: 'Prompt 2',
          content: 'Content 2',
          createdAt: 2000,
          updatedAt: 2000,
        },
      ];

      const result = formatPromptsAsMarkdown(prompts);
      expect(result).toBe(
        '# Prompt 1\n\n```prompt\nContent 1\n```\n\n# Prompt 2\n\n```prompt\nContent 2\n```'
      );
    });
  });

  describe('parseMarkdownPrompts', () => {
    it('returns an empty array for empty input', () => {
      expect(parseMarkdownPrompts('')).toEqual([]);
    });

    it('parses valid Markdown prompts into title and content pairs', () => {
      const markdown = '# P1\n\n```prompt\nHello\n```\n\n# P2\n\n```prompt\nWorld\n```';
      const parsed = parseMarkdownPrompts(markdown);

      expect(parsed).toEqual([
        { title: 'P1', content: 'Hello' },
        { title: 'P2', content: 'World' },
      ]);
    });

    it('normalizes CRLF line endings to LF', () => {
      const markdown = '# CRLF Prompt\r\n\r\n```prompt\r\nLine 1\r\nLine 2\r\n```';
      const parsed = parseMarkdownPrompts(markdown);

      expect(parsed).toEqual([
        { title: 'CRLF Prompt', content: 'Line 1\nLine 2' },
      ]);
    });

    it('parses fences longer than 3 backticks', () => {
      const markdown = '# Fence Prompt\n\n````prompt\nNested ``` code\n````';
      const parsed = parseMarkdownPrompts(markdown);

      expect(parsed).toEqual([
        { title: 'Fence Prompt', content: 'Nested ``` code' },
      ]);
    });

    it('skips prompts with whitespace-only content', () => {
      const markdown = '# Empty\n\n```prompt\n   \n\t\n```\n\n# Valid\n\n```prompt\nValid text\n```';
      const parsed = parseMarkdownPrompts(markdown);

      expect(parsed).toEqual([{ title: 'Valid', content: 'Valid text' }]);
    });

    it('ignores sections lacking a proper # heading or opening prompt fence', () => {
      const markdown = '## Wrong Heading\n```prompt\nText\n```\n\n# No Fence\nJust text\n';
      const parsed = parseMarkdownPrompts(markdown);

      expect(parsed).toEqual([]);
    });

    it('handles truncated Markdown without reaching closing fence without crashing', () => {
      const markdown = '# Truncated\n\n```prompt\nUnfinished content';
      const parsed = parseMarkdownPrompts(markdown);

      expect(parsed).toEqual([]);
    });
  });

  describe('bounded Markdown import', () => {
    const makeDocument = (count: number, content = 'Prompt content'): string =>
      Array.from({ length: count }, (_, index) =>
        `# Prompt ${index}\n\n\`\`\`prompt\n${content}\n\`\`\``
      ).join('\n\n');

    it('rejects a file above 5 MiB before reading its contents', async () => {
      let read = false;
      const file = {
        size: MAX_MARKDOWN_IMPORT_BYTES + 1,
        text: async () => { read = true; return '# Never read'; },
      } as Pick<File, 'size' | 'text'>;
      await expect(parseMarkdownImportFile(file))
        .rejects.toThrow('5 MiB');
      expect(read).toBe(false);
    });

    it('checks UTF-8 byte size even when the parser is called directly', () => {
      expect(() => parseMarkdownPrompts('x'.repeat(MAX_MARKDOWN_IMPORT_BYTES + 1)))
        .toThrow('5 MiB');
    });

    it('rejects pathological files with too many lines', () => {
      expect(() => parseMarkdownPrompts('\n'.repeat(MAX_MARKDOWN_IMPORT_LINES)))
        .toThrow('行限制');
    });

    it('measures UTF-8 bytes rather than UTF-16 code units', () => {
      const multibyte = '中'.repeat(Math.floor(MAX_MARKDOWN_IMPORT_BYTES / 3) + 1);
      expect(() => parseMarkdownPrompts(multibyte)).toThrow('5 MiB');
    });

    it('accepts up to the prompt-count limit and rejects one more', () => {
      expect(parseMarkdownPrompts(makeDocument(MAX_MARKDOWN_IMPORT_PROMPTS))).toHaveLength(
        MAX_MARKDOWN_IMPORT_PROMPTS
      );
      expect(() => parseMarkdownPrompts(makeDocument(MAX_MARKDOWN_IMPORT_PROMPTS + 1)))
        .toThrow('最多导入');
    });

    it('accepts content at the per-prompt limit and rejects content above it', () => {
      expect(parseMarkdownPrompts(makeDocument(1, 'x'.repeat(MAX_MARKDOWN_PROMPT_CONTENT_LENGTH))))
        .toHaveLength(1);
      expect(() => parseMarkdownPrompts(
        makeDocument(1, 'x'.repeat(MAX_MARKDOWN_PROMPT_CONTENT_LENGTH + 1))
      )).toThrow('单条提示词内容超过');
    });

    it('rejects a title longer than the prompt storage limit', () => {
      const fence = '`'.repeat(3);
      const markdown = `# ${'T'.repeat(MAX_MARKDOWN_PROMPT_TITLE_LENGTH + 1)}\n\n${fence}prompt\nContent\n${fence}`;
      expect(() => parseMarkdownPrompts(markdown)).toThrow('提示词标题超过');
    });

    it('reads and parses a file after its size preflight succeeds', async () => {
      const markdown = '# Imported\n\n```prompt\nSafe content\n```';
      const file = new Blob([markdown]) as File;
      await expect(parseMarkdownImportFile(file)).resolves.toEqual([
        { title: 'Imported', content: 'Safe content' },
      ]);
    });
  });

  describe('round-trip serialization', () => {
    it('preserves prompt titles and contents across format and parse', () => {
      const original: SavedPrompt[] = [
        {
          id: '1',
          ownerId: 'account-1',
          title: 'Refactor Plan',
          content: 'Step 1: Check\nStep 2: Act\n```bash\nnpm test\n```',
          createdAt: 100,
          updatedAt: 200,
        },
        {
          id: '2',
          ownerId: 'account-1',
          title: 'Summary',
          content: 'Please summarize in bullet points.',
          createdAt: 300,
          updatedAt: 400,
        },
      ];

      const serialized = formatPromptsAsMarkdown(original);
      const deserialized = parseMarkdownPrompts(serialized);

      expect(deserialized).toEqual([
        { title: original[0].title, content: original[0].content },
        { title: original[1].title, content: original[1].content },
      ]);
    });
  });
});
