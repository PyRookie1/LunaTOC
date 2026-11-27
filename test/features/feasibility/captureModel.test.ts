import { describe, expect, it } from 'vitest';
import { extractBranch, hasUnfinishedMessage } from '@/features/conversationExport/extraction';
import { generationState } from '@/features/conversationExport/runtime';
import { canExportClickSnapshot, checkFixedRange, textBlocks } from '@/features/conversationExport/model';
import type { ConversationSnapshot } from '@/navigation/state/activeBranch';

function snapshot(text = 'same'): ConversationSnapshot {
  return { activeBranchVerified: true, page_info: { has_previous_page: false }, messages: [
    { id: 'u1', parent: null, author: { role: 'user' }, content: { parts: [text] } },
    { id: 'a1', parent: 'u1', author: { role: 'assistant' }, content: { parts: ['answer'] } },
  ] };
}

describe('shared capture model', () => {
  it('preserves exact code whitespace and Markdown through source offsets', () => {
    const text = '# Title\n\n```ts\n\tconst x = "  ";\n\n```\n\nplain\n- item\n> quote\n';
    const blocks = textBlocks(text);
    expect(blocks.find(block => block.kind === 'code')).toMatchObject({ language: 'ts' });
    const code = blocks.find(block => block.kind === 'code')!;
    expect(text.slice(code.start, code.end)).toBe('```ts\n\tconst x = "  ";\n\n```\n');
    expect(blocks.map(block => text.slice(block.start, block.end)).join('')).toBe(text);
    expect(blocks.some(block => block.kind === 'heading')).toBe(true);
    expect(blocks.some(block => block.kind === 'list')).toBe(true);
  });

  it('keeps repeated messages with independent identities and ordered media', () => {
    const raw = snapshot();
    raw.messages.push({ id: 'u2', parent: 'a1', author: { role: 'user' }, content: { parts: [
      'before', { content_type: 'image_asset_pointer', asset_pointer: 'private-image' } as never, 'after',
    ] } });
    const result = extractBranch(raw);
    expect(result.messages.map(message => message.id)).toEqual(['u1', 'a1', 'u2']);
    expect(result.messages[2].parts.map(part => part.kind)).toEqual(['text', 'image', 'text']);
  });

  it('preserves Windows newlines, tabs and trailing whitespace in format offsets', () => {
    const text = '# Title\r\n\r\n~~~js\r\n\tcode  \r\n~~~\r\nend  ';
    expect(textBlocks(text).map(block => text.slice(block.start, block.end)).join('')).toBe(text);
    expect(textBlocks(text).some(block => block.kind === 'code')).toBe(true);
  });

  it('distinguishes appendix from edits, removal and branch replacement', () => {
    const before = extractBranch(snapshot());
    expect(checkFixedRange(before, extractBranch(snapshot()))).toBe('unchanged');
    expect(checkFixedRange(before, extractBranch(snapshot('edited')))).toBe('changed');
    const appended = snapshot();
    appended.messages.push({ id: 'u2', parent: 'a1', content: { parts: ['new'] } });
    expect(checkFixedRange(before, extractBranch(appended))).toBe('appended');
    appended.messages[0].id = 'another-branch';
    expect(checkFixedRange(before, extractBranch(appended))).toBe('changed');
    const removed = snapshot(); removed.messages.pop();
    expect(checkFixedRange(before, extractBranch(removed))).toBe('changed');
  });

  it('detects media-only changes and retains unsupported parts as uncertainty', () => {
    const a = snapshot(); const b = snapshot();
    a.messages[0].content!.parts!.push({ content_type: 'unknown-tool-payload' });
    b.messages[0].content!.parts!.push({ content_type: 'another-tool-payload' });
    expect(extractBranch(a).messages[0].unsupportedParts).toBe(1);
    expect(checkFixedRange(extractBranch(a), extractBranch(b))).toBe('changed');
  });

  it('never permits click-snapshot export from path verification or repeated equal reads', () => {
    const stable = extractBranch(snapshot());
    expect(checkFixedRange(stable, extractBranch(snapshot()))).toBe('unchanged');
    expect(canExportClickSnapshot(stable)).toBe(false);
    const mixed = extractBranch(snapshot('question from version B'));
    expect(canExportClickSnapshot(mixed)).toBe(false);
    expect(checkFixedRange(stable, mixed)).toBe('changed');
  });

  it('rejects incomplete pagination and duplicate identities', () => {
    const raw = snapshot(); raw.page_info!.has_previous_page = true;
    expect(() => extractBranch(raw)).toThrow();
    const duplicate = snapshot(); duplicate.messages[1].id = duplicate.messages[0].id;
    expect(() => extractBranch(duplicate)).toThrow();
  });

  it('keeps hidden analysis out of visible output without ignoring path changes', () => {
    const raw = snapshot();
    (raw.messages[1] as unknown as { channel: string }).channel = 'analysis';
    expect(extractBranch(raw).messages[1].visible).toBe(false);
  });

  it('checks current leaf status instead of stale historical or abandoned statuses', () => {
    const raw = snapshot();
    const root = { querySelector: () => null } as unknown as ParentNode;
    (raw.messages[0] as unknown as { status: string }).status = 'pending';
    (raw.messages[1] as unknown as { status: string; end_turn: boolean }).status = 'finished_successfully';
    (raw.messages[1] as unknown as { end_turn: boolean }).end_turn = true;
    expect(hasUnfinishedMessage(raw)).toBe(false);
    expect(generationState('never-observed', root, raw)).toBe('ready');
    raw.activeBranchVerified = undefined;
    raw.current_node = 'a1';
    raw.messages.push({ id: 'abandoned', parent: 'u1', author: { role: 'assistant' },
      content: { parts: ['old'] }, status: 'in_progress' } as typeof raw.messages[number]);
    expect(hasUnfinishedMessage(raw)).toBe(false);
    (raw.messages[1] as unknown as { status: string; end_turn: boolean }).status = 'in_progress';
    (raw.messages[1] as unknown as { end_turn: boolean }).end_turn = false;
    expect(hasUnfinishedMessage(raw)).toBe(true);
    expect(generationState('never-observed', root, raw)).toBe('unknown');
  });
});
