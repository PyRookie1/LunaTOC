import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { runFirestoreReset } from '../../scripts/firebase-firestore-reset.mjs';

const projectId = 'demo-lunatoc-ci';
const accountHash = 'acct_' + 'c'.repeat(64);
const uid = 'phase4-reset-user';
const accountPath = ['users', uid, 'accounts', accountHash];
const quotaPath = ['users', uid, 'usage', 'cloudWrites'];
const unrelatedUsagePath = ['users', uid, 'usage', 'keepThis'];
const unrelatedPath = ['admin', 'preserveThis'];
const env = await initializeTestEnvironment({
  projectId,
  firestore: {
    rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
    host: '127.0.0.1',
    port: 8080,
  },
});

try {
  await test('the reset CLI inventories and deletes only canonical business documents in Firestore Emulator', async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await Promise.all([
        setDoc(doc(db, ...accountPath), {
          json: JSON.stringify({
            prompts: [], aliases: {}, settings: null,
            deletedRoutes: [], deletedAliases: [], deletedPrompts: [],
          }),
        }),
        setDoc(doc(db, ...quotaPath), {
          accountHashes: [accountHash], lastAccountHash: accountHash,
          dailyWrites: 1, windowStart: new Date(), lastWriteAt: new Date(),
        }),
        setDoc(doc(db, ...unrelatedUsagePath), { keep: true }),
        setDoc(doc(db, ...unrelatedPath), { keep: true }),
      ]);
    });

    const dependencies = {
      apiRoot: 'http://127.0.0.1:8080/v1',
      allowDemoProject: true,
      tokenProvider: async () => 'owner',
      confirm: async (phrase) => phrase,
    };
    const inventory = await runFirestoreReset({ projectId, execute: false }, dependencies);
    assert.equal(inventory.summary.accountSnapshots, 1);
    assert.equal(inventory.summary.writeQuotaDocuments, 1);
    assert.equal(inventory.summary.totalBusinessDocuments, 2);
    assert.equal(inventory.summary.ignoredCollectionGroupDocuments, 1);

    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      assert.equal((await getDoc(doc(db, ...accountPath))).exists(), true);
      assert.equal((await getDoc(doc(db, ...quotaPath))).exists(), true);
    });

    const reset = await runFirestoreReset({
      projectId, execute: true, confirmProjectId: projectId,
    }, dependencies);
    assert.equal(reset.summary.status, 'complete');
    assert.equal(reset.summary.deletedDocuments, 2);
    assert.equal(reset.summary.remainingBusinessDocuments, 0);

    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      assert.equal((await getDoc(doc(db, ...accountPath))).exists(), false);
      assert.equal((await getDoc(doc(db, ...quotaPath))).exists(), false);
      assert.equal((await getDoc(doc(db, ...unrelatedUsagePath))).exists(), true);
      assert.equal((await getDoc(doc(db, ...unrelatedPath))).exists(), true);
    });
  });
} finally {
  await env.cleanup();
}
