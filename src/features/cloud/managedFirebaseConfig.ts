/** Managed Firebase configuration embedded at build time by the LunaTOC maintainer.
 * These are PUBLIC Firebase Web App identifiers, never service credentials.
 * An unconfigured build must not attempt to use a placeholder backend.
 */
export interface ManagedFirebaseConfig { projectId: string; apiKey: string }
export function bundledFirebaseConfig(): ManagedFirebaseConfig | null {
  const projectId = import.meta.env.VITE_LUNATOC_FIREBASE_PROJECT_ID?.trim() ?? '';
  const apiKey = import.meta.env.VITE_LUNATOC_FIREBASE_WEB_API_KEY?.trim() ?? '';
  return projectId && apiKey ? { projectId, apiKey } : null;
}
