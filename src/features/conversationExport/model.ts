/** Read-only capture model. No storage, UI or DOCX dependencies. */
export interface TextBlock {
  kind: 'paragraph' | 'heading' | 'code' | 'quote' | 'list' | 'table';
  start: number;
  end: number;
  level?: number;
  language?: string;
}

export type MessagePart =
  | { kind: 'text'; text: string; blocks: TextBlock[] }
  | { kind: 'image'; resourceId: string }
  | { kind: 'unsupported' };

export interface CapturedMessage {
  id: string;
  role: string;
  parentId: string | null | undefined;
  visible: boolean;
  parts: MessagePart[];
  attachments: Array<{ name: string; mime: string }>;
  /** Local comparison material, NEVER a server revision or report field. */
  comparison: string;
  unsupportedParts: number;
}

export interface BranchCapture {
  messages: CapturedMessage[];
  source: 'tree' | 'pages' | 'unknown';
  pages: number;
  /** No currently implemented host contract proves an atomic click snapshot. */
  clickSnapshotProven: false;
}

export type RangeCheck = 'unchanged' | 'appended' | 'changed';

/** Stable JSON serialization used privately for semantic comparison only. */
export function comparisonMaterial(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(comparisonMaterial).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).filter(key => record[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + comparisonMaterial(record[key])).join(',') + '}';
}

/** Exact text is stored once; formatting blocks refer to source offsets. */
export function textBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const lines = Array.from(text.matchAll(/[^\n]*(?:\n|$)/g)).filter(match => match[0].length > 0);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const start = line.index!;
    const fence = line[0].match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (fence) {
      const character = fence[1][0];
      const length = fence[1].length;
      let last = index;
      while (++last < lines.length) {
        const close = lines[last][0].trim();
        if (close.length >= length && Array.from(close).every(item => item === character)) break;
      }
      const end = last < lines.length ? lines[last].index! + lines[last][0].length : text.length;
      blocks.push({ kind: 'code', start, end, language: fence[2].trim() });
      index = Math.min(last, lines.length - 1);
      continue;
    }
    const heading = line[0].match(/^ {0,3}(#{1,6})\s/);
    const kind = heading ? 'heading' : /^\s*>/.test(line[0]) ? 'quote'
      : /^\s*(?:[-+*]|\d+[.)])\s/.test(line[0]) ? 'list'
      : line[0].includes('|') && (index > 0 && lines[index - 1][0].includes('|') ||
          /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]?.[0] ?? '')) ? 'table' : 'paragraph';
    blocks.push({ kind, start, end: start + line[0].length, ...(heading ? { level: heading[1].length } : {}) });
  }
  return blocks;
}

export function checkFixedRange(before: BranchCapture, after: BranchCapture): RangeCheck {
  if (after.messages.length < before.messages.length) return 'changed';
  for (let index = 0; index < before.messages.length; index++) {
    if (before.messages[index].id !== after.messages[index].id ||
        before.messages[index].comparison !== after.messages[index].comparison) return 'changed';
  }
  return before.messages.length === after.messages.length ? 'unchanged' : 'appended';
}

/** Strict future export gate: a diagnostic stability result cannot bypass it. */
export function canExportClickSnapshot(capture: BranchCapture): boolean {
  return capture.clickSnapshotProven && capture.messages.every(message => message.unsupportedParts === 0);
}
