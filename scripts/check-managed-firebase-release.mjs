/** Required for main / release. Firebase Web API Key is PUBLIC, not an admin secret. */
const projectId = process.env.VITE_LUNATOC_FIREBASE_PROJECT_ID ?? '';
const apiKey = process.env.VITE_LUNATOC_FIREBASE_WEB_API_KEY ?? '';
if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId) ||
    !/^[A-Za-z0-9_-]{16,200}$/.test(apiKey) ||
    projectId.startsWith('demo-') ||
    apiKey.includes('placeholder')) {
  console.error('LunaTOC 1.0.0 release BLOCKED: maintainer-owned Firebase project is not configured.');
  console.error('Set repository variables LUNATOC_FIREBASE_PROJECT_ID and LUNATOC_FIREBASE_WEB_API_KEY.');
  console.error('Deploy firestore.rules, enable Email/Password Auth and complete a live smoke test before release.');
  process.exitCode = 1;
} else {
  console.log('LunaTOC maintainer Firebase project identifiers are configured. Live smoke test is still required.');
}
