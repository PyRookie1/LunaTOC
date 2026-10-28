/** Managed Firebase configuration embedded at build time by the LunaTOC maintainer.
 * These are PUBLIC Firebase Web App identifiers, never service credentials.
 * An unconfigured build must not attempt to use a placeholder backend.
 */
export interface ManagedFirebaseConfig { projectId: string; apiKey: string; googleOAuthClientId: string }
export function bundledFirebaseConfig(): ManagedFirebaseConfig | null {
  const projectId = import.meta.env.VITE_LUNATOC_FIREBASE_PROJECT_ID?.trim() ?? '';
  const apiKey = import.meta.env.VITE_LUNATOC_FIREBASE_WEB_API_KEY?.trim() ?? '';
  const googleOAuthClientId = import.meta.env.VITE_LUNATOC_GOOGLE_OAUTH_CLIENT_ID?.trim() ?? '';
  const validOAuthClient = /^[0-9]+-[a-z0-9-]+\\.apps\\.googleusercontent\\.com$/.test(googleOAuthClientId);
  return projectId && apiKey && validOAuthClient ? { projectId, apiKey, googleOAuthClientId } : null;
}
