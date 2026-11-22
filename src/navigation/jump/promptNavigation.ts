/**
 * Handles main prompt navigation coordinator, fast-path resolution, and public facade for LunaTOC.
 */
import type { NavigatorMessage } from '@/features/conversationPrompts/message';
import { keepFollowing } from '../follow/follow';
import { getActivePlatform } from '@/platforms';
import { loadUntilMountedViaViewport } from './viewportWalker';
import { executeAbsoluteEdgeJump } from './edgeNavigation';
import { findNextAssistantMessage } from './headingExtractor';
import { NAVIGATION_HIGHLIGHT_DURATION_MS } from './highlightTiming';
import { settleTarget } from './settleTarget';

function platform() {
  return getActivePlatform();
}

const findRenderedChatGptPrompt = (
  promptId: string,
  root?: ParentNode
): HTMLElement | null =>
  platform().navigation.findRenderedPrompt(promptId, root);
const findRenderedChatGptPromptByText = (
  text: string,
  root?: ParentNode
): HTMLElement | null =>
  platform().navigation.findRenderedPromptByText?.(text, root) ?? null;
const getChatGptScrollContainer = (root?: ParentNode): HTMLElement | null =>
  platform().navigation.getScrollContainer(root);
const createChatGptNavigationJumpId = (): string =>
  platform().diagnostics.createJumpId();
const logChatGptNavigationEvent = (
  jumpId: string,
  eventName: string,
  details: Record<string, unknown> = {},
  storage?: Storage
): void => platform().diagnostics.logEvent(jumpId, eventName, details, storage);
const isJumpVizDebugEnabled = (
  storage?: Pick<Storage, 'getItem'>
): boolean =>
  platform().diagnostics.isJumpVizDebugEnabled?.(storage) ?? false;

/**
 * Prints the currently-mounted and currently-visible user messages to the
 * console, tagged with the given label so callers can distinguish which
 * phase emitted the dump (e.g. `'fast-path'`, `'pre-search'`,
 * `'post-search'`). Active only when the `lunatoc:debugJumpViz:v1` toggle is
 * `1` in `localStorage`; default off.
 *
 * @param label Phase identifier prepended to the dump.
 */
function logMountedPromptViz(label: string): void {
  const userSelector = platform().config.selectors.userMessage;
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(userSelector)
  );
  const visible = all.filter(function (el) {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  const hidden = all.filter(function (el) {
    const r = el.getBoundingClientRect();
    return !(r.top < window.innerHeight && r.bottom > 0);
  });
  function truncate(s: string, n: number): string {
    const oneLine = s.replace(/\s+/g, ' ').trim();
    return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
  }
  function dump(list: HTMLElement[], header: string): void {
    console.log(`  ${header} (n=${list.length}):`);
    list.forEach(function (el, i) {
      const r = el.getBoundingClientRect();
      const id =
        platform().navigation.getMessageIdFromElement?.(el) ||
        (platform().config.selectors.messageId
          ? el.getAttribute(platform().config.selectors.messageId)
          : null) ||
        '(none)';
      const text = truncate(el.textContent || '', 40);
      console.log(
        `    ${i + 1}. ${id.slice(0, 8)} "${text}"` +
          `  top=${Math.round(r.top)} bot=${Math.round(r.bottom)}`
      );
    });
  }
  console.log(`[🚩LunaTOC viz][${label}] viewport=${window.innerHeight}px`);
  console.log(`  mounted total = ${all.length}`);
  dump(visible, 'visible (in viewport)');
  dump(hidden, 'mounted but not in viewport');
}

export interface VirtualSearchContext {
  conversationKey: string;
  prompts: NavigatorMessage[];
}

export interface PromptNavigationOptions {
  getVirtualSearchContext: () => VirtualSearchContext;
  setJumpProgress: (progress: {
    active: boolean;
    targetIndex: number;
    remainingSteps: number;
  }) => void;
  clearJumpProgress: () => void;
  notifyJumpFailed: () => void;
}

let getVirtualSearchContext: () => VirtualSearchContext = () => ({
  conversationKey: '',
  prompts: [],
});
let setJumpProgress: (progress: {
  active: boolean;
  targetIndex: number;
  remainingSteps: number;
}) => void = () => {};
let clearJumpProgress: () => void = () => {};
let notifyJumpFailed: () => void = () => {};
let navigationJumpVersion = 0;
let stopActiveLanding: (() => void) | null = null;
const TARGET_REMOUNT_RECOVERIES = 2;

/**
 * Connects jump behavior to navigator state and native TOC helpers.
 *
 * @param options Observer and callback hooks for navigation progress.
 */
export function initializePromptNavigation(
  options: PromptNavigationOptions
): void {
  getVirtualSearchContext = options.getVirtualSearchContext;
  setJumpProgress = options.setJumpProgress;
  clearJumpProgress = options.clearJumpProgress;
  notifyJumpFailed = options.notifyJumpFailed;
}

/**
 * Jumps to the start or end of the current ChatGPT conversation.
 *
 * @param edge Target edge: 'top' or 'bottom'.
 */
export function jumpToConversationEdge(edge: 'top' | 'bottom'): void {
  cancelActiveNavigationSearch();
  jumpToAbsoluteEdge(edge, 'auto');
}

/**
 * Applies a temporary highlight effect to a rendered prompt element.
 */
let highlightedPromptElement: HTMLElement | null = null;
let promptHighlightTimeoutId: number | null = null;

function highlightMatchedElement(element: HTMLElement): void {
  if (promptHighlightTimeoutId !== null) {
    window.clearTimeout(promptHighlightTimeoutId);
    promptHighlightTimeoutId = null;
  }
  if (highlightedPromptElement && highlightedPromptElement !== element) {
    highlightedPromptElement.style.outline = '';
    highlightedPromptElement.style.borderRadius = '';
  }

  element.style.outline = '2px solid #60a5fa';
  element.style.borderRadius = '8px';
  highlightedPromptElement = element;

  promptHighlightTimeoutId = window.setTimeout(() => {
    if (highlightedPromptElement === element) {
      element.style.outline = '';
      element.style.borderRadius = '';
      highlightedPromptElement = null;
    }
    promptHighlightTimeoutId = null;
  }, NAVIGATION_HIGHLIGHT_DURATION_MS);
}

/**
 * Jumps to a prompt through the independent virtual navigation engine.
 * Text fallback requires an unambiguous plain-text message identity.
 *
 * @param message Target message representation.
 * @param index 0-indexed position in the conversation.
 */
export function jumpToMessage(
  message: NavigatorMessage,
  index: number,
  edge: 'top' | 'bottom' = 'top'
): void {
  cancelActiveNavigationSearch();
  jumpWithIndependentVirtualNavigation(message, index, edge);
}

/**
 * Uses only LunaTOC anchors, response fingerprints, and virtual search.
 */
function jumpWithIndependentVirtualNavigation(
  message: NavigatorMessage,
  index: number,
  edge: 'top' | 'bottom' = 'top',
  remountRecoveries = TARGET_REMOUNT_RECOVERIES,
  deadline = Date.now() + 30_000
): void {
  const jumpId = createChatGptNavigationJumpId();
  const context = getVirtualSearchContext();
  const container = getChatGptScrollContainer();

  logChatGptNavigationEvent(jumpId, 'JUMP_START', {
    conversationKey: context.conversationKey,
    targetPromptId: message.id,
    targetPromptIndex: index,
    promptCount: context.prompts.length,
  });

  // Keep sidebar selection tracking active across native mounting or a legacy
  // virtual search. This follow window does not gate the conversation jump.
  keepFollowing(15_000);
  setJumpProgress({
    active: true,
    targetIndex: index,
    remainingSteps: 50,
  });

  if (!container || !context.conversationKey) {
    clearJumpProgress();
    logChatGptNavigationEvent(jumpId, 'JUMP_FINISHED', {
      status: 'missing-context',
      hasContainer: Boolean(container),
    });
    return;
  }

  // Changing pixels does not clear the host's independent follow-growth flag.
  // Release it before both the mounted fast path and the virtual viewport walk.
  platform().navigation.prepareForNavigation?.(container);

  // A semantic host jump selects the render window by turn key. Pixel scans
  // and settleTarget must never run alongside an accepted native request.
  const native = edge === 'top' ? platform().navigation.navigateToMessage?.(container, message.id) : null;
  if (native) {
    const version = navigationJumpVersion;
    stopActiveLanding = native.cancel;
    let readyTarget: HTMLElement | null = null;
    void native.ready?.then(shown => {
      if (!shown || version !== navigationJumpVersion) return;
      readyTarget = findRenderedChatGptPrompt(message.id, container);
      if (readyTarget) highlightMatchedElement(readyTarget);
    });
    void native.finished.then(result => {
      if (version !== navigationJumpVersion) return;
      stopActiveLanding = null;
      clearJumpProgress();

      if (result === 'found') {
        const target = findRenderedChatGptPrompt(message.id, container);
        if (target && target !== readyTarget) highlightMatchedElement(target);
      } else if (result === 'failed') notifyJumpFailed();
    });
    return;
  }

  // Fast path: if the target prompt is already mounted anywhere in the
  // DOM (id match exact, text match as fallback for id-string mismatches),
  // scroll straight to it.
  const idHit = findRenderedChatGptPrompt(message.id);
  // A text fallback is safe only for a plain-text prompt unique in the
  // entire conversation, not merely among currently mounted DOM elements.
  const normalizedText = message.text.replace(/\s+/g, ' ').trim().toLowerCase();
  const hasUniqueText = Boolean(
    message.canMatchByText &&
    normalizedText &&
    context.prompts.filter((prompt) =>
      prompt.canMatchByText &&
      prompt.text.replace(/\s+/g, ' ').trim().toLowerCase() === normalizedText
    ).length === 1
  );
  const textHit =
    idHit ?? (hasUniqueText ? findRenderedChatGptPromptByText(message.text) : null);
  const renderedTarget = idHit ?? textHit;

  if (renderedTarget) {
    logChatGptNavigationEvent(jumpId, 'JUMP_FAST_PATH_RESULT', {
      idHit: Boolean(idHit),
      textHit: Boolean(textHit),
      finalElement: renderedTarget.tagName,
    });
    if (isJumpVizDebugEnabled()) {
      logMountedPromptViz('fast-path');
    }
    finishIndependentVirtualJump(renderedTarget, message, index, edge, remountRecoveries, deadline);
    return;
  }

  // Step 2 runs after Step 1 misses. Sequential, never in parallel.
  void (async () => {
    const myNavVersion = navigationJumpVersion;
    const loaded = await loadUntilMountedViaViewport(
      message.id,
      index,
      context.prompts,
      container,
      jumpId,
      () => myNavVersion !== navigationJumpVersion || Date.now() >= deadline
    );
    // A heading jump may cancel the older viewport scan. Do not report
    // a spurious jump failure or move the page after cancellation.
    if (myNavVersion !== navigationJumpVersion) return;
    if (loaded) {
      finishIndependentVirtualJump(loaded, message, index, edge, remountRecoveries, deadline);
      return;
    }

    clearJumpProgress();
    notifyJumpFailed();
    logChatGptNavigationEvent(jumpId, 'JUMP_FINISHED', {
      status: 'not-found',
      attempts: 'step-2-exhausted',
    });
    if (isJumpVizDebugEnabled()) {
      console.log('[LunaTOC jump] target not mounted, giving up silently');
    }
  })();
}

/**
 * Completes an independent jump by highlighting the target and waiting for
 * ChatGPT's virtual rendering to settle. Re-resolves the live target during
 * a bounded verification window before reporting success.
 */
function finishIndependentVirtualJump(
  target: HTMLElement,
  message: NavigatorMessage,
  index: number,
  edge: 'top' | 'bottom',
  remountRecoveries: number,
  deadline: number
): void {
  const jumpVersion = ++navigationJumpVersion;
  const container = getChatGptScrollContainer();
  keepFollowing(1800);

  const resolvePrompt = (): HTMLElement | null => {
    const fresh = findRenderedChatGptPrompt(message.id);
    // The initial node may have been matched by unique text. Reuse it only
    // while it is connected; never navigate to a stale detached reference.
    return fresh ?? (target.isConnected ? target : null);
  };
  const resolveLanding = (): HTMLElement | null => {
    const prompt = resolvePrompt();
    if (!prompt) return null;
    return edge === 'bottom' ? findNextAssistantMessage(prompt) ?? prompt : prompt;
  };
  const finish = (found: boolean): void => {
    if (jumpVersion !== navigationJumpVersion) return;
    clearJumpProgress();

    if (found) {
      const prompt = resolvePrompt();
      if (prompt) highlightMatchedElement(prompt);
    } else {
      notifyJumpFailed();
    }
    logChatGptNavigationEvent(createChatGptNavigationJumpId(), 'JUMP_FINISHED', {
      status: found ? 'found-and-settled' : 'landing-not-settled',
      targetPromptId: message.id,
      targetPromptIndex: index,
    });
  };

  if (!container?.contains(target)) {
    // Unknown host layout: scope the fallback to the nearest scroller.
    const landing = resolveLanding();
    if (landing) {
      const scrollOptions: ScrollIntoViewOptions & { container: 'nearest' } = {
        behavior: 'instant', block: edge === 'top' ? 'start' : 'end', container: 'nearest',
      };
      landing.scrollIntoView(scrollOptions);
    }
    clearJumpProgress();
    if (landing) highlightMatchedElement(target);
    return;
  }

  highlightMatchedElement(target);
  stopActiveLanding = settleTarget({
    container,
    resolveTarget: resolveLanding,
    edge,
    topOffset: platform().navigation.promptTopOffsetPx,
    isCancelled: () => jumpVersion !== navigationJumpVersion,
    onSettled: finish,
    onInterrupted: clearJumpProgress,
    onTargetMissing: remountRecoveries > 0 ? () => {
      if (jumpVersion !== navigationJumpVersion) return;
      if (Date.now() >= deadline) { finish(false); return; }

      jumpWithIndependentVirtualNavigation(message, index, edge, remountRecoveries - 1, deadline);
    } : undefined,
  });
}

/**
 * Jumps to a prompt by index, with optional high-priority lock to keep
 * LunaTOC's sidebar row pinned while ChatGPT scrolls virtualized content.
 * Lives here because outline navigation uses it for heading-to-heading
 * jumps that don't go through the regular TOC entry path.
 *
 * @param index 0-indexed position in the conversation.
 * @param duration Duration in ms to lock active prompt follow tracking.
 * @returns true if jump fired.
 */
export function jumpToPromptIndex(
  index: number,
  duration: number = 4000
): boolean {
  const context = getVirtualSearchContext();
  const message = context.prompts[index];
  if (!message) return false;
  cancelActiveNavigationSearch();
  keepFollowing(duration);
  jumpWithIndependentVirtualNavigation(message, index);
  return true;
}

/**
 * Cancels the currently active independent virtual scan before a new jump.
 */
function cancelActiveNavigationSearch(): void {
  navigationJumpVersion += 1;
  stopActiveLanding?.();
  stopActiveLanding = null;
}

/** Cancels a pending parent-prompt walk before a child-heading landing. */
export function cancelPromptNavigation(): void {
  cancelActiveNavigationSearch();
  clearJumpProgress();
}

/**
 * Scroll the ChatGPT chat feed to the absolute top or bottom.
 *
 * Each click re-asserts `scrollTop = -currentMaxScrollTop` against the
 * *current* scrollHeight and waits briefly for ChatGPT's lazy mount to
 * extend the window.
 *
 * @param edge Target edge: 'top' or 'bottom'.
 * @param behavior Optional ScrollBehavior (default 'auto').
 */
export function jumpToAbsoluteEdge(
  edge: 'top' | 'bottom',
  behavior: ScrollBehavior = 'auto'
): void {
  keepFollowing();
  // A new absolute-edge jump supersedes any in-flight independent virtual
  // jump; otherwise the highlight from a previous TOC click would linger.
  cancelActiveNavigationSearch();
  clearJumpProgress();

  const navVersionAtStart = navigationJumpVersion;
  const firstPromptId =
    edge === 'top'
      ? getVirtualSearchContext().prompts[0]?.id ?? null
      : null;

  executeAbsoluteEdgeJump(edge, {
    firstPromptId,
    isCancelled: () => navVersionAtStart !== navigationJumpVersion,
    onFirstPromptVisible: highlightMatchedElement,
  });
}
