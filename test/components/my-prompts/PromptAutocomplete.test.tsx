/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptAutocompleteHost } from '@/components/my-prompts/PromptAutocomplete';
import { promptAutocompleteViewController } from '@/features/myPrompts/promptAutocompleteView';
import type { SavedPrompt } from '@/features/myPrompts/promptStore';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    promptAutocompleteViewController.close();
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('saved prompt autocomplete privacy', () => {
  it('shows only the suggestion title and does not write the full prompt body into DOM attributes', async () => {
    const select = vi.fn();
    const secret = 'private saved prompt body: do not expose via title attribute';
    const prompt: SavedPrompt = {
      id: 'private-tip', ownerId: 'account-1', title: 'My reusable tip',
      content: secret, createdAt: 1, updatedAt: 2,
    };

    await act(async () => {
      promptAutocompleteViewController.show(
        [prompt], 0,
        { left: 10, width: 300, anchorTop: 200, anchorBottom: 230, viewportHeight: 800 },
        select, vi.fn()
      );
      root.render(<PromptAutocompleteHost />);
    });

    const suggestion = host.querySelector<HTMLElement>('[role="option"]');
    expect(suggestion).not.toBeNull();
    expect(suggestion?.textContent).toContain('My reusable tip');
    expect(host.innerHTML).not.toContain(secret);
    expect(suggestion?.getAttribute('title')).toBeNull();

    await act(async () => suggestion?.click());
    expect(select).toHaveBeenCalledWith(prompt);
  });
});
