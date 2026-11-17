/** @vitest-environment jsdom */
/** Public Shadow DOM menu actions must reject page-script-generated clicks. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptContextMenuHost } from '@/components/my-prompts/PromptContextMenu';
import { promptContextMenuController } from '@/features/myPrompts/promptContextMenu';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    promptContextMenuController.close();
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('saved prompt context-menu click authenticity', () => {
  it('ignores synthetic destructive selection without closing or consuming the menu', async () => {
    const select = vi.fn();
    const close = vi.fn();

    await act(async () => {
      promptContextMenuController.show(
        { left: 10, top: 20 },
        [{ id: 'clear-all', label: '清空Tips', variant: 'destructive' }],
        select,
        close
      );
      root.render(<PromptContextMenuHost />);
    });

    const item = host.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain('清空Tips');

    await act(async () => {
      item?.click();
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(select).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(promptContextMenuController.getSnapshot()).not.toBeNull();
  });
});
