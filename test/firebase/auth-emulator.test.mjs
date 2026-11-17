/**
 * Phase 6 integration regression: exercise real Firebase Auth and Firestore
 * emulator tokens together. The emulator exposes verification/reset OOB codes
 * locally; no production email or Firebase project is contacted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  applyActionCode,
  connectAuthEmulator,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  getAuth,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';

const projectId = 'demo-lunatoc-ci';
const authHost = '127.0.0.1';
const authPort = 9099;
const firestoreHost = '127.0.0.1';
const firestorePort = 8080;
const email = `phase6-${randomUUID()}@example.com`;
const password = 'phase6-initial-password-123!';
const resetPassword = 'phase6-reset-password-456!';
const accountHash = 'acct_' + 'd'.repeat(64);
const snapshotJson = JSON.stringify({
    prompts: [],
  aliases: {},
  settings: null,
  deletedRoutes: [],
  deletedAliases: [],
  deletedPrompts: [],
});

function createEmulatorClient(label) {
  const app = initializeApp({
    apiKey: 'fake-api-key',
    authDomain: 'localhost',
    projectId,
  }, `phase6-${label}-${randomUUID()}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${authHost}:${authPort}`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, firestoreHost, firestorePort);
  return { app, auth, db };
}

async function getOobCode(targetEmail, requestType) {
  const response = await fetch(
    `http://${authHost}:${authPort}/emulator/v1/projects/${projectId}/oobCodes`,
  );
  assert.equal(response.ok, true, `Auth Emulator OOB endpoint returned HTTP ${response.status}`);
  const payload = await response.json();
  const match = payload.oobCodes?.find((entry) =>
    entry.email === targetEmail && entry.requestType === requestType,
  );
  assert.ok(match?.oobCode, `missing ${requestType} code for ${targetEmail}`);
  return match.oobCode;
}

async function expectPermissionDenied(operation) {
  await assert.rejects(operation, (error) => error?.code === 'permission-denied');
}

async function verifyEmail(client, targetEmail) {
  await sendEmailVerification(client.auth.currentUser);
  const code = await getOobCode(targetEmail, 'VERIFY_EMAIL');
  await applyActionCode(client.auth, code);
  await reload(client.auth.currentUser);
  await client.auth.currentUser.getIdToken(true);
  assert.equal(client.auth.currentUser.emailVerified, true);
}

async function createSnapshot(client, uid, hash = accountHash) {
  const accountRef = doc(client.db, 'users', uid, 'accounts', hash);
  const quotaRef = doc(client.db, 'users', uid, 'usage', 'cloudWrites');
  const batch = writeBatch(client.db);
  batch.set(accountRef, { json: snapshotJson });
  batch.set(quotaRef, {
        accountHashes: [hash],
    lastAccountHash: hash,
    dailyWrites: 1,
    windowStart: serverTimestamp(),
    lastWriteAt: serverTimestamp(),
  });
  await batch.commit();
  return accountRef;
}

test('Firebase Auth Emulator registration, verification, password reset and UID isolation', async (t) => {
  const alice = createEmulatorClient('alice');
  const bob = createEmulatorClient('bob');
  let aliceUid = '';
  let bobUid = '';

  try {
    await t.test('registration creates an unverified user and Firestore denies access', async () => {
      const credential = await createUserWithEmailAndPassword(alice.auth, email, password);
      aliceUid = credential.user.uid;
      assert.ok(aliceUid);
      assert.equal(credential.user.emailVerified, false);

      const accountRef = doc(alice.db, 'users', aliceUid, 'accounts', accountHash);
      const quotaRef = doc(alice.db, 'users', aliceUid, 'usage', 'cloudWrites');
      await expectPermissionDenied(getDoc(accountRef));
      await expectPermissionDenied(getDoc(quotaRef));
      await expectPermissionDenied(createSnapshot(alice, aliceUid));
    });

    await t.test('verification OOB code updates the signed-in user and allows atomic snapshot/quota writes', async () => {
      await verifyEmail(alice, email);
      const accountRef = await createSnapshot(alice, aliceUid);
      const stored = await getDoc(accountRef);
      assert.equal(stored.exists(), true);
      assert.equal(stored.data().json, snapshotJson);

      const quotaRef = doc(alice.db, 'users', aliceUid, 'usage', 'cloudWrites');
      const quota = await getDoc(quotaRef);
      assert.equal(quota.data().dailyWrites, 1);
      assert.deepEqual(quota.data().accountHashes, [accountHash]);
    });

    await t.test('wrong password is rejected without creating an authenticated session', async () => {
      await signOut(alice.auth);
      await assert.rejects(
        signInWithEmailAndPassword(alice.auth, email, 'incorrect-password-000!'),
        (error) => ['auth/invalid-credential', 'auth/wrong-password'].includes(error?.code),
      );
      assert.equal(alice.auth.currentUser, null);

      const credential = await signInWithEmailAndPassword(alice.auth, email, password);
      assert.equal(credential.user.uid, aliceUid);
      assert.equal(credential.user.emailVerified, true);
    });

    await t.test('password reset OOB code changes the password and preserves verification', async () => {
      await signOut(alice.auth);
      await sendPasswordResetEmail(alice.auth, email);
      const code = await getOobCode(email, 'PASSWORD_RESET');
      await confirmPasswordReset(alice.auth, code, resetPassword);

      await assert.rejects(
        signInWithEmailAndPassword(alice.auth, email, password),
        (error) => ['auth/invalid-credential', 'auth/wrong-password'].includes(error?.code),
      );
      assert.equal(alice.auth.currentUser, null);

      const credential = await signInWithEmailAndPassword(alice.auth, email, resetPassword);
      assert.equal(credential.user.emailVerified, true);
      assert.equal(credential.user.uid, aliceUid);
    });

    await t.test('a second verified UID cannot read or write the first UID snapshot or quota', async () => {
      const bobEmail = `phase6-bob-${randomUUID()}@example.com`;
      const bobCredential = await createUserWithEmailAndPassword(
        bob.auth, bobEmail, 'phase6-bob-password-123!',
      );
      bobUid = bobCredential.user.uid;
      assert.notEqual(bobUid, aliceUid);
      await verifyEmail(bob, bobEmail);

      const aliceAccountRef = doc(bob.db, 'users', aliceUid, 'accounts', accountHash);
      const aliceQuotaRef = doc(bob.db, 'users', aliceUid, 'usage', 'cloudWrites');
      await expectPermissionDenied(getDoc(aliceAccountRef));
      await expectPermissionDenied(getDoc(aliceQuotaRef));
      await expectPermissionDenied(createSnapshot(bob, aliceUid));

      const bobHash = 'acct_' + 'e'.repeat(64);
      const bobAccountRef = await createSnapshot(bob, bobUid, bobHash);
      assert.equal((await getDoc(bobAccountRef)).exists(), true);

      const bobPathFromAlice = doc(alice.db, 'users', bobUid, 'accounts', bobHash);
      await expectPermissionDenied(getDoc(bobPathFromAlice));
    });
  } finally {
    await Promise.all([
      alice.auth.currentUser ? alice.auth.currentUser.delete().catch(() => {}) : Promise.resolve(),
      bob.auth.currentUser ? bob.auth.currentUser.delete().catch(() => {}) : Promise.resolve(),
    ]);
    await Promise.all([deleteApp(alice.app), deleteApp(bob.app)]);
  }
});
