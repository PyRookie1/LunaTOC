/** Required for main / release. Firebase Web API Key is PUBLIC, not an admin secret. */
const projectId = process.env.VITE_LUNATOC_FIREBASE_PROJECT_ID ?? '';
const apiKey = process.env.VITE_LUNATOC_FIREBASE_WEB_API_KEY ?? '';
const authDomain = process.env.VITE_LUNATOC_FIREBASE_AUTH_DOMAIN ?? '';
if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId) ||
    !/^[A-Za-z0-9_-]{16,200}$/.test(apiKey) ||
    !/^[a-z0-9-]+\.(?:firebaseapp\.com|web\.app)$/.test(authDomain) ||
    projectId.startsWith('demo-') ||
    apiKey.includes('placeholder')) {
  console.error('LunaTOC 1.0.0 release BLOCKED: maintainer-owned Firebase project is not configured.');
  console.error('Set repository variables LUNATOC_FIREBASE_PROJECT_ID, LUNATOC_FIREBASE_WEB_API_KEY and LUNATOC_FIREBASE_AUTH_DOMAIN.');
  console.error('Deploy firestore.rules, enable Email/Password sign-in, disable passwordless Email link, require email verification, authorize the Hosting domain, and run live smoke tests.');
  process.exitCode = 1;
} else {
  console.log('LunaTOC Firebase email/password configuration is present. Live signup, verification and sync smoke tests are still required.');
}
