#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

const PAGE_SIZE = 250;
const WRITE_BATCH_SIZE = 200;
const API_ROOT = 'https://firestore.googleapis.com/v1';
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,62}$/;
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isAccountSnapshotDocument(name, projectId) {
  const prefix = 'projects/' + projectId + '/databases/(default)/documents/users/';
  if (typeof name !== 'string' || !name.startsWith(prefix)) return false;
  const parts = name.slice(prefix.length).split('/');
  return parts.length === 3 &&
    UID_PATTERN.test(parts[0]) &&
    parts[1] === 'accounts' &&
    /^acct_[a-f0-9]{64}$/.test(parts[2]);
}

export function isWriteQuotaDocument(name, projectId) {
  const prefix = 'projects/' + projectId + '/databases/(default)/documents/users/';
  if (typeof name !== 'string' || !name.startsWith(prefix)) return false;
  const parts = name.slice(prefix.length).split('/');
  return parts.length === 3 &&
    UID_PATTERN.test(parts[0]) &&
    parts[1] === 'usage' &&
    parts[2] === 'cloudWrites';
}

export function selectApplicationDocuments(documents, projectId) {
  const accountDocuments = [];
  const quotaDocuments = [];
  const ignoredDocuments = [];
  for (const document of documents) {
    if (!document || typeof document.name !== 'string') continue;
    if (isAccountSnapshotDocument(document.name, projectId)) accountDocuments.push(document);
    else if (isWriteQuotaDocument(document.name, projectId)) quotaDocuments.push(document);
    else ignoredDocuments.push(document);
  }
  return {
    accountDocuments,
    quotaDocuments,
    ignoredDocuments,
    documents: [...accountDocuments, ...quotaDocuments],
  };
}

export function parseArguments(argv) {
  const result = { execute: false, projectId: '', confirmProjectId: '', reportFile: '' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') {
      if (seen.has(argument)) throw new Error('参数重复：' + argument);
      seen.add(argument);
      result.execute = true;
    } else if (argument === '--project-id' || argument === '--confirm-project-id' ||
               argument === '--report-file') {
      if (seen.has(argument)) throw new Error('参数重复：' + argument);
      seen.add(argument);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(argument + ' 缺少参数');
      index += 1;
      if (argument === '--project-id') result.projectId = value;
      else if (argument === '--confirm-project-id') result.confirmProjectId = value;
      else result.reportFile = value;
    } else if (argument === '--help' || argument === '-h') {
      result.help = true;
    } else {
      throw new Error('未知参数：' + argument);
    }
  }
  return result;
}

function usage() {
  return 'LunaTOC Firestore business-data reset (read-only by default)\n\n' +
    'Inventory:\n  node scripts/firebase-firestore-reset.mjs --project-id <project>\n\n' +
    'Clear LunaTOC business documents after reviewing the inventory:\n' +
    '  node scripts/firebase-firestore-reset.mjs --project-id <project> --execute --confirm-project-id <project>\n\n' +
    'Optional report (the destination must not already exist):\n' +
    '  --report-file <new-file.json>\n\n' +
    'Only users/{uid}/accounts/{accountHash} and users/{uid}/usage/cloudWrites are deleted.\n' +
    'Firebase Authentication accounts and local browser data are never modified.\n';
}

function accessToken() {
  try {
    return execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error('无法取得 Google Application Default Credentials；先运行 gcloud auth application-default login');
  }
}

async function requestJson(url, token, body, fetcher) {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error('Firestore 管理请求失败（HTTP ' + response.status + '）：' + text.slice(0, 400));
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Firestore 管理接口返回了无效 JSON');
  }
}

export async function listCollectionGroup(projectId, collectionId, token, options = {}) {
  const apiRoot = options.apiRoot ?? API_ROOT;
  const fetcher = options.fetcher ?? fetch;
  const endpoint = apiRoot + '/projects/' + encodeURIComponent(projectId) +
    '/databases/(default)/documents:runQuery';
  const documents = [];
  let cursor;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId, allDescendants: true }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: PAGE_SIZE,
      ...(cursor ? { startAt: { values: [{ referenceValue: cursor }], before: false } } : {}),
    };
    const page = await requestJson(endpoint, token, { structuredQuery }, fetcher);
    if (!Array.isArray(page) || page.some((entry) => entry && entry.error)) {
      throw new Error('Firestore collection-group 查询失败；停止清理');
    }
    const current = page.map((entry) => entry && entry.document).filter(Boolean);
    documents.push(...current);
    if (current.length < PAGE_SIZE) break;
    const next = current[current.length - 1]?.name;
    if (!next || next === cursor) throw new Error('Firestore 分页游标没有前进；停止清理');
    cursor = next;
  }
  return documents;
}

export class BatchDeleteError extends Error {
  constructor(message, deletedDocuments, options = {}) {
    super(message);
    this.name = 'BatchDeleteError';
    this.deletedDocuments = deletedDocuments;
    this.failureCount = options.failureCount ?? 0;
    this.outcomeUnknown = options.outcomeUnknown === true;
  }
}

export async function deleteInBatches(projectId, token, documents, options = {}) {
  const apiRoot = options.apiRoot ?? API_ROOT;
  const fetcher = options.fetcher ?? fetch;
  const endpoint = apiRoot + '/projects/' + encodeURIComponent(projectId) +
    '/databases/(default)/documents:batchWrite';
  let deleted = 0;
  for (let offset = 0; offset < documents.length; offset += WRITE_BATCH_SIZE) {
    const batch = documents.slice(offset, offset + WRITE_BATCH_SIZE);
    if (batch.some((document) => typeof document?.name !== 'string' ||
        (!isAccountSnapshotDocument(document.name, projectId) &&
          !isWriteQuotaDocument(document.name, projectId)))) {
      throw new BatchDeleteError('待删除文档路径不在 LunaTOC 清理白名单内；停止清理',
        deleted, { outcomeUnknown: false });
    }
    if (batch.some((document) => typeof document?.updateTime !== 'string' || !document.updateTime)) {
      throw new BatchDeleteError('待删除文档缺少有效 updateTime；停止清理以避免误删',
        deleted, { outcomeUnknown: false });
    }
    let result;
    try {
      result = await requestJson(endpoint, token, {
        writes: batch.map((document) => ({
          delete: document.name,
          currentDocument: { updateTime: document.updateTime },
        })),
      }, fetcher);
    } catch (error) {
      throw new BatchDeleteError(
        'Firestore batchWrite 请求失败：' + (error instanceof Error ? error.message : String(error)),
        deleted, { outcomeUnknown: true });
    }
    if (!Array.isArray(result.writeResults) || result.writeResults.length !== batch.length ||
        !Array.isArray(result.status) || result.status.length !== batch.length ||
        result.status.some((status) => !status || typeof status !== 'object' ||
          (status.code !== undefined && !Number.isInteger(Number(status.code))))) {
      throw new BatchDeleteError('Firestore batchWrite 返回数量或状态不匹配；本批结果需要重新盘点',
        deleted, { outcomeUnknown: true });
    }
    const failures = result.status.filter((status) => Number(status.code ?? 0) !== 0);
    deleted += batch.length - failures.length;
    if (failures.length) {
      throw new BatchDeleteError(
        'Firestore batchWrite 有 ' + failures.length + ' 项失败；停止后续批次',
        deleted, { failureCount: failures.length, outcomeUnknown: false });
    }
  }
  return deleted;
}

export async function inventory(projectId, token, options = {}) {
  const [accountCandidates, usageCandidates] = await Promise.all([
    listCollectionGroup(projectId, 'accounts', token, options),
    listCollectionGroup(projectId, 'usage', token, options),
  ]);
  return selectApplicationDocuments([...accountCandidates, ...usageCandidates], projectId);
}

async function createReportWriter(filePath) {
  if (!filePath) return null;
  // Reserve the destination before any destructive request. An existing report
  // must never make a completed Firestore deletion look like an execution failure.
  const handle = await open(resolve(filePath), 'wx', 0o600);
  return {
    async write(summary) {
      const data = Buffer.from(JSON.stringify(summary, null, 2) + '\n', 'utf8');
      await handle.truncate(0);
      let offset = 0;
      while (offset < data.length) {
        const result = await handle.write(data, offset, data.length - offset, offset);
        if (!result.bytesWritten) throw new Error('清库报告写入失败');
        offset += result.bytesWritten;
      }
      await handle.truncate(data.length);
      await handle.sync();
    },
    close: () => handle.close(),
  };
}

async function confirmInTerminal(phrase, documentCount) {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question(
      '即将删除 ' + documentCount +
      ' 份 LunaTOC Firestore 业务文档；Authentication 用户和本地浏览器数据不会删除。\n' +
      '输入以下完整短语确认：\n' + phrase + '\n> ',
    );
  } finally {
    prompt.close();
  }
}

function validateProjectId(projectId, allowDemoProject) {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId) ||
      (!allowDemoProject && projectId.startsWith('demo-'))) {
    throw new Error('必须提供有效的 Firebase --project-id');
  }
}

function summaryFor(projectId, mode, selected) {
  const uids = new Set(selected.documents.map((document) => {
    const marker = '/documents/users/';
    return document.name.slice(document.name.indexOf(marker) + marker.length).split('/')[0];
  }));
  return {
    projectId,
    mode,
    accountSnapshots: selected.accountDocuments.length,
    writeQuotaDocuments: selected.quotaDocuments.length,
    totalBusinessDocuments: selected.documents.length,
    affectedFirebaseUids: uids.size,
    ignoredCollectionGroupDocuments: selected.ignoredDocuments.length,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function runFirestoreReset(args, dependencies = {}) {
  const projectId = args?.projectId ?? '';
  const execute = args?.execute === true;
  const confirmProjectId = args?.confirmProjectId ?? '';
  const allowDemoProject = dependencies.allowDemoProject === true;
  const apiRoot = dependencies.apiRoot ?? API_ROOT;
  const fetcher = dependencies.fetcher ?? fetch;
  const tokenProvider = dependencies.tokenProvider ?? accessToken;
  const confirm = dependencies.confirm ?? confirmInTerminal;
  validateProjectId(projectId, allowDemoProject);
  if (execute && confirmProjectId !== projectId) {
    throw new Error('--confirm-project-id 必须与目标项目 ID 完全一致');
  }

  const reportWriter = await createReportWriter(args.reportFile ?? '');
  let summary;
  try {
    const token = await tokenProvider();
    const selected = await inventory(projectId, token, { apiRoot, fetcher });
    summary = summaryFor(projectId, execute ? 'execute' : 'inventory', selected);

    if (!execute) {
      summary.status = 'inventory';
      await reportWriter?.write(summary);
      const message = summary.totalBusinessDocuments === 0
        ? '业务文档数量为零；无需删除。'
        : '只读盘点完成；没有删除任何文档。';
      return { summary, message };
    }
    if (selected.documents.length === 0) {
      summary.status = 'no-op';
      summary.deletedDocuments = 0;
      summary.remainingBusinessDocuments = 0;
      await reportWriter?.write(summary);
      return { summary, message: '规范业务文档数量为零；无需删除。' };
    }

    summary.status = 'awaiting-confirmation';
    await reportWriter?.write(summary);
    const phrase = 'CLEAR LUNATOC FIRESTORE BUSINESS DATA ' + projectId;
    const answer = await confirm(phrase, selected.documents.length);
    if (typeof answer !== 'string' || answer.trim() !== phrase) {
      throw new Error('确认短语不匹配；没有删除任何文档');
    }

    let deletedDocuments = 0;
    let deleteError;
    try {
      deletedDocuments = await deleteInBatches(projectId, token, selected.documents, { apiRoot, fetcher });
    } catch (error) {
      deleteError = error;
      deletedDocuments = Number.isSafeInteger(error?.deletedDocuments) ? error.deletedDocuments : 0;
    }

    let remaining;
    try {
      remaining = await inventory(projectId, token, { apiRoot, fetcher });
    } catch (error) {
      summary.status = 'verification-failed';
      summary.confirmedDeletedDocuments = deletedDocuments;
      summary.verificationError = errorMessage(error);
      await reportWriter?.write(summary);
      throw new Error(
        '清理请求已停止；已确认删除 ' + deletedDocuments +
        ' 份文档，但清理后盘点失败（' + errorMessage(error) +
        '）。请先恢复 Firestore 管理权限/网络，再运行只读盘点确认剩余数据。'
      );
    }

    summary = {
      ...summary,
      confirmedDeletedDocuments: deletedDocuments,
      remainingAccountSnapshots: remaining.accountDocuments.length,
      remainingWriteQuotaDocuments: remaining.quotaDocuments.length,
      remainingBusinessDocuments: remaining.documents.length,
      remainingIgnoredCollectionGroupDocuments: remaining.ignoredDocuments.length,
    };

    if (deleteError) {
      const verifiedEmpty = remaining.documents.length === 0;
      summary.status = verifiedEmpty ? 'response-anomaly-verified-empty' : 'partial-failure';
      summary.deleteError = errorMessage(deleteError);
      summary.deleteOutcomeUnknown = deleteError.outcomeUnknown === true;
      summary.failedWrites = deleteError.failureCount ?? 0;
      await reportWriter?.write(summary);
      if (verifiedEmpty) {
        throw new Error(
          '删除请求返回异常：' + errorMessage(deleteError) +
          '；但重新盘点已确认 0 份规范业务文档剩余。请人工复核报告和审计日志后再认定操作成功。'
        );
      }
      throw new Error(
        '清理未完成：' + errorMessage(deleteError) +
        '。已确认成功删除 ' + deletedDocuments + ' 份；重新盘点仍有 ' +
        remaining.documents.length + ' 份规范业务文档（快照 ' +
        remaining.accountDocuments.length + '，配额 ' + remaining.quotaDocuments.length +
        '）。请检查 IAM 权限、并发写入或 updateTime 冲突，重新只读盘点后再决定是否重试。'
      );
    }
    if (remaining.documents.length !== 0) {
      summary.status = 'incomplete';
      await reportWriter?.write(summary);
      throw new Error(
        '清理后仍有 ' + remaining.documents.length +
        ' 份规范业务文档；可能有并发写入或新文档在盘点期间创建。请暂停客户端同步，重新只读盘点后再执行。'
      );
    }

    summary.status = 'complete';
    summary.deletedDocuments = deletedDocuments;
    await reportWriter?.write(summary);
    const ignoredNote = remaining.ignoredDocuments.length
      ? '另有 ' + remaining.ignoredDocuments.length +
        ' 份不符合规范路径的 accounts/usage 集合组文档未触碰，请单独审计。'
      : '';
    return {
      summary,
      message: '清理完成；重新盘点确认两类规范业务文档均为零。Firebase Authentication 用户和 Chrome 本地数据未被访问。' +
        ignoredNote,
    };
  } catch (error) {
    if (reportWriter) {
      try {
        await reportWriter.write({
          ...(summary ?? { projectId, mode: execute ? 'execute' : 'inventory' }),
          status: ['partial-failure', 'verification-failed', 'response-anomaly-verified-empty', 'incomplete']
            .includes(summary?.status) ? summary.status : 'failed',
          error: errorMessage(error),
        });
      } catch {
        // The original operation error remains authoritative.
      }
    }
    throw error;
  } finally {
    await reportWriter?.close();
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await runFirestoreReset(args);
  process.stdout.write(JSON.stringify(result.summary, null, 2) + '\n');
  process.stdout.write(result.message + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(errorMessage(error) + '\n');
    process.exitCode = 1;
  });
}
