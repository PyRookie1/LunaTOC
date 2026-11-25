/**
 * Builds and wires the sidebar's "jump to top / bottom" controls.
 *
 * The top, settings and bottom buttons share the edge toolbar with the view-mode
 * toggle owned by `sidebarController`.
 */
import { navigatorController } from '@/navigation/navigatorController';
import { openSettingsFromConversation } from './openSettings';

type ConversationEdge = 'top' | 'bottom';

/**
 * Creates the jump-to-edge buttons inside the existing `.navigator-jump-controls`
 * cluster and wires their click handlers.
 *
 * @param {() => boolean} isMyPromptsView Reports whether the sidebar is
 *   currently showing the My Prompts view.
 * @returns {HTMLElement} The `.navigator-jump-controls` cluster.
 */
export function createJumpToEdgeControls(
  isMyPromptsView: () => boolean
): HTMLElement {
  const cluster = document.querySelector<HTMLElement>(
    '.navigator-jump-controls'
  );
  if (!cluster) {
    throw new Error('Jump control cluster (.navigator-jump-controls) not found');
  }

  const topButton = createJumpButton('top');
  const settingsButton = createSettingsButton();
  const bottomButton = createJumpButton('bottom');

  // Top → view mode → settings → bottom. Existing jump controls keep their behavior.
  cluster.prepend(topButton);
  cluster.append(settingsButton, bottomButton);

  let pendingBottomClick: number | null = null;
  const cancelPendingBottomClick = (): void => {
    if (pendingBottomClick !== null) window.clearTimeout(pendingBottomClick);
    pendingBottomClick = null;
    document.removeEventListener('pointerdown', cancelOnOtherPointer, true);
  };
  const cancelOnOtherPointer = (event: PointerEvent): void => {
    if (event.target !== bottomButton && !bottomButton.contains(event.target as Node)) {
      cancelPendingBottomClick();
    }
  };

  topButton.addEventListener('click', () => {
    cancelPendingBottomClick();
    handleJumpControlClick('top', isMyPromptsView);
  });
  topButton.addEventListener('dblclick', () => {
    cancelPendingBottomClick();
    handleJumpControlDoubleClick('top', isMyPromptsView);
  });
  bottomButton.addEventListener('click', (event) => {
    cancelPendingBottomClick();
    // Keyboard and synthetic activation have no double-click sequence.
    if (event.detail === 0 || isMyPromptsView()) {
      handleJumpControlClick('bottom', isMyPromptsView);
    } else if (event.detail === 1) {
      pendingBottomClick = window.setTimeout(() => {
        cancelPendingBottomClick();
        handleJumpControlClick('bottom', isMyPromptsView);
      }, 300);
      document.addEventListener('pointerdown', cancelOnOtherPointer, true);
    }
  });
  bottomButton.addEventListener('dblclick', () => {
    cancelPendingBottomClick();
    handleJumpControlDoubleClick('bottom', isMyPromptsView);
  });

  return cluster;
}

function createSettingsButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'navigator-icon-btn';
  button.id = 'luna-toc-edge-settings-btn';
  button.type = 'button';
  button.setAttribute('aria-label', '打开 LunaTOC 设置');
  button.title = '打开 LunaTOC 设置';
  button.innerHTML = `
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
      <path d="M10.5 2h3l.6 2.2 1.6.7 2-.9 2.1 2.1-.9 2 .7 1.6 2.2.6v3l-2.2.6-.7 1.6.9 2-2.1 2.1-2-.9-1.6.7-.6 2.2h-3l-.6-2.2-1.6-.7-2 .9-2.1-2.1.9-2-.7-1.6-2.2-.6v-3l2.2-.6.7-1.6-.9-2L6.2 4l2 .9 1.6-.7L10.5 2Z" />
    </svg>
  `;
  button.addEventListener('click', openSettingsFromConversation);
  return button;
}

/**
 * Scrolls the My Prompts list to one of its absolute edges.
 */
export function scrollNavigatorListToEdge(
  edge: ConversationEdge,
  behavior: ScrollBehavior = 'smooth'
): void {
  const list = document.getElementById('navigator-list');
  if (!list) return;
  list.scrollTo({
    top: edge === 'top' ? 0 : list.scrollHeight,
    behavior,
  });
}

/**
 * Builds a single jump button with its directional icon.
 * @param {'top' | 'bottom'} edge
 * @returns {HTMLButtonElement}
 */
function createJumpButton(edge: ConversationEdge): HTMLButtonElement {
  const button = document.createElement('button');
  const isTop = edge === 'top';

  button.className = 'navigator-icon-btn';
  button.id = isTop ? 'jump-chat-top-btn' : 'jump-chat-bottom-btn';
  button.type = 'button';
  button.setAttribute('aria-label', isTop ? '跳转到顶部' : '跳转到底部');
  button.innerHTML = `
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="${isTop ? 'M6 5h12M12 19V9M7 14l5-5 5 5' : 'M6 19h12M12 5v10M7 10l5 5 5-5'}" />
    </svg>
  `;

  return button;
}

function handleJumpControlClick(
  edge: ConversationEdge,
  isMyPromptsView: () => boolean
): void {
  if (isMyPromptsView()) {
    scrollNavigatorListToEdge(edge, 'smooth');
    return;
  }
  navigatorController.jumpToEdge(edge);
}

function handleJumpControlDoubleClick(
  edge: ConversationEdge,
  isMyPromptsView: () => boolean
): void {
  if (isMyPromptsView()) {
    scrollNavigatorListToEdge(edge, 'auto');
    return;
  }
  if (edge === 'bottom') {
    navigatorController.jumpToLastPrompt();
    return;
  }
  navigatorController.jumpToAbsoluteEdge(edge);
}
