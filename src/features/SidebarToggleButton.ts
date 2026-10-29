/**
 * Creates the minimal, unlabeled, full-height right-edge sidebar reveal handle.
 *
 * Its position is defined exclusively by the current CSS, without stored offsets.
 */

/**
 * Creates the accessible right-edge trigger without visible text or icons.
 * The invisible 6px-wide, full-height activation area is defined in content.css.
 * @returns {HTMLButtonElement} The sidebar reveal handle.
 */
export function createSidebarToggleButton(): HTMLButtonElement {
  const dock = document.createElement('div');
  dock.id = 'luna-toc-floating-dock';

  const trigger = document.createElement('button');
  trigger.id = 'luna-toc-toggle-btn';
  trigger.type = 'button';
  trigger.className = 'luna-toc-sidebar-hidden';
  trigger.setAttribute('aria-label', '展开目录');
  trigger.setAttribute('aria-expanded', 'false');

  dock.appendChild(trigger);
  document.body.appendChild(dock);
  return trigger;
}
