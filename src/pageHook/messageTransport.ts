/**
 * One-way MAIN-world -> isolated content-script transport for TOC events.
 * Ordinary window messages are bootstrap-only, not a source of TOC data.
 * A page script that runs before the extension can still interfere with the
 * bootstrap; Chrome's MAIN world is not a security boundary.
 */
export const PAGE_HOOK_PORT_REQUEST = 'LUNATOC_PAGE_HOOK_PORT_REQUEST_V1';
export const PAGE_HOOK_PORT_READY = 'LUNATOC_PAGE_HOOK_PORT_READY_V1';

let trustedPort: MessagePort | null = null;
const buffered: unknown[] = [];
const MAX_BUFFERED = 64;

export function installPageHookMessageTransport(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    if (trustedPort || event.source !== window || event.origin !== location.origin) return;
    const data = event.data as { type?: unknown; requestId?: unknown } | null;
    if (data?.type !== PAGE_HOOK_PORT_REQUEST ||
        typeof data.requestId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(data.requestId)) return;

    const channel = new MessageChannel();
    // Bind once. Subsequent page messages cannot request a second port.
    trustedPort = channel.port1;
    trustedPort.start();
    window.postMessage({
      type: PAGE_HOOK_PORT_READY,
      requestId: data.requestId,
    }, location.origin, [channel.port2]);
    for (const message of buffered.splice(0)) trustedPort.postMessage(message);
  });
}

/** Sends actual data only through the bound port after bootstrap. */
export function postPageHookMessage(message: unknown): void {
  if (trustedPort) {
    trustedPort.postMessage(message);
    return;
  }
  // Preserve early events until the isolated script connects. The window copy
  // is for backwards-compatible diagnostics, not a trusted receive channel.
  if (buffered.length === MAX_BUFFERED) buffered.shift();
  buffered.push(message);
  window.postMessage(message, location.origin);
}
