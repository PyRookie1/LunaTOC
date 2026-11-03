import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BatchDeleteError,
  deleteInBatches,
  isAccountSnapshotDocument,
  isWriteQuotaDocument,
  listCollectionGroup,
  parseArguments,
  runFirestoreReset,
  selectApplicationDocuments,
} from '../../scripts/firebase-firestore-reset.mjs';

const project = 'lunatoc-prod';
const uid = 'firebase-alice';
const accountHash = 'acct_' + 'a'.repeat(64);
const secondHash = 'acct_' + 'b'.repeat(64);
const root = 'projects/' + project + '/databases/(default)/documents';
const account = root + '/users/' + uid + '/accounts/' + accountHash;
const secondAccount = root + '/users/' + uid + '/accounts/' + secondHash;
const quota = root + '/users/' + uid + '/usage/cloudWrites';
const otherUsage = root + '/users/' + uid + '/usage/other';
const unrelated = root + '/admin/private';

function document(name, updateTime = '2026-11-01T00:00:00.000Z') {
  return { name, updateTime, fields: { json: { stringValue: '{}' } } };
}

function createFirestoreHarness(initialDocuments, options = {}) {
  const documents = new Map(initialDocuments.map((item) => [item.name, structuredClone(item)]));
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (String(url).endsWith('/documents:runQuery')) {
      const collectionId = body.structuredQuery?.from?.[0]?.collectionId;
      const candidates = [...documents.values()]
        .filter((item) => item.name.split('/').at(-2) === collectionId)
        .sort((left, right) => left.name.localeCompare(right.name));
      const cursor = body.structuredQuery?.startAt?.values?.[0]?.referenceValue;
      const afterCursor = cursor
        ? candidates.filter((item) => item.name.localeCompare(cursor) > 0)
        : candidates;
      return Response.json(afterCursor.slice(0, body.structuredQuery.limit).map((item) => ({
        document: structuredClone(item),
      })));
    }
    if (String(url).endsWith('/documents:batchWrite')) {
      if (options.beforeBatch) await options.beforeBatch(body, documents);
      const status = [];
      for (const write of body.writes ?? []) {
        const current = documents.get(write.delete);
        if (!current) {
          status.push({ code: 5, message: 'NOT_FOUND' });
        } else if (current.updateTime !== write.currentDocument?.updateTime) {
          status.push({ code: 9, message: 'FAILED_PRECONDITION' });
        } else {
          documents.delete(write.delete);
          status.push({ code: 0 });
        }
      }
      if (options.afterBatch) await options.afterBatch(body, documents);
      return Response.json({ writeResults: (body.writes ?? []).map(() => ({})), status });
    }
    return Response.json({ error: { message: 'Unexpected endpoint' } }, { status: 404 });
  };
  return { documents, calls, fetcher };
}

test('matches only canonical account snapshots and UID quota documents', () => {
  assert.equal(isAccountSnapshotDocument(account, project), true);
  assert.equal(isWriteQuotaDocument(quota, project), true);
  assert.equal(isAccountSnapshotDocument(account.replace('/accounts/', '/accountsArchive/'), project), false);
  assert.equal(isWriteQuotaDocument(quota.replace('/cloudWrites', '/otherQuota'), project), false);
  assert.equal(isAccountSnapshotDocument(account, 'another-project'), false);
  assert.equal(isAccountSnapshotDocument(account.replace('/' + accountHash, '/acct-invalid'), project), false);
  assert.equal(isAccountSnapshotDocument(account.replace('/' + uid + '/', '/uid.with.dot/'), project), false);
  assert.equal(isAccountSnapshotDocument(account.replace('/(default)/', '/named-db/'), project), false);
});

test('reset scope excludes Authentication, unrelated collections and malformed paths', () => {
  const docs = [
    document(account),
    document(quota),
    document(root + '/users/firebase-alice/authentication/account'),
    document(otherUsage),
    document(account.replace('/accounts/', '/accountsArchive/')),
    document(account.replace('/' + accountHash, '/acct-invalid')),
  ];
  const selected = selectApplicationDocuments(docs, project);
  assert.equal(selected.accountDocuments.length, 1);
  assert.equal(selected.quotaDocuments.length, 1);
  assert.equal(selected.ignoredDocuments.length, 4);
  assert.deepEqual(selected.documents.map((entry) => entry.name), [account, quota]);
});

test('an empty Firestore business inventory is a no-op', () => {
  const selected = selectApplicationDocuments([], project);
  assert.deepEqual(selected.accountDocuments, []);
  assert.deepEqual(selected.quotaDocuments, []);
  assert.deepEqual(selected.ignoredDocuments, []);
  assert.deepEqual(selected.documents, []);
});

test('CLI arguments reject missing values, duplicates and unknown flags', () => {
  assert.deepEqual(parseArguments(['--project-id', project]), {
    execute: false, projectId: project, confirmProjectId: '', reportFile: '',
  });
  assert.throws(() => parseArguments(['--project-id']), /缺少参数/);
  assert.throws(() => parseArguments(['--project-id', project, '--project-id', project]), /参数重复/);
  assert.throws(() => parseArguments(['--report-file', '--execute']), /缺少参数/);
  assert.throws(() => parseArguments(['--unsafe']), /未知参数/);
});

test('collection-group inventory paginates after the last document without duplicates', async () => {
  const names = Array.from({ length: 251 }, (_, index) =>
    root + '/users/' + uid + '/accounts/acct_' + String(index).padStart(64, '0'));
  const calls = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push(body.structuredQuery);
    const cursor = body.structuredQuery.startAt?.values?.[0]?.referenceValue;
    const start = cursor ? names.findIndex((name) => name === cursor) + 1 : 0;
    return Response.json(names.slice(start, start + 250).map((name, index) => ({
      document: document(name, '2026-11-01T00:00:' + String((start + index) % 60).padStart(2, '0') + '.000Z'),
    })));
  };
  const found = await listCollectionGroup(project, 'accounts', 'test-token', {
    apiRoot: 'https://firestore.test/v1', fetcher,
  });
  assert.equal(found.length, 251);
  assert.equal(new Set(found.map((item) => item.name)).size, 251);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].startAt, undefined);
  assert.equal(calls[1].startAt.values[0].referenceValue, names[249]);
  assert.equal(calls[1].startAt.before, false);
});

test('collection-group query errors stop inventory before any deletion', async () => {
  const fetcher = async () => Response.json([{ error: { code: 7, message: 'PERMISSION_DENIED' } }]);
  await assert.rejects(
    listCollectionGroup(project, 'accounts', 'test-token', {
      apiRoot: 'https://firestore.test/v1', fetcher,
    }),
    /collection-group 查询失败/,
  );
});

test('read-only mode inventories exact business documents and never calls batchWrite', async () => {
  const harness = createFirestoreHarness([
    document(account), document(quota), document(otherUsage), document(unrelated),
  ]);
  let tokenCalls = 0;
  let confirmCalls = 0;
  const result = await runFirestoreReset({ projectId: project, execute: false }, {
    apiRoot: 'https://firestore.test/v1',
    fetcher: harness.fetcher,
    tokenProvider: async () => { tokenCalls += 1; return 'test-token'; },
    confirm: async () => { confirmCalls += 1; return ''; },
  });
  assert.equal(tokenCalls, 1);
  assert.equal(confirmCalls, 0);
  assert.deepEqual(result.summary, {
    projectId: project,
    mode: 'inventory',
    accountSnapshots: 1,
    writeQuotaDocuments: 1,
    totalBusinessDocuments: 2,
    affectedFirebaseUids: 1,
    ignoredCollectionGroupDocuments: 1,
    status: 'inventory',
  });
  assert.equal(harness.documents.size, 4);
  assert.equal(harness.calls.some((call) => call.url.endsWith('/documents:batchWrite')), false);
  assert.equal(harness.calls.every((call) => call.url.includes('firestore.test')), true);
});

test('project confirmation is validated before credentials or network access', async () => {
  let tokenCalls = 0;
  await assert.rejects(runFirestoreReset({
    projectId: project, execute: true, confirmProjectId: 'different-project',
  }, {
    tokenProvider: async () => { tokenCalls += 1; return 'test-token'; },
    fetcher: async () => { throw new Error('must not fetch'); },
  }), /confirm-project-id/);
  assert.equal(tokenCalls, 0);
  await assert.rejects(runFirestoreReset({
    projectId: 'demo-lunatoc-ci', execute: false,
  }, {
    tokenProvider: async () => { tokenCalls += 1; return 'test-token'; },
  }), /有效的 Firebase/);
  assert.equal(tokenCalls, 0);
});

test('execute mode deletes only canonical documents after the exact manual phrase', async () => {
  const harness = createFirestoreHarness([
    document(account), document(quota), document(otherUsage), document(unrelated),
  ]);
  let receivedPhrase = '';
  const result = await runFirestoreReset({
    projectId: project, execute: true, confirmProjectId: project,
  }, {
    apiRoot: 'https://firestore.test/v1',
    fetcher: harness.fetcher,
    tokenProvider: async () => 'test-token',
    confirm: async (phrase, count) => {
      receivedPhrase = phrase;
      assert.equal(count, 2);
      return phrase;
    },
  });
  assert.equal(receivedPhrase, 'CLEAR LUNATOC FIRESTORE BUSINESS DATA ' + project);
  assert.equal(result.summary.status, 'complete');
  assert.equal(result.summary.deletedDocuments, 2);
  assert.equal(result.summary.remainingBusinessDocuments, 0);
  assert.equal(result.summary.remainingIgnoredCollectionGroupDocuments, 1);
  assert.equal(harness.documents.has(account), false);
  assert.equal(harness.documents.has(quota), false);
  assert.equal(harness.documents.has(otherUsage), true);
  assert.equal(harness.documents.has(unrelated), true);
  const writes = harness.calls.filter((call) => call.url.endsWith('/documents:batchWrite'));
  assert.equal(writes.length, 1);
  const request = JSON.parse(String(writes[0].init.body));
  assert.deepEqual(request.writes.map((write) => write.currentDocument), [
    { updateTime: '2026-11-01T00:00:00.000Z' },
    { updateTime: '2026-11-01T00:00:00.000Z' },
  ]);
});

test('a wrong manual phrase aborts before any Firestore write', async () => {
  const harness = createFirestoreHarness([document(account), document(quota)]);
  await assert.rejects(runFirestoreReset({
    projectId: project, execute: true, confirmProjectId: project,
  }, {
    apiRoot: 'https://firestore.test/v1',
    fetcher: harness.fetcher,
    tokenProvider: async () => 'test-token',
    confirm: async () => 'CLEAR SOMETHING ELSE',
  }), /确认短语不匹配/);
  assert.equal(harness.documents.size, 2);
  assert.equal(harness.calls.some((call) => call.url.endsWith('/documents:batchWrite')), false);
});

test('stale updateTime causes a partial failure and a fresh residual inventory', async () => {
  const harness = createFirestoreHarness([document(account), document(quota)], {
    beforeBatch: async (_body, documents) => {
      documents.set(account, document(account, '2026-11-02T00:00:00.000Z'));
    },
  });
  await assert.rejects(runFirestoreReset({
    projectId: project, execute: true, confirmProjectId: project,
  }, {
    apiRoot: 'https://firestore.test/v1',
    fetcher: harness.fetcher,
    tokenProvider: async () => 'test-token',
    confirm: async (phrase) => phrase,
  }), /已确认成功删除 1 份；重新盘点仍有 1 份/);
  assert.equal(harness.documents.has(account), true);
  assert.equal(harness.documents.has(quota), false);
  assert.equal(harness.calls.filter((call) => call.url.endsWith('/documents:runQuery')).length, 4);
});

test('a document created during deletion is detected by the postflight inventory', async () => {
  const harness = createFirestoreHarness([document(account)], {
    afterBatch: async (_body, documents) => {
      documents.set(secondAccount, document(secondAccount, '2026-11-02T00:00:00.000Z'));
    },
  });
  await assert.rejects(runFirestoreReset({
    projectId: project, execute: true, confirmProjectId: project,
  }, {
    apiRoot: 'https://firestore.test/v1',
    fetcher: harness.fetcher,
    tokenProvider: async () => 'test-token',
    confirm: async (phrase) => phrase,
  }), /清理后仍有 1 份规范业务文档/);
  assert.equal(harness.documents.has(account), false);
  assert.equal(harness.documents.has(secondAccount), true);
});

test('malformed batch responses are treated as unknown and re-inventoried', async () => {
  const harness = createFirestoreHarness([document(account)], {
    afterBatch: async (_body, documents) => { documents.delete(account); },
  });
  const originalFetcher = harness.fetcher;
  const fetcher = async (url, init) => {
    if (String(url).endsWith('/documents:batchWrite')) {
      await originalFetcher(url, init);
      return Response.json({ writeResults: [] });
    }
    return originalFetcher(url, init);
  };
  await assert.rejects(runFirestoreReset({
    projectId: project, execute: true, confirmProjectId: project,
  }, {
    apiRoot: 'https://firestore.test/v1',
    fetcher,
    tokenProvider: async () => 'test-token',
    confirm: async (phrase) => phrase,
  }), /本批结果需要重新盘点/);
  assert.equal(harness.documents.has(account), false);
});

test('report destination is reserved before credentials or destructive requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lunatoc-reset-'));
  const existing = join(directory, 'report.json');
  await writeFile(existing, 'keep-me', 'utf8');
  let tokenCalls = 0;
  try {
    await assert.rejects(runFirestoreReset({
      projectId: project, execute: true, confirmProjectId: project, reportFile: existing,
    }, {
      tokenProvider: async () => { tokenCalls += 1; return 'test-token'; },
      fetcher: async () => { throw new Error('must not fetch'); },
      confirm: async (phrase) => phrase,
    }), /EEXIST/);
    assert.equal(tokenCalls, 0);
    assert.equal(await readFile(existing, 'utf8'), 'keep-me');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('report file is written with a restrictive mode and records the verified result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lunatoc-reset-'));
  const report = join(directory, 'report.json');
  const harness = createFirestoreHarness([document(account), document(quota)]);
  try {
    const result = await runFirestoreReset({
      projectId: project, execute: true, confirmProjectId: project, reportFile: report,
    }, {
      apiRoot: 'https://firestore.test/v1',
      fetcher: harness.fetcher,
      tokenProvider: async () => 'test-token',
      confirm: async (phrase) => phrase,
    });
    const saved = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(saved.status, 'complete');
    assert.equal(saved.remainingBusinessDocuments, 0);
    assert.equal(saved.deletedDocuments, 2);
    assert.equal(result.summary.status, 'complete');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('delete helper independently enforces the exact canonical path allowlist', async () => {
  let calls = 0;
  await assert.rejects(deleteInBatches(project, 'test-token', [{
    name: unrelated, updateTime: '2026-11-01T00:00:00.000Z',
  }], {
    apiRoot: 'https://firestore.test/v1',
    fetcher: async () => { calls += 1; return Response.json({}); },
  }), (error) => error instanceof BatchDeleteError && /不在 LunaTOC 清理白名单/.test(error.message));
  assert.equal(calls, 0);
});

test('delete helper requires updateTime and stops after a failed batch', async () => {
  let calls = 0;
  await assert.rejects(deleteInBatches(project, 'test-token', [{
    name: account,
  }], {
    apiRoot: 'https://firestore.test/v1',
    fetcher: async () => { calls += 1; return Response.json({}); },
  }), (error) => error instanceof BatchDeleteError && /updateTime/.test(error.message));
  assert.equal(calls, 0);
});
