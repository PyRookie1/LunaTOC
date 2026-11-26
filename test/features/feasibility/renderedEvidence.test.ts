/** @vitest-environment jsdom */
import { afterEach, expect, it } from 'vitest';
import { inspectRenderedEvidence } from '@/features/conversationExport/renderedEvidence';
import { extractBranch } from '@/features/conversationExport/extraction';

afterEach(() => document.body.replaceChildren());

it('maps formats by existing host identity, excluding ambiguous and unrelated containers', () => {
  const capture = extractBranch({ activeBranchVerified: true, page_info: { has_previous_page: false }, messages: [
    { id: 'user', author: { role: 'user' }, content: { parts: ['question'] } },
    { id: 'answer', author: { role: 'assistant' }, content: { parts: ['answer'] } },
  ] });
  document.body.innerHTML = '<main><article data-chatgpt-search-message-ids="answer"><h2>Title</h2><pre>code</pre><img></article>' +
    '<article data-chatgpt-search-message-ids="user answer"><h2>Ambiguous</h2></article>' +
    '<article data-message-id="unrelated"><pre>unrelated</pre></article></main>';
  expect(inspectRenderedEvidence(capture, document.querySelector('main'))).toEqual({
    matched: 1, mounted: 3, code: 1, headings: 1, images: 1,
  });
});
