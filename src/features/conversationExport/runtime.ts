import { subscribeTrustedPageHookMessage } from '@/navigation/pageHookMessageTransport';
import { CHATGPT_MESSAGE_TYPES } from '@/platforms/chatgpt/messages';
import { CAPTURE_GENERATION_EVENT } from '@/navigation/refresh/refreshProtocol';
import { extractActiveBranchMessages, type ConversationSnapshot } from '@/navigation/state/activeBranch';

interface ObservedRoute {
  anchor: string | null;
  active: Set<string>;
  completedAt: number;
}
const routes = new Map<string, ObservedRoute>();
let installed = false;

function state(routeKey: string): ObservedRoute {
  let item = routes.get(routeKey);
  if (!item) {
    item = { anchor: null, active: new Set(), completedAt: 0 };
    routes.set(routeKey, item);
    if (routes.size > 8) routes.delete(routes.keys().next().value!);
  }
  return item;
}

/** Reuses existing events; stores identifiers only, never conversation bodies. */
export function installCaptureRuntime(): void {
  if (installed) return;
  installed = true;
  subscribeTrustedPageHookMessage(event => {
    const data = event.data;
    if (typeof data?.routeKey !== 'string') return;
    const item = state(data.routeKey);
    if (data.type === CHATGPT_MESSAGE_TYPES.conversationData) {
      const snapshot = data.payload as ConversationSnapshot;
      const branch = extractActiveBranchMessages(snapshot);
      if (branch?.length && snapshot.page_info?.has_previous_page === false) {
        item.anchor = branch[branch.length - 1].id;
      } else if (typeof snapshot?.current_node === 'string' && snapshot.current_node &&
          (snapshot.messages?.some(message => message.id === snapshot.current_node) ||
           snapshot.mapping?.[snapshot.current_node])) {
        // The observed leaf can bound identities even when older pages are not mounted.
        // It still provides no atomic content/version guarantee.
        item.anchor = snapshot.current_node;
      }
    }
    if (data.type === CHATGPT_MESSAGE_TYPES.newUserMessage) item.anchor = null;
    if (data.type === CAPTURE_GENERATION_EVENT && typeof data.requestId === 'string') {
      if (data.phase === 'started') {
        item.active.add(data.requestId);
        item.anchor = null;
      } else if (data.phase === 'ended' || data.phase === 'failed') {
        item.active.delete(data.requestId);
        item.completedAt = performance.now();
      }
    }
  });
}

export function observedClickAnchor(routeKey: string): string | null {
  return routes.get(routeKey)?.anchor ?? null;
}

export type GenerationState = 'generating' | 'settling' | 'ready' | 'unknown';

/** Unknown is deliberately not equivalent to idle or exportable. */
export function generationState(routeKey: string, root: ParentNode = document,
  snapshot?: ConversationSnapshot): GenerationState {
  const item = routes.get(routeKey);
  const busy = root.querySelector('[data-testid="stop-button"], [data-is-streaming="true"], [aria-busy="true"], button[aria-label="Stop generating"], button[aria-label="停止生成"], button[aria-label="停止回答"]');
  if (item?.active.size || busy) return 'generating';
  if (item?.completedAt && performance.now() - item.completedAt < 1_000) return 'settling';
  const last = snapshot?.messages.filter(message => message.author?.role === 'assistant').at(-1) as
    ({ status?: unknown; end_turn?: unknown } | undefined);
  const pending = snapshot?.messages.some(message =>
    ['in_progress', 'pending', 'streaming'].includes(String((message as unknown as { status?: unknown }).status)));
  if (!pending && last && (last.end_turn === true ||
      ['finished_successfully', 'finished_partial', 'cancelled', 'failed'].includes(String(last.status)))) return 'ready';
  return 'unknown';
}
