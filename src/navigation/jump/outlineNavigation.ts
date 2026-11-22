/**
 * Scrolls a selected answer heading into the ChatGPT thread scroll container.
 * Parent-prompt virtual loading is cancelled before the final heading landing.
 */
import { getActivePlatform } from '@/platforms';
import { cancelPromptNavigation, jumpToPromptIndex } from './promptNavigation';
import { keepFollowing } from '../follow/follow';
import { logOutlineDiagnostic } from './outlineDiagnostics';
import { NAVIGATION_HIGHLIGHT_DURATION_MS } from './highlightTiming';
import { settleTarget } from './settleTarget';

export interface OutlineNavigationEntry {
  element?: HTMLElement;
  sectionId?: string;
  text?: string;
}

export type OutlineHeadingResolver = () => HTMLElement | null;

const HEADING_HIGHLIGHT_CLASS = 'chat-toc-outline-heading-highlight';
const OUTLINE_JUMP_RETRY_DELAY_MS = 250;
const OUTLINE_JUMP_MAX_ATTEMPTS = 40;
const HEADING_TOP_OFFSET_PX = 72;

let highlightedHeadingElement: HTMLElement | null = null;
let headingHighlightTimeoutId: number | null = null;
let outlineJumpVersion = 0;
let stopActiveLanding: (() => void) | null = null;

export function jumpToOutlineEntry(
  entry: OutlineNavigationEntry,
  promptIndex: number,
  resolveCurrentHeading: OutlineHeadingResolver
): void {
  stopActiveLanding?.();
  stopActiveLanding = null;
  const jumpVersion = ++outlineJumpVersion;
  logOutlineDiagnostic('OUTLINE_JUMP_STARTED', {
    promptIndex,
    text: entry.text || null,
    sectionId: entry.sectionId || null,
    cachedElementConnected: entry.element?.isConnected ?? false,
    jumpVersion,
  });

  // A connected cached node can still belong to an abandoned answer branch.
  // Always resolve the heading against the current prompt/answer DOM.
  const heading = resolveCurrentHeading();
  if (heading?.isConnected) {
    finishOutlineEntryJump(heading, promptIndex, jumpVersion, resolveCurrentHeading);
    return;
  }

  // The assistant answer may be virtualized. Mount its parent first and
  // retry the *current* heading rather than jumping to a stale cached node.
  if (!jumpToPromptIndex(
    promptIndex,
    OUTLINE_JUMP_MAX_ATTEMPTS * OUTLINE_JUMP_RETRY_DELAY_MS
  )) return;

  retryOutlineEntryJump(
    entry,
    promptIndex,
    OUTLINE_JUMP_MAX_ATTEMPTS,
    jumpVersion,
    resolveCurrentHeading
  );
}

export function cancelOutlineNavigation(): void {
  outlineJumpVersion += 1;
  stopActiveLanding?.();
  stopActiveLanding = null;
  clearHighlightedHeading();
}

function retryOutlineEntryJump(
  entry: OutlineNavigationEntry,
  promptIndex: number,
  attempts: number,
  jumpVersion: number,
  resolveCurrentHeading: OutlineHeadingResolver
): void {
  if (jumpVersion !== outlineJumpVersion) return;

  const heading = resolveCurrentHeading();
  if (heading?.isConnected) {
    finishOutlineEntryJump(heading, promptIndex, jumpVersion, resolveCurrentHeading);
    return;
  }
  if (attempts <= 1) {
    logOutlineDiagnostic('OUTLINE_JUMP_EXHAUSTED', {
      promptIndex,
      text: entry.text || null,
      sectionId: entry.sectionId || null,
      jumpVersion,
    });
    return;
  }
  window.setTimeout(() => retryOutlineEntryJump(
    entry,
    promptIndex,
    attempts - 1,
    jumpVersion,
    resolveCurrentHeading
  ), OUTLINE_JUMP_RETRY_DELAY_MS);
}

function finishOutlineEntryJump(
  heading: HTMLElement,
  promptIndex: number,
  jumpVersion: number,
  resolveCurrentHeading: OutlineHeadingResolver
): void {
  if (jumpVersion !== outlineJumpVersion) return;

  // The parent navigation may still be walking the virtual viewport.
  // Cancelling it before positioning avoids its later scroll overriding us.
  cancelPromptNavigation();
  keepFollowing();
  highlightHeading(heading);
  const container = findHeadingContainer(heading);
  if (container) {
    getActivePlatform().navigation.prepareForNavigation?.(container);
    stopActiveLanding = settleTarget({
      container,
      resolveTarget: resolveCurrentHeading,
      edge: 'top',
      topOffset: HEADING_TOP_OFFSET_PX,
      isCancelled: () => jumpVersion !== outlineJumpVersion,
      onSettled: (found) => logOutlineDiagnostic(
        found ? 'OUTLINE_JUMP_SETTLED' : 'OUTLINE_JUMP_EXHAUSTED',
        { promptIndex, jumpVersion }
      ),
    });
  } else {
    heading.scrollIntoView?.({ behavior: 'instant', block: 'start' });
  }

  logOutlineDiagnostic('OUTLINE_JUMP_RESOLVED', {
    promptIndex,
    headingText: heading.textContent?.trim() || null,
    sectionId: heading.dataset.sectionId || null,
    jumpVersion,
  });
}

function findHeadingContainer(heading: HTMLElement): HTMLElement | null {
  const nav = getActivePlatform().navigation;
  const candidates = [
    nav.getThreadScrollContainer?.(),
    nav.getScrollContainer(),
  ];
  return candidates.find((candidate): candidate is HTMLElement =>
    !!candidate?.isConnected && candidate.contains(heading)
  ) ?? null;
}

function highlightHeading(heading: HTMLElement): void {
  clearHighlightedHeading();
  heading.classList.add(HEADING_HIGHLIGHT_CLASS);
  highlightedHeadingElement = heading;
  headingHighlightTimeoutId = window.setTimeout(() => {
    if (highlightedHeadingElement === heading) {
      heading.classList.remove(HEADING_HIGHLIGHT_CLASS);
      highlightedHeadingElement = null;
    }
    headingHighlightTimeoutId = null;
  }, NAVIGATION_HIGHLIGHT_DURATION_MS);
}

function clearHighlightedHeading(): void {
  if (headingHighlightTimeoutId !== null) {
    window.clearTimeout(headingHighlightTimeoutId);
    headingHighlightTimeoutId = null;
  }
  highlightedHeadingElement?.classList.remove(HEADING_HIGHLIGHT_CLASS);
  highlightedHeadingElement = null;
}
