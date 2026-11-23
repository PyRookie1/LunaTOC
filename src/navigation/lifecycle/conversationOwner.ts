/** Trusted account identity read by the isolated extension context. */
let activeConversationOwner: string | null = null;
let ownerGeneration = 0;
const listeners = new Set<() => void>();

/** Identifies the account and the exact verification lifetime of an operation. */
export interface ConversationOwnerContext { ownerId: string; generation: number }

export function captureConversationOwner(): ConversationOwnerContext | null {
  return activeConversationOwner
    ? { ownerId: activeConversationOwner, generation: ownerGeneration } : null;
}

export function isConversationOwnerCurrent(context: ConversationOwnerContext | null): boolean {
  return context !== null && context.ownerId === activeConversationOwner &&
    context.generation === ownerGeneration;
}

export function setActiveConversationOwner(ownerId: string | null): void {
  if (activeConversationOwner === ownerId) return;
  ownerGeneration += 1;
  activeConversationOwner = ownerId;
  for (const notify of listeners) notify();
}

export function getActiveConversationOwner(): string | null {
  return activeConversationOwner;
}

export function subscribeActiveConversationOwner(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
