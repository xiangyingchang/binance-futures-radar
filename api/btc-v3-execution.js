'use strict';

const crypto = require('crypto');
const {
  DEFAULT_STRATEGY_VERSION,
  DEFAULT_SYMBOL,
  normalizeRecord,
  parseLedger,
  appendLedgerRecord,
  sameExecutionIntent,
  findExecutionById,
} = require('../btc-v3-execution-accounting');

const LEDGER_PATH = 'data/btc-v3-execution-ledger.jsonl';
const PUBLIC_CODE_REPOSITORY = 'xiangyingchang/binance-futures-radar';

function config() {
  const repository = String(process.env.GITHUB_V3_TRACKING_DATA_REPO || '').trim();
  const branch = String(process.env.GITHUB_V3_TRACKING_DATA_BRANCH || 'main').trim();
  if (!repository) {
    throw Object.assign(new Error('GITHUB_V3_TRACKING_DATA_REPO is not configured; V3 private tracking data must not fall back to the public code repository'), { status: 503 });
  }
  if (repository.toLowerCase() === PUBLIC_CODE_REPOSITORY.toLowerCase()) {
    throw Object.assign(new Error('GITHUB_V3_TRACKING_DATA_REPO must point to the private data repository, not the public code repository'), { status: 503 });
  }
  return { repository, branch, path: LEDGER_PATH };
}

function encodedPath(path) {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function contentsUrl({ repository, branch, path }) {
  return `https://api.github.com/repos/${repository}/contents/${encodedPath(path)}?ref=${encodeURIComponent(branch)}`;
}

function githubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'binance-futures-radar-execution-ledger/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function responseJson(response) {
  try { return await response.json(); } catch (_) { return null; }
}

async function readFromGithub(token) {
  if (!token) throw Object.assign(new Error('GITHUB_V3_TRACKING_DATA_TOKEN is not configured'), { status: 503 });
  const location = config();
  const response = await fetch(contentsUrl(location), { headers: githubHeaders(token), cache: 'no-store' });
  if (response.status === 404) return { text: '', sha: null, records: [], source: 'github-empty' };
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(`GitHub ledger read failed: HTTP ${response.status}`);
  if (payload?.type !== 'file') throw new Error('GitHub execution ledger path is not a file');
  const content = String(payload.content || '').replace(/\s/g, '');
  const text = content ? Buffer.from(content, 'base64').toString('utf8') : '';
  return { text, sha: payload.sha || null, records: parseLedger(text), source: 'github' };
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
  const expected = String(process.env.V3_TRACKING_ACCESS_KEY || '');
  if (!expected) return { ok: false, status: 503, message: 'V3 tracking access key is not configured' };
  if (!safeEqual(bearerToken(req), expected)) return { ok: false, status: 401, message: 'V3 tracking authorization failed' };
  return { ok: true };
}

function authorizeAccess(req) {
  return authorizeWrite(req);
}

function requestBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { throw new Error('Request body must be valid JSON'); }
  }
  return req.body;
}

function buildRecord(body, recordedAt = new Date().toISOString()) {
  return normalizeRecord({
    ...body,
    recordType: body.recordType || 'execution',
    strategyVersion: DEFAULT_STRATEGY_VERSION,
    symbol: DEFAULT_SYMBOL,
    source: 'manual',
    executionTimePrecision: body.executionTimePrecision || 'approximate',
    recordedAt,
  });
}

async function appendToGithub(record) {
  const token = String(process.env.GITHUB_V3_TRACKING_DATA_TOKEN || '');
  if (!token) throw Object.assign(new Error('GitHub execution ledger token is not configured'), { status: 503 });
  const location = config();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readFromGithub(token);
    const existing = findExecutionById(current.records, record.executionId);
    if (existing) {
      if (sameExecutionIntent(existing, record)) return { duplicate: true, record: existing, source: current.source };
      throw Object.assign(new Error('executionId already exists with different execution data'), { status: 409 });
    }

    const text = appendLedgerRecord(current.text, record);
    const payload = {
      message: `data: append V3 execution ${record.executionId}`,
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
  throw Object.assign(new Error('Execution ledger changed concurrently; retry the submission'), { status: 409 });
}

async function readLedger() {
  return readFromGithub(String(process.env.GITHUB_V3_TRACKING_DATA_TOKEN || ''));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'GET') {
    const auth = authorizeAccess(req);
    if (!auth.ok) {
      if (auth.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(auth.status).json({ error: 'EXECUTION_LEDGER_UNAUTHORIZED', message: auth.message });
    }
    try {
      const ledger = await readLedger();
      return res.status(200).json({
        ledgerPath: config().path,
        appendOnly: true,
        records: ledger.records,
        source: ledger.source,
      });
    } catch (error) {
      return res.status(error.status || 502).json({ error: 'EXECUTION_LEDGER_UNAVAILABLE', message: error.message || 'Execution ledger unavailable' });
    }
  }

  if (req.method === 'POST') {
    const auth = authorizeWrite(req);
    if (!auth.ok) {
      if (auth.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(auth.status).json({ error: 'EXECUTION_LEDGER_UNAUTHORIZED', message: auth.message });
    }
    try {
      const record = buildRecord(requestBody(req));
      if (!idempotencyKey(req) || idempotencyKey(req) !== record.executionId) {
        return res.status(400).json({
          error: 'EXECUTION_LEDGER_IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key must match executionId',
        });
      }
      const result = await appendToGithub(record);
      return res.status(result.duplicate ? 200 : 201).json({
        ok: true,
        duplicate: result.duplicate,
        record: result.record,
        appendOnly: true,
      });
    } catch (error) {
      return res.status(error.status || 400).json({ error: 'EXECUTION_LEDGER_WRITE_FAILED', message: error.message || 'Execution ledger write failed' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports._test = {
  authorizeAccess,
  authorizeWrite,
  appendToGithub,
  bearerToken,
  buildRecord,
  config,
  idempotencyKey,
  safeEqual,
};
