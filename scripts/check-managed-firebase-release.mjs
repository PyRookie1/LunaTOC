/** Required for main / release. Firebase Web API Key is PUBLIC, not an admin secret. */
const projectId = process.env.VITE_LUNATOC_FIREBASE_PROJECT_ID ?? '';
const apiKey = process.env.VITE_LUNATOC_FIREBASE_WEB_API_KEY ?? '';
const googleOAuthClientId = process.env.VITE_LUNATOC_GOOGLE_OAUTH_CLIENT_ID ?? '';
if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId) ||
    !/^[A-Za-z0-9_-]{16,200}$/.test(apiKey) ||
    !/^[0-9]+-[a-z0-9-]+\\.apps\\.googleusercontent\\.com$/.test(googleOAuthClientId) ||
    projectId.startsWith('demo-') ||
    apiKey.includes('placeholder')) {
  console.error('LunaTOC 1.0.0 release BLOCKED: maintainer-owned Firebase project is not configured.');
  console.error('Set repository variables LUNATOC_FIREBASE_PROJECT_ID, LUNATOC_FIREBASE_WEB_API_KEY and LUNATOC_GOOGLE_OAUTH_CLIENT_ID.');
  console.error('Deploy firestore.rules, enable Google sign-in and complete a live smoke test before release.');
  process.exitCode = 1;
} else {
  console.log('LunaTOC Firebase and Google OAuth configuration is present. Live smoke test is still required.');
}
