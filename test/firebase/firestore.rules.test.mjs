/** Actual Firestore Security Rules, running against the Local Emulator Suite.
 * The tests use Firebase mock auth and atomic multi-document writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, collection, getDoc, getDocs, setDoc, deleteDoc, updateDoc,
  writeBatch, serverTimestamp, Timestamp,
} from 'firebase/firestore';

const projectId = 'demo-lunatoc-ci';
const accountHash = 'acct_' + 'a'.repeat(64);
const validJson = JSON.stringify({
  prompts: [], aliases: {}, settings: null,
  deletedRoutes: [], deletedAliases: [], deletedPrompts: [],
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
const quotaPath = (uid = 'firebase-alice') => ['users', uid, 'usage', 'cloudWrites'];

function quotaData(overrides = {}) {
  return {
        accountHashes: [accountHash],
    lastAccountHash: accountHash,
    dailyWrites: 1,
    windowStart: serverTimestamp(),
    lastWriteAt: serverTimestamp(),
    ...overrides,
  };
}

async function commitAccountAndQuota(context, {
  uid = 'firebase-alice',
  hash = accountHash,
  json = validJson,
  quota = {},
} = {}) {
  const db = context.firestore();
  const batch = writeBatch(db);
  batch.set(doc(db, ...path(uid, hash)), { json });
  batch.set(doc(db, ...quotaPath(uid)), quotaData({
    accountHashes: [hash],
    lastAccountHash: hash,
    ...quota,
  }));
  return batch.commit();
}

async function seed(uid, hash, {
  json = validJson,
  dailyWrites = 1,
  accountHashes = [hash],
  windowStart = Timestamp.fromMillis(Date.now() - 60_000),
  lastWriteAt = Timestamp.fromMillis(Date.now() - 10_000),
} = {}) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, ...path(uid, hash)), { json });
    await setDoc(doc(db, ...quotaPath(uid)), {
      accountHashes, lastAccountHash: hash,
      dailyWrites, windowStart, lastWriteAt,
    });
  });
}

try {
  await test('owner creates an account snapshot and consumes quota in one atomic commit', async () => {
    await env.clearFirestore();
    const db = alice.firestore();
    await assertSucceeds(commitAccountAndQuota(alice));
    const received = await assertSucceeds(getDoc(doc(db, ...path())));
    const quota = await assertSucceeds(getDoc(doc(db, ...quotaPath())));
    assert.equal(received.data().json, validJson);
    assert.equal(quota.data().dailyWrites, 1);
    assert.deepEqual(quota.data().accountHashes, [accountHash]);
    assert.equal(quota.data().lastAccountHash, accountHash);
    assert.equal(Object.hasOwn(quota.data(), 'version'), false);
  });

  await test('the server rejects quota documents with data-version metadata', async () => {
    await env.clearFirestore();
    await assertFails(commitAccountAndQuota(alice, { quota: { version: 1 } }));
  });

  await test('direct account writes without a matching quota mutation are rejected', async () => {
    await env.clearFirestore();
    const db = alice.firestore();
    await assertFails(setDoc(doc(db, ...path()), { json: validJson }));
    await seed('firebase-alice', accountHash);
    await assertFails(updateDoc(doc(db, ...path()), { json: validJson + ' ' }));
  });

  await test('the server rejects a second write inside the five-second cooldown', async () => {
    await env.clearFirestore();
    await assertSucceeds(commitAccountAndQuota(alice));
    const db = alice.firestore();
    const batch = writeBatch(db);
    batch.update(doc(db, ...path()), { json: validJson + ' ' });
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [accountHash], lastAccountHash: accountHash,
      dailyWrites: 2, windowStart: (await getDoc(doc(db, ...quotaPath()))).data().windowStart,
      lastWriteAt: serverTimestamp(),
    });
    await assertFails(batch.commit());
  });

  await test('the hundredth write in a 24-hour quota window is accepted', async () => {
    await env.clearFirestore();
    await seed('firebase-alice', accountHash, { dailyWrites: 99 });
    const db = alice.firestore();
    const current = await getDoc(doc(db, ...quotaPath()));
    const batch = writeBatch(db);
    batch.update(doc(db, ...path()), { json: validJson + ' ' });
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [accountHash], lastAccountHash: accountHash,
      dailyWrites: 100, windowStart: current.data().windowStart,
      lastWriteAt: serverTimestamp(),
    });
    await assertSucceeds(batch.commit());
  });

  await test('the server rejects writes beyond the 24-hour daily quota window', async () => {
    await env.clearFirestore();
    await seed('firebase-alice', accountHash, { dailyWrites: 100 });
    const db = alice.firestore();
    const batch = writeBatch(db);
    const current = await getDoc(doc(db, ...quotaPath()));
    batch.update(doc(db, ...path()), { json: validJson + ' ' });
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [accountHash], lastAccountHash: accountHash,
      dailyWrites: 101, windowStart: current.data().windowStart,
      lastWriteAt: serverTimestamp(),
    });
    await assertFails(batch.commit());
  });

  await test('the fixed daily quota window resets only after 24 hours on server time', async () => {
    await env.clearFirestore();
    const old = Timestamp.fromMillis(Date.now() - 25 * 60 * 60 * 1000);
    await seed('firebase-alice', accountHash, {
      dailyWrites: 100, windowStart: old, lastWriteAt: old,
    });
    const db = alice.firestore();
    const batch = writeBatch(db);
    batch.update(doc(db, ...path()), { json: validJson + ' ' });
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [accountHash], lastAccountHash: accountHash,
      dailyWrites: 1, windowStart: serverTimestamp(), lastWriteAt: serverTimestamp(),
    });
    await assertSucceeds(batch.commit());
  });

  await test('the twentieth registered account snapshot is accepted', async () => {
    await env.clearFirestore();
    const hashes = Array.from({ length: 19 }, (_, index) =>
      'acct_' + index.toString(16).padStart(64, '0'));
    await seed('firebase-alice', hashes[0], { accountHashes: hashes });
    const db = alice.firestore();
    const newHash = 'acct_' + 'f'.repeat(64);
    const current = await getDoc(doc(db, ...quotaPath()));
    const batch = writeBatch(db);
    batch.set(doc(db, ...path('firebase-alice', newHash)), { json: validJson });
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [...hashes, newHash], lastAccountHash: newHash,
      dailyWrites: 2, windowStart: current.data().windowStart,
      lastWriteAt: serverTimestamp(),
    });
    await assertSucceeds(batch.commit());
  });

  await test('the per-UID cloud account registry cannot exceed twenty account snapshots', async () => {
    await env.clearFirestore();
    const hashes = Array.from({ length: 20 }, (_, index) =>
      'acct_' + index.toString(16).padStart(64, '0'));
    await seed('firebase-alice', hashes[0], { accountHashes: hashes });
    const db = alice.firestore();
    const newHash = 'acct_' + 'f'.repeat(64);
    const batch = writeBatch(db);
    batch.set(doc(db, ...path('firebase-alice', newHash)), { json: validJson });
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [...hashes, newHash], lastAccountHash: newHash,
      dailyWrites: 2, windowStart: (await getDoc(doc(db, ...quotaPath()))).data().windowStart,
      lastWriteAt: serverTimestamp(),
    });
    await assertFails(batch.commit());
  });

  await test('a quota-only write is rejected because no account snapshot changed with it', async () => {
    await env.clearFirestore();
    await seed('firebase-alice', accountHash);
    const db = alice.firestore();
    const current = await getDoc(doc(db, ...quotaPath()));
    const batch = writeBatch(db);
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [accountHash], lastAccountHash: accountHash,
      dailyWrites: 2, windowStart: current.data().windowStart,
      lastWriteAt: serverTimestamp(),
    });
    await assertFails(batch.commit());
  });

  await test('a quota increment is rejected when the paired snapshot does not actually change', async () => {
    await env.clearFirestore();
    await seed('firebase-alice', accountHash);
    const db = alice.firestore();
    const current = await getDoc(doc(db, ...quotaPath()));
    const batch = writeBatch(db);
    // Rewriting the identical JSON is not a billable snapshot change and
    // must not be usable to consume or manipulate the UID quota.
    batch.update(doc(db, ...path()), { json: validJson });
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [accountHash], lastAccountHash: accountHash,
      dailyWrites: 2, windowStart: current.data().windowStart,
      lastWriteAt: serverTimestamp(),
    });
    await assertFails(batch.commit());
  });

  await test('the per-UID account registry cannot remove previously registered hashes', async () => {
    await env.clearFirestore();
    const secondHash = 'acct_' + 'b'.repeat(64);
    await seed('firebase-alice', accountHash, {
      accountHashes: [accountHash, secondHash],
    });
    const db = alice.firestore();
    const current = await getDoc(doc(db, ...quotaPath()));
    const batch = writeBatch(db);
    batch.update(doc(db, ...path()), { json: validJson + ' ' });
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [accountHash], lastAccountHash: accountHash,
      dailyWrites: 2, windowStart: current.data().windowStart,
      lastWriteAt: serverTimestamp(),
    });
    await assertFails(batch.commit());
  });

  await test('a client-supplied timestamp cannot authorize a quota write', async () => {
    await env.clearFirestore();
    await seed('firebase-alice', accountHash);
    const db = alice.firestore();
    const current = await getDoc(doc(db, ...quotaPath()));
    const batch = writeBatch(db);
    batch.update(doc(db, ...path()), { json: validJson + ' ' });
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [accountHash], lastAccountHash: accountHash,
      dailyWrites: 2, windowStart: current.data().windowStart,
      // A timestamp supplied by the client must not satisfy request.time.
      lastWriteAt: Timestamp.fromMillis(1),
    });
    await assertFails(batch.commit());
  });

  await test('another Firebase UID cannot read or write the owner account or quota', async () => {
    await env.clearFirestore();
    const accountRef = doc(bob.firestore(), ...path());
    const quotaRef = doc(bob.firestore(), ...quotaPath());
    await assertFails(getDoc(accountRef));
    await assertFails(getDoc(quotaRef));
    await assertFails(commitAccountAndQuota(bob));
  });

  await test('an unverified email cannot access account or quota documents', async () => {
    await env.clearFirestore();
    const accountRef = doc(notVerified.firestore(), ...path());
    const quotaRef = doc(notVerified.firestore(), ...quotaPath());
    await assertFails(getDoc(accountRef));
    await assertFails(getDoc(quotaRef));
    await assertFails(commitAccountAndQuota(notVerified));
  });

  await test('unauthenticated requests cannot access account or quota documents', async () => {
    await env.clearFirestore();
    const accountRef = doc(visitor.firestore(), ...path());
    const quotaRef = doc(visitor.firestore(), ...quotaPath());
    await assertFails(getDoc(accountRef));
    await assertFails(getDoc(quotaRef));
    await assertFails(commitAccountAndQuota(visitor));
  });

  await test('collection listing and document deletion remain forbidden', async () => {
    await env.clearFirestore();
    await seed('firebase-alice', accountHash);
    const db = alice.firestore();
    await assertFails(getDocs(collection(db, 'users', 'firebase-alice', 'accounts')));
    await assertFails(deleteDoc(doc(db, ...path())));
    await assertFails(deleteDoc(doc(db, ...quotaPath())));
  });

  await test('writing another Firebase UID partition fails', async () => {
    await env.clearFirestore();
    await assertFails(commitAccountAndQuota(alice, { uid: 'firebase-bob' }));
  });

  await test('only the exact account hash pattern is accepted', async () => {
    await env.clearFirestore();
    const db = alice.firestore();
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', 'firebase-alice', 'accounts', 'acct-invalid'), { json: validJson });
    batch.set(doc(db, ...quotaPath()), quotaData({
      accountHashes: ['acct-invalid'], lastAccountHash: 'acct-invalid',
    }));
    await assertFails(batch.commit());
  });

  await test('unexpected document fields or incorrect json type are rejected', async () => {
    await env.clearFirestore();
    await seed('firebase-alice', accountHash);
    const db = alice.firestore();
    const current = await getDoc(doc(db, ...quotaPath()));
    const batch = writeBatch(db);
    batch.set(doc(db, ...path()), { json: validJson, other: 'secret' });
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [accountHash], lastAccountHash: accountHash,
      dailyWrites: 2, windowStart: current.data().windowStart, lastWriteAt: serverTimestamp(),
    });
    await assertFails(batch.commit());
    const badType = writeBatch(db);
    badType.set(doc(db, ...path()), { json: { nested: 'not-string' } });
    badType.update(doc(db, ...quotaPath()), {
      accountHashes: [accountHash], lastAccountHash: accountHash,
      dailyWrites: 2, windowStart: current.data().windowStart, lastWriteAt: serverTimestamp(),
    });
    await assertFails(badType.commit());
  });

  await test('oversize snapshot string is rejected by security rules', async () => {
    await env.clearFirestore();
    await seed('firebase-alice', accountHash);
    const db = alice.firestore();
    const current = await getDoc(doc(db, ...quotaPath()));
    const batch = writeBatch(db);
    batch.update(doc(db, ...path()), { json: 'x'.repeat(240_001) });
    batch.update(doc(db, ...quotaPath()), {
      accountHashes: [accountHash], lastAccountHash: accountHash,
      dailyWrites: 2, windowStart: current.data().windowStart, lastWriteAt: serverTimestamp(),
    });
    await assertFails(batch.commit());
  });

  await test('default deny protects every other collection path', async () => {
    await env.clearFirestore();
    await assertFails(setDoc(doc(alice.firestore(), 'admin', 'private'), { json: validJson }));
    await assertFails(getDoc(doc(alice.firestore(), 'admin', 'private')));
  });
} finally {
  await env.cleanup();
}
