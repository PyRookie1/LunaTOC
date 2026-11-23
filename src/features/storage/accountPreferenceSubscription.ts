/** Orders initial hydration, account changes and storage events for one preference. */
import { ACCOUNT_SETTINGS_KEY, resolveAccountSettingsOwner } from './accountSettings';
import {
  getActiveConversationOwner,
  subscribeActiveConversationOwner,
} from '@/navigation/lifecycle/conversationOwner';

export function subscribeAccountPreference<T>(
  listener: (value: T) => void,
  read: (ownerId: string) => Promise<T>,
  normalizeRecord: (record: unknown) => T,
  defaults: () => T,
  ownerId?: string,
): () => void {
  let owner = ownerId ?? getActiveConversationOwner();
  let active = true;
  let revision = 0;
  const hydrate = (next: string | null): void => {
    owner = next;
    const requested = ++revision;
    if (!next) {
      listener(defaults());
      return;
    }
    void read(next)
      .then((value) => {
        if (active && requested === revision) listener(value);
      })
      .catch(() => {
        if (active && requested === revision) listener(defaults());
      });
  };
  const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (!active || area !== 'local' || !changes[ACCOUNT_SETTINGS_KEY]) return;
    if (!owner) return;
    revision += 1;
    const map = changes[ACCOUNT_SETTINGS_KEY].newValue as unknown;
    const record =
      owner && map && typeof map === 'object' && !Array.isArray(map) && Object.hasOwn(map, owner)
        ? (map as Record<string, unknown>)[owner]
        : undefined;
    listener(normalizeRecord(record));
  };
  chrome.storage.onChanged.addListener(onChange);
  const unsubscribeOwner = ownerId
    ? () => {}
    : subscribeActiveConversationOwner(() => {
        hydrate(getActiveConversationOwner());
      });
  if (owner) hydrate(owner);
  else {
    const requested = revision;
    void resolveAccountSettingsOwner()
      .then((resolved) => {
        if (active && requested === revision) hydrate(resolved);
      })
      .catch(() => {});
  }
  return () => {
    active = false;
    revision += 1;
    chrome.storage.onChanged.removeListener(onChange);
    unsubscribeOwner();
  };
}
