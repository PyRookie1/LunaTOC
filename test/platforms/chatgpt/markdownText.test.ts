import { describe, expect, it } from 'vitest';
import { stripMarkdownBoldMarkers } from '@/platforms/chatgpt/markdownText';

describe('stripMarkdownBoldMarkers', () => {
  it('removes complete bold delimiters from plain-text labels', () => {
    expect(stripMarkdownBoldMarkers('before **one** and **two** after'))
      .toBe('before one and two after');
  });

  it('preserves code, math, escaped and incomplete markers', () => {
    const tick = String.fromCharCode(96);
    const slash = String.fromCharCode(92);
    const code = tick + '**code**' + tick;
    const math = '$**math**$';
    const escaped = slash + '**escaped**';
    const incomplete = '**unfinished';
    const input = [code, math, escaped, '**valid**', incomplete].join(' ');
    const expected = [code, math, escaped, 'valid', incomplete].join(' ');
    expect(stripMarkdownBoldMarkers(input)).toBe(expected);
  });
});
