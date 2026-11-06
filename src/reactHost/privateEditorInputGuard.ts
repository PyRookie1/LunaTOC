/**
 * Prevents host-page keyboard and clipboard handlers from cancelling native
 * editing inside LunaTOC's closed prompt-editor Shadow DOM.
 *
 * Events crossing a closed Shadow DOM boundary are retargeted to the host
 * element. Host-page shortcuts can therefore mistake the focused input for a
 * non-editable element and cancel digit entry or paste. Stop only the affected
 * events before they reach page listeners; never cancel their default action.
 */
const PRIVATE_HOST_ID = 'luna-toc-private-react-host';
const installedWindows = new WeakSet<Window>();

/**
 * Installs an early capture-phase guard for numeric entry and paste events.
 *
 * @example
 * installPrivateEditorInputGuard();
 */
export function installPrivateEditorInputGuard(
  targetWindow: Window = window
): void {
  if (installedWindows.has(targetWindow)) return;
  installedWindows.add(targetWindow);

  const guard = (event: Event): void => {
    if (!isPrivateEditorEvent(event)) return;

    if (
      isProtectedKeyEvent(event) ||
      isPasteEvent(event) ||
      isNumericBeforeInputEvent(event)
    ) {
      // Preserve the browser's native editing action. Only isolate the event
      // from page-level handlers that cannot see through the closed root.
      event.stopImmediatePropagation();
    }
  };

  targetWindow.addEventListener('keydown', guard, true);
  targetWindow.addEventListener('keypress', guard, true);
  targetWindow.addEventListener('paste', guard, true);
  targetWindow.addEventListener('beforeinput', guard, true);
}

function isPrivateEditorEvent(event: Event): boolean {
  return (
    event.target instanceof HTMLElement &&
    event.target.id === PRIVATE_HOST_ID
  );
}

function isProtectedKeyEvent(event: Event): boolean {
  if (event.type !== 'keydown' && event.type !== 'keypress') return false;

  const keyboardEvent = event as KeyboardEvent;
  if (/^\d$/.test(keyboardEvent.key)) return true;

  const key = keyboardEvent.key.toLowerCase();
  return (
    ((keyboardEvent.ctrlKey || keyboardEvent.metaKey) &&
      key === 'v' &&
      !keyboardEvent.altKey) ||
    (key === 'insert' && keyboardEvent.shiftKey)
  );
}

function isPasteEvent(event: Event): boolean {
  if (event.type === 'paste') return true;
  if (event.type !== 'beforeinput') return false;

  const inputType = (event as InputEvent).inputType;
  return (
    inputType === 'insertFromPaste' ||
    inputType === 'insertFromPasteAsQuotation'
  );
}

function isNumericBeforeInputEvent(event: Event): boolean {
  return (
    event.type === 'beforeinput' &&
    /\d/.test((event as InputEvent).data ?? '')
  );
}
