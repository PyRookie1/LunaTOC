/** Single ownership token for the sidebar's shared list surface. */
export type SidebarViewMode = 'toc' | 'myPrompts';
let mode: SidebarViewMode = 'toc';
export const getSidebarViewMode = (): SidebarViewMode => mode;
export function setSidebarViewMode(next: SidebarViewMode): void {
  mode = next;
}
