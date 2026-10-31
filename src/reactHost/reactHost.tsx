/**
 * Owns the Shadow DOM environment that isolates LunaTOC React components,
 * Tailwind styles, and portal content from the host page.
 */
import { createRoot } from 'react-dom/client';

import { PromptAutocompleteHost } from '@/components/my-prompts/PromptAutocomplete';
import { PromptContextMenuHost } from '@/components/my-prompts/PromptContextMenu';
import { PromptEditorDialogHost } from '@/components/my-prompts/PromptEditorDialog';
import { ContractAlert } from '@/features/contractAlert/ContractAlert';
import {
  setReactPortalContainer,
  getReactPortalContainer,
} from './portalContainer';
import tailwindCss from '@/styles/tailwind.css?inline';

export { getReactPortalContainer };

const REACT_HOST_ID = 'luna-toc-react-host';
const REACT_ROOT_ID = 'luna-toc-react-root';
const PRIVATE_HOST_ID = 'luna-toc-private-react-host';
const PRIVATE_ROOT_ID = 'luna-toc-private-react-root';
const PORTAL_ROOT_ID = 'luna-toc-private-react-portals';

/**
 * Creates the isolated React host once the document body is available.
 * Repeated calls are safe because an existing host is left unchanged.
 *
 * @example
 * void initializeReactHost();
 */
export async function initializeReactHost(): Promise<void> {
  await waitForBody();

  if (document.getElementById(REACT_HOST_ID)) return;

  // Keep ordinary menus in a public shadow tree for compatibility with
  // existing browser interactions and accessibility tooling.
  const host = document.createElement('div');
  host.id = REACT_HOST_ID;
  host.style.display = 'contents';
  synchronizeTheme(host);
  const publicShadowRoot = host.attachShadow({ mode: 'open' });
  const publicStyle = document.createElement('style');
  publicStyle.textContent = tailwindCss;
  const publicContainer = document.createElement('div');
  publicContainer.id = REACT_ROOT_ID;
  publicContainer.className = 'luna-toc-ui';
  publicShadowRoot.append(publicStyle, publicContainer);

  // Saved prompt bodies only appear inside this separate closed tree.
  // Neither the editor's textarea nor autocomplete suggestions are placed
  // into the page-traversable public root.
  const privateHost = document.createElement('div');
  privateHost.id = PRIVATE_HOST_ID;
  privateHost.style.display = 'contents';
  synchronizeTheme(privateHost);
  const privateShadowRoot = privateHost.attachShadow({ mode: 'closed' });
  const privateStyle = document.createElement('style');
  privateStyle.textContent = tailwindCss;
  const privateContainer = document.createElement('div');
  privateContainer.id = PRIVATE_ROOT_ID;
  privateContainer.className = 'luna-toc-ui';
  const portalContainer = document.createElement('div');
  portalContainer.id = PORTAL_ROOT_ID;
  portalContainer.className = 'luna-toc-ui';
  setReactPortalContainer(portalContainer);
  privateShadowRoot.append(privateStyle, privateContainer, portalContainer);

  document.body.append(host, privateHost);

  createRoot(publicContainer).render(
    <>
      <PromptContextMenuHost />
      <ContractAlert />
    </>
  );
  createRoot(privateContainer).render(
    <>
      <PromptAutocompleteHost />
      <PromptEditorDialogHost />
    </>
  );
}

/**
 * Waits for the body because the Content Script starts at document_start.
 */
function waitForBody(): Promise<HTMLElement> {
  return new Promise((resolve) => {
    if (document.body) {
      resolve(document.body);
      return;
    }

    const timer = setInterval(() => {
      if (!document.body) return;
      clearInterval(timer);
      resolve(document.body);
    }, 50);
  });
}

/**
 * Mirrors LunaTOC's isolated theme marker onto the host because selectors cannot
 * cross the Shadow DOM boundary from the component stylesheet.
 */
function synchronizeTheme(host: HTMLElement): void {
  const updateTheme = (): void => {
    host.dataset.theme =
      document.documentElement.dataset.lunaTocTheme === 'light' ? 'light' : 'dark';
  };

  updateTheme();
  new MutationObserver(updateTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-luna-toc-theme'],
  });
}
