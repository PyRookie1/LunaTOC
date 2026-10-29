/** Actual Firestore Security Rules, running against the Local Emulator Suite.
 * The test uses Firebase mock auth, not stubbed HTTP or arbitrary fake rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, collection, getDoc, getDocs, setDoc, deleteDoc, updateDoc,
} from 'firebase/firestore';

const projectId = 'demo-lunatoc-ci';
const accountHash = 'acct_' + 'a'.repeat(64);
const validJson = JSON.stringify({
  version: 1, prompts: [], aliases: {}, settings: null, deletedRoutes: [],
});
const env = await initializeTestEnvironment({
  projectId,
  firestore: {
    rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
    host: '127.0.0.1',
    port: 8080,
  },
});
const alice = env.authenticatedContext('firebase-alice', { email_verified: true });
const bob = env.authenticatedContext('firebase-bob', { email_verified: true });
const notVerified = env.authenticatedContext('firebase-alice', { email_verified: false });
const visitor = env.unauthenticatedContext();
const path = (uid = 'firebase-alice', account = accountHash) =>
  ['users', uid, 'accounts', account];

try {
  await test('owner can create, get and update their own account snapshot', async () => {
    const ref = doc(alice.firestore(), ...path());
    await assertSucceeds(setDoc(ref, { json: validJson }));
    const received = await assertSucceeds(getDoc(ref));
    assert.equal(received.data().json, validJson);
    await assertSucceeds(updateDoc(ref, { json: validJson + ' ' }));
  });

  await test('another Firebase UID cannot read or write the owner document', async () => {
    const ref = doc(bob.firestore(), ...path());
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, { json: validJson }));
    await assertFails(updateDoc(ref, { json: validJson }));
    await assertFails(deleteDoc(ref));
  });

  await test('an unverified email cannot access the owner document', async () => {
    const ref = doc(notVerified.firestore(), ...path());
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, { json: validJson }));
    await assertFails(updateDoc(ref, { json: validJson }));
  });

  await test('unauthenticated requests cannot access the account document', async () => {
    const ref = doc(visitor.firestore(), ...path());
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, { json: validJson }));
  });

  await test('collection listing and document deletion are forbidden even for owner', async () => {
    await assertFails(getDocs(collection(alice.firestore(), 'users', 'firebase-alice', 'accounts')));
    await assertFails(deleteDoc(doc(alice.firestore(), ...path())));
  });

  await test('writing another Firebase UID partition fails', async () => {
    await assertFails(setDoc(doc(alice.firestore(), ...path('firebase-bob')), { json: validJson }));
  });

  await test('only the exact account hash pattern is accepted for writes', async () => {
    await assertFails(setDoc(doc(alice.firestore(), ...path('firebase-alice', 'acct-invalid')),
      { json: validJson }));
  });

  await test('unexpected document fields or incorrect json type are rejected', async () => {
    const ref = doc(alice.firestore(), ...path());
    await assertFails(setDoc(ref, { json: validJson, other: 'secret' }));
    await assertFails(setDoc(ref, { json: { nested: 'not-string' } }));
  });

  await test('oversize snapshot string is rejected by security rules', async () => {
    const ref = doc(alice.firestore(), ...path());
    await assertFails(setDoc(ref, { json: 'x'.repeat(240_001) }));
  });

  await test('default deny protects every other collection path', async () => {
    await assertFails(setDoc(doc(alice.firestore(), 'admin', 'private'), { json: validJson }));
    await assertFails(getDoc(doc(alice.firestore(), 'admin', 'private')));
  });
} finally {
  await env.cleanup();
}
