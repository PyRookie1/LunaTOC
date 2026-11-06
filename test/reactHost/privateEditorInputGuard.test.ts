/** @vitest-environment jsdom */
/** Closed-root editor input must not be cancelled by host-page event handlers. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { installPrivateEditorInputGuard } from '@/reactHost/privateEditorInputGuard';

let host: HTMLDivElement;
let input: HTMLInputElement;

beforeAll(() => {
  installPrivateEditorInputGuard(window);
});

afterEach(() => {
  host?.remove();
  vi.restoreAllMocks();
});

function mountPrivateEditorInput(): void {
  host = document.createElement('div');
  host.id = 'luna-toc-private-react-host';
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  input = document.createElement('input');
  shadowRoot.append(input);
  document.body.append(host);
}

describe('private prompt editor input event isolation', () => {
  it('keeps numeric key events from reaching host-page shortcuts without cancelling input', () => {
    mountPrivateEditorInput();
    const pageHandler = vi.fn();
    document.addEventListener('keydown', pageHandler);

    const event = new KeyboardEvent('keydown', {
      key: '7',
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input.dispatchEvent(event);

    expect(pageHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    document.removeEventListener('keydown', pageHandler);
  });

  it('allows non-numeric keys to retain their normal event path', () => {
    mountPrivateEditorInput();
    const pageHandler = vi.fn();
    document.addEventListener('keydown', pageHandler);

    const event = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input.dispatchEvent(event);

    expect(pageHandler).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);

    document.removeEventListener('keydown', pageHandler);
  });

  it('keeps keyboard paste shortcuts from reaching host-page handlers', () => {
    mountPrivateEditorInput();
    const pageHandler = vi.fn();
    document.addEventListener('keydown', pageHandler);

    const event = new KeyboardEvent('keydown', {
      key: 'v',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input.dispatchEvent(event);

    expect(pageHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    document.removeEventListener('keydown', pageHandler);
  });

  it('keeps paste events from reaching host-page handlers without cancelling paste', () => {
    mountPrivateEditorInput();
    const pageHandler = vi.fn();
    document.addEventListener('paste', pageHandler);

    const event = new Event('paste', {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input.dispatchEvent(event);

    expect(pageHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    document.removeEventListener('paste', pageHandler);
  });

  it('isolates numeric beforeinput while leaving ordinary input events untouched', () => {
    mountPrivateEditorInput();
    const beforeInputHandler = vi.fn();
    const inputHandler = vi.fn();
    document.addEventListener('beforeinput', beforeInputHandler);
    document.addEventListener('input', inputHandler);

    const numericBeforeInput = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: '3',
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input.dispatchEvent(numericBeforeInput);
    input.dispatchEvent(
      new Event('input', { bubbles: true, composed: true })
    );

    expect(beforeInputHandler).not.toHaveBeenCalled();
    expect(numericBeforeInput.defaultPrevented).toBe(false);
    expect(inputHandler).toHaveBeenCalledOnce();

    document.removeEventListener('beforeinput', beforeInputHandler);
    document.removeEventListener('input', inputHandler);
  });
});
