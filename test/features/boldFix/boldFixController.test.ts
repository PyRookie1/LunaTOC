/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBoldFixController,
  type BoldFixController,
} from '@/features/boldFix/boldFixController';

let controller: BoldFixController | null = null;

function mountThread(markup: string): HTMLElement {
  document.body.innerHTML = '<main id="thread">' + markup + '</main>';
  const thread = document.querySelector<HTMLElement>('#thread');
  if (!thread) throw new Error('Test thread was not mounted');
  return thread;
}

beforeEach(() => {
  controller = null;
  document.body.innerHTML = '';
});

afterEach(() => {
  controller?.stop();
  controller = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('boldFixController', () => {
  it('repairs paired Markdown bold markers in assistant content', () => {
    const thread = mountThread(
      '<div data-message-author-role="assistant"><p>before **bold text** after</p></div>'
    );
    controller = createBoldFixController(document);
    controller.start();

    const paragraph = thread.querySelector('p');
    expect(paragraph?.textContent).toBe('before bold text after');
    expect(paragraph?.querySelector('strong[data-chatgpt-md-fix="bold"]')?.textContent)
      .toBe('bold text');
    expect(controller.running).toBe(true);
    expect(controller.scanAll()).toBe(1);
    expect(paragraph?.querySelectorAll('strong[data-chatgpt-md-fix="bold"]')).toHaveLength(1);
  });

  it('leaves user messages, escaped markers, code and excluded controls untouched', () => {
    const thread = mountThread(
      '<div data-message-author-role="assistant">' +
        '<p>**valid** and \\**escaped** <code>**inline code**</code></p>' +
        '<pre>**code block**</pre><button>**button**</button>' +
      '</div>' +
      '<div data-message-author-role="user"><p>**user text**</p></div>'
    );
    controller = createBoldFixController(document);
    controller.start();

    const assistant = thread.querySelector('[data-message-author-role="assistant"]');
    const paragraph = assistant?.querySelector('p');
    expect(paragraph?.querySelectorAll('strong[data-chatgpt-md-fix="bold"]')).toHaveLength(1);
    expect(paragraph?.querySelector('code')?.textContent).toBe('**inline code**');
    expect(paragraph?.textContent).toContain('\\**escaped**');
    expect(assistant?.querySelector('pre')?.textContent).toBe('**code block**');
    expect(assistant?.querySelector('button')?.textContent).toBe('**button**');
    expect(thread.querySelector('[data-message-author-role="user"] strong')).toBeNull();
  });

  it('preserves the userscript fixes for native bold markers and inline code weight', () => {
    const thread = mountThread(
      '<div data-message-author-role="assistant">' +
        '<p><strong>native****marker</strong></p>' +
        '<p><strong>native trailing**</strong></p>' +
        '<p>**<code style="font-weight: 400">inline code</code>**</p>' +
      '</div>'
    );
    controller = createBoldFixController(document);
    controller.start();

    const paragraphs = thread.querySelectorAll('p');
    expect(paragraphs[0].textContent).toBe('nativemarker');
    expect(paragraphs[1].textContent).toBe('native trailing');
    expect(paragraphs[2].querySelector('code')?.style.fontWeight).toBe('600');
  });

  it('restores patched text nodes and inline code styles when stopped', () => {
    const original = '<p>before **bold text** after</p>' +
      '<p>**<code style="font-weight: 400">inline code</code>**</p>';
    const thread = mountThread(
      '<div data-message-author-role="assistant">' + original + '</div>'
    );
    controller = createBoldFixController(document);
    controller.start();

    expect(thread.querySelector('strong[data-chatgpt-md-fix="bold"]')).not.toBeNull();
    expect(thread.querySelector('code')?.style.fontWeight).toBe('600');

    controller.stop();

    expect(controller.running).toBe(false);
    expect(thread.querySelector('[data-chatgpt-md-fix]')).toBeNull();
    const paragraphs = thread.querySelectorAll('p');
    expect(paragraphs[0].textContent).toBe('before **bold text** after');
    expect(paragraphs[1].childNodes[0]?.textContent).toBe('**');
    expect(paragraphs[1].querySelector('code')?.textContent).toBe('inline code');
    expect(paragraphs[1].lastChild?.textContent).toBe('**');
    expect(thread.querySelector('code')?.style.fontWeight).toBe('400');
  });

  it('preserves later inline-code style changes during restoration', () => {
    const thread = mountThread(
      '<div data-message-author-role="assistant"><p>**<code style="font-weight: 400">inline code</code>**</p></div>'
    );
    controller = createBoldFixController(document);
    controller.start();

    const code = thread.querySelector('code');
    expect(code?.style.fontWeight).toBe('600');
    if (!code) throw new Error('Expected inline code element');
    code.style.fontWeight = '700';

    controller.stop();

    expect(code.style.fontWeight).toBe('700');
  });

  it('re-scans changed message text without restoring stale content over the update', async () => {
    const thread = mountThread(
      '<div data-message-author-role="assistant"><p>**before**</p></div>'
    );
    controller = createBoldFixController(document);
    controller.start();

    const paragraph = thread.querySelector('p');
    const originalTextNode = paragraph?.firstChild;
    if (!(originalTextNode instanceof Text)) throw new Error('Expected a text node');

    originalTextNode.data = 'after **updated**';

    await vi.waitFor(() => {
      expect(paragraph?.querySelector('strong[data-chatgpt-md-fix="bold"]')?.textContent)
        .toBe('updated');
    });

    expect(paragraph?.textContent).toBe('after updated');
  });

  it('repairs a newly inserted assistant message through the mutation observer', async () => {
    const thread = mountThread('<div data-message-author-role="assistant"></div>');
    controller = createBoldFixController(document);
    controller.start();

    const paragraph = document.createElement('p');
    paragraph.textContent = 'new **message**';
    thread.querySelector('[data-message-author-role="assistant"]')?.append(paragraph);

    await vi.waitFor(() => {
      expect(paragraph.querySelector('strong[data-chatgpt-md-fix="bold"]')?.textContent)
        .toBe('message');
    });
  });

  it('does not process further mutations after stop', async () => {
    const thread = mountThread('<div data-message-author-role="assistant"></div>');
    controller = createBoldFixController(document);
    controller.start();
    controller.stop();

    const paragraph = document.createElement('p');
    paragraph.textContent = 'new **message**';
    thread.querySelector('[data-message-author-role="assistant"]')?.append(paragraph);

    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(paragraph.querySelector('strong[data-chatgpt-md-fix="bold"]')).toBeNull();
    expect(paragraph.textContent).toBe('new **message**');
  });
});
