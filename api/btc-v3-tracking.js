'use strict';

const crypto = require('crypto');
const accounting = require('../btc-v3-execution-accounting');

const DEFAULT_REPOSITORY = 'xiangyingchang/binance-futures-radar';
const LEDGER_PATHS = Object.freeze({
  execution: 'data/btc-v3-execution-ledger.jsonl',
  capitalFlow: 'data/btc-v3-capital-flow.jsonl',
  accountSnapshot: 'data/btc-v3-account-snapshots.jsonl',
});

function config(path) {
  const repository = String(process.env.GITHUB_EXECUTION_LEDGER_REPO || DEFAULT_REPOSITORY).trim();
  const branch = String(process.env.GITHUB_EXECUTION_LEDGER_BRANCH || process.env.VERCEL_GIT_COMMIT_REF || 'main').trim();
  return { repository, branch, path };
}

function encodedPath(path) {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function rawBranchPath(branch) {
  return branch.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function contentsUrl(location) {
  return `https://api.github.com/repos/${location.repository}/contents/${encodedPath(location.path)}?ref=${encodeURIComponent(location.branch)}`;
}

function rawUrl(location) {
  return `https://raw.githubusercontent.com/${location.repository}/${rawBranchPath(location.branch)}/${encodedPath(location.path)}?t=${Date.now()}`;
}

function githubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'binance-futures-radar-v3-account-tracking/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function responseJson(response) {
  try { return await response.json(); } catch (_) { return null; }
}

async function readFromGithub(token, path, parse) {
  const location = config(path);
  const response = await fetch(contentsUrl(location), { headers: githubHeaders(token), cache: 'no-store' });
  if (response.status === 404) return { text: '', sha: null, records: [], source: 'github-empty', path };
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(`GitHub ledger read failed: HTTP ${response.status}`);
  if (payload?.type !== 'file') throw new Error(`GitHub ledger path is not a file: ${path}`);
  const content = String(payload.content || '').replace(/\s/g, '');
  const text = content ? Buffer.from(content, 'base64').toString('utf8') : '';
  return { text, sha: payload.sha || null, records: parse(text), source: 'github', path };
}

async function readFromRaw(path, parse) {
  const location = config(path);
  const response = await fetch(rawUrl(location), {
    headers: { Accept: 'application/json', 'User-Agent': 'binance-futures-radar-v3-account-tracking/1.0' },
    cache: 'no-store',
  });
  if (response.status === 404) return { text: '', sha: null, records: [], source: 'raw-empty', path };
  if (!response.ok) throw new Error(`V3 tracking ledger read failed: HTTP ${response.status}`);
  const text = await response.text();
  return { text, sha: null, records: parse(text), source: 'raw', path };
}

async function readLedger(token, path, parse) {
  return token ? readFromGithub(token, path, parse) : readFromRaw(path, parse);
}

async function readAllLedgers(token = String(process.env.GITHUB_EXECUTION_LEDGER_TOKEN || '')) {
  const [execution, capitalFlow, accountSnapshot] = await Promise.all([
    readLedger(token, LEDGER_PATHS.execution, accounting.parseLedger),
    readLedger(token, LEDGER_PATHS.capitalFlow, accounting.parseCapitalFlowLedger),
    readLedger(token, LEDGER_PATHS.accountSnapshot, accounting.parseAccountSnapshotLedger),
  ]);
  return { execution, capitalFlow, accountSnapshot };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = String(req?.headers?.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function idempotencyKey(req) {
  return String(req?.headers?.['idempotency-key'] || req?.headers?.['Idempotency-Key'] || '').trim();
}

function authorizeWrite(req) {
  const expected = String(process.env.EXECUTION_LEDGER_API_KEY || '');
  if (!expected) return { ok: false, status: 503, message: 'V3 tracking write auth is not configured' };
  if (!safeEqual(bearerToken(req), expected)) return { ok: false, status: 401, message: 'V3 tracking write authorization failed' };
  return { ok: true };
}

function requestBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { throw new Error('Request body must be valid JSON'); }
  }
  return req.body;
}

function buildCapitalFlow(body, recordedAt = new Date().toISOString()) {
  return accounting.normalizeCapitalFlow({
    ...body,
    recordType: 'capital_flow',
    source: 'manual',
    recordedAt,
  });
}

function buildAccountSnapshot(body, recordedAt = new Date().toISOString()) {
  return accounting.normalizeAccountSnapshot({
    ...body,
    recordType: 'account_snapshot',
    symbol: accounting.DEFAULT_SYMBOL,
    source: 'manual',
    recordedAt,
  });
}

async function appendLedgerToGithub({ path, record, token, parse, append, findById, sameIntent, id, message }) {
  if (!token) throw Object.assign(new Error('GitHub V3 tracking token is not configured'), { status: 503 });
  const location = config(path);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readFromGithub(token, path, parse);
    const existing = findById(current.records, id);
    if (existing) {
      if (sameIntent(existing, record)) return { duplicate: true, record: existing, source: current.source };
      throw Object.assign(new Error(`${id} already exists with different data`), { status: 409 });
    }

    const text = append(current.text, record);
    const payload = {
      message: `${message} ${id}`,
      content: Buffer.from(text, 'utf8').toString('base64'),
      branch: location.branch,
    };
    if (current.sha) payload.sha = current.sha;
    const response = await fetch(contentsUrl(location), {
      method: 'PUT',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await responseJson(response);
    if (response.ok) return { duplicate: false, record, source: 'github', commitSha: result?.commit?.sha || null };
    if (response.status === 409) continue;
    throw Object.assign(new Error(`GitHub ledger write failed: HTTP ${response.status}`), { status: 502 });
  }
  throw Object.assign(new Error('V3 tracking ledger changed concurrently; retry the submission'), { status: 409 });
}

async function appendCapitalFlowToGithub(record) {
  return appendLedgerToGithub({
    path: LEDGER_PATHS.capitalFlow,
    record,
    token: String(process.env.GITHUB_EXECUTION_LEDGER_TOKEN || ''),
    parse: accounting.parseCapitalFlowLedger,
    append: accounting.appendCapitalFlowRecord,
    findById: accounting.findCapitalFlowById,
    sameIntent: accounting.sameCapitalFlowIntent,
    id: record.flowId,
    message: 'data: append V3 capital flow',
  });
}

async function appendAccountSnapshotToGithub(record) {
  return appendLedgerToGithub({
    path: LEDGER_PATHS.accountSnapshot,
    record,
    token: String(process.env.GITHUB_EXECUTION_LEDGER_TOKEN || ''),
    parse: accounting.parseAccountSnapshotLedger,
    append: accounting.appendAccountSnapshotRecord,
    findById: accounting.findAccountSnapshotById,
    sameIntent: accounting.sameAccountSnapshotIntent,
    id: record.snapshotId,
    message: 'data: append V3 account snapshot',
  });
}

function trackingKind(body) {
  const kind = String(body?.ledgerType || body?.ledger || '').trim().toLowerCase().replace(/_/g, '-');
  if (kind === 'capital-flow' || kind === 'capital') return 'capital-flow';
  if (kind === 'account-snapshot' || kind === 'snapshot') return 'account-snapshot';
  return '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'GET') {
    try {
      const ledgers = await readAllLedgers();
      return res.status(200).json({
        appendOnly: true,
        ledgerPaths: LEDGER_PATHS,
        executionRecords: ledgers.execution.records,
        capitalFlowRecords: ledgers.capitalFlow.records,
        accountSnapshotRecords: ledgers.accountSnapshot.records,
        sources: {
          execution: ledgers.execution.source,
          capitalFlow: ledgers.capitalFlow.source,
          accountSnapshot: ledgers.accountSnapshot.source,
        },
      });
    } catch (error) {
      return res.status(error.status || 502).json({ error: 'V3_TRACKING_UNAVAILABLE', message: error.message || 'V3 tracking unavailable' });
    }
  }

  if (req.method === 'POST') {
    const auth = authorizeWrite(req);
    if (!auth.ok) {
      if (auth.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(auth.status).json({ error: 'V3_TRACKING_UNAUTHORIZED', message: auth.message });
    }
    try {
      const body = requestBody(req);
      const kind = trackingKind(body);
      if (!kind) return res.status(400).json({ error: 'V3_TRACKING_LEDGER_REQUIRED', message: 'ledgerType must be capital-flow or account-snapshot' });

      const record = kind === 'capital-flow' ? buildCapitalFlow(body) : buildAccountSnapshot(body);
      const id = kind === 'capital-flow' ? record.flowId : record.snapshotId;
      if (!idempotencyKey(req) || idempotencyKey(req) !== id) {
        return res.status(400).json({ error: 'V3_TRACKING_IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key must match flowId or snapshotId' });
      }

      const result = kind === 'capital-flow'
        ? await appendCapitalFlowToGithub(record)
        : await appendAccountSnapshotToGithub(record);
      return res.status(result.duplicate ? 200 : 201).json({
        ok: true,
        ledgerType: kind,
        duplicate: result.duplicate,
        record: result.record,
        appendOnly: true,
      });
    } catch (error) {
      return res.status(error.status || 400).json({ error: 'V3_TRACKING_WRITE_FAILED', message: error.message || 'V3 tracking write failed' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports._test = {
  LEDGER_PATHS,
  appendAccountSnapshotToGithub,
  appendCapitalFlowToGithub,
  appendLedgerToGithub,
  authorizeWrite,
  buildAccountSnapshot,
  buildCapitalFlow,
  config,
  idempotencyKey,
  readAllLedgers,
  safeEqual,
  trackingKind,
};
