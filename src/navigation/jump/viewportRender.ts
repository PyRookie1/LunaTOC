/** Let the host finish measuring and compensating its current virtual window. */
export function waitForViewportRender(
  container: HTMLElement,
  isCancelled: () => boolean
): Promise<void> {
  return new Promise(resolve => {
    const started = Date.now();
    let lastChange = started;
    let top = container.scrollTop;
    let height = container.scrollHeight;
    const observer = new MutationObserver(() => { lastChange = Date.now(); });
    observer.observe(container, { childList: true, subtree: true });
    const poll = (): void => {
      const now = Date.now();
      if (Math.abs(top - container.scrollTop) > 1 || height !== container.scrollHeight) {
        top = container.scrollTop;
        height = container.scrollHeight;
        lastChange = now;
      }
      // The field trace measured host commits/compensation several frames
      // after a write. One rAF only confirms paint, not a settled virtual page.
      if (isCancelled() || !container.isConnected || now - started >= 1000 ||
          (now - started >= 300 && now - lastChange >= 240)) {
        observer.disconnect();
        resolve();
        return;
      }
      setTimeout(poll, 40);
    };
    poll();
  });
}
