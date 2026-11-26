import { extractActiveBranchMessages, type ConversationSnapshot } from '@/navigation/state/activeBranch';
import { comparisonMaterial, textBlocks, type BranchCapture, type CapturedMessage, type MessagePart } from './model';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Preserve API text and ordered media pointers; never derive body from TOC labels. */
export function extractBranch(snapshot: ConversationSnapshot): BranchCapture {
  const source = extractActiveBranchMessages(snapshot);
  if (!source || snapshot.page_info?.has_previous_page !== false) throw new Error('incomplete');
  const messages: CapturedMessage[] = [];
  const identities = new Set<string>();
  let totalCharacters = 0;
  for (const input of source) {
    if (!input.id || identities.has(input.id)) throw new Error('duplicate-identity');
    identities.add(input.id);
    const raw = record(input);
    const content = record(raw.content);
    const metadata = record(raw.metadata);
    const role = typeof input.author?.role === 'string' ? input.author.role : 'unknown';
    const visible = (role === 'user' || role === 'assistant') && raw.channel !== 'analysis' &&
      metadata.is_visually_hidden_from_conversation !== true;
    const rawParts = Array.isArray(content.parts) ? content.parts : [];
    const parts: MessagePart[] = rawParts.map(part => {
      if (typeof part === 'string') {
        totalCharacters += part.length;
        return { kind: 'text', text: part, blocks: textBlocks(part) };
      }
      const value = record(part);
      if (value.content_type === 'image_asset_pointer' && typeof value.asset_pointer === 'string') {
        return { kind: 'image', resourceId: value.asset_pointer };
      }
      return { kind: 'unsupported' };
    });
    const attachments = (Array.isArray(metadata.attachments) ? metadata.attachments : []).map(item => {
      const file = record(item);
      return { name: typeof file.name === 'string' ? file.name : '',
        mime: typeof file.mime_type === 'string' ? file.mime_type : typeof file.mimeType === 'string' ? file.mimeType : '' };
    });
    if (totalCharacters > 12_000_000 || messages.length >= 20_000) throw new Error('capture-budget');
    const parentId = input.parent ?? input.parent_id;
    const explicitParent = input.parent === null || input.parent_id === null ? null : parentId;
    messages.push({
      id: input.id, role, parentId: explicitParent, visible, parts, attachments,
      // Include unknown payloads too: unsupported data must still invalidate a changed scope.
      comparison: comparisonMaterial({ id: input.id, parent: explicitParent, role, channel: raw.channel,
        content, attachments: metadata.attachments, hidden: metadata.is_visually_hidden_from_conversation }),
      unsupportedParts: parts.filter(part => part.kind === 'unsupported').length +
        (role === 'unknown' ? 1 : 0) +
        (visible && rawParts.length === 0 && attachments.length === 0 ? 1 : 0),
    });
  }
  return { messages, source: snapshot.readEvidence?.source ?? 'unknown',
    pages: snapshot.readEvidence?.pages ?? 0, clickSnapshotProven: false };
}

export function hasUnfinishedMessage(snapshot: ConversationSnapshot): boolean {
  return snapshot.messages.some(message => {
    const status = record(message).status;
    return status === 'in_progress' || status === 'pending' || status === 'streaming';
  });
}
