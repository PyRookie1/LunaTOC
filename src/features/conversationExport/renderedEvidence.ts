import type { BranchCapture } from './model';

export interface RenderedEvidence { matched: number; mounted: number; code: number; headings: number; images: number }

/** Supplements format evidence only when an existing host ID maps unambiguously. */
export function inspectRenderedEvidence(capture: BranchCapture, root: Element | null): RenderedEvidence {
  const result = { matched: 0, mounted: 0, code: 0, headings: 0, images: 0 };
  if (!root) return result;
  const ids = new Set(capture.messages.filter(message => message.visible).map(message => message.id));
  const matched = new Set<string>();
  const code = new Set<Element>(); const headings = new Set<Element>(); const images = new Set<Element>();
  for (const shell of root.querySelectorAll('[data-message-id], [data-chatgpt-search-message-ids]')) {
    const identity = shell.getAttribute('data-message-id') || shell.getAttribute('data-chatgpt-search-message-ids') || '';
    const identities = identity.trim().split(/\s+/);
    result.mounted++;
    if (identities.length !== 1 || !ids.has(identities[0])) continue;
    matched.add(identities[0]);
    shell.querySelectorAll('pre').forEach(element => code.add(element));
    shell.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(element => headings.add(element));
    shell.querySelectorAll('img').forEach(element => images.add(element));
  }
  result.matched = matched.size; result.code = code.size; result.headings = headings.size; result.images = images.size;
  return result;
}
