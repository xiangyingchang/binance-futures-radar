'use strict';

const assert = require('assert');
const accounting = require('../btc-v3-execution-accounting');

async function main() {
  const originalFetch = global.fetch;
  const originalEnv = {
    apiKey: process.env.EXECUTION_LEDGER_API_KEY,
    githubToken: process.env.GITHUB_EXECUTION_LEDGER_TOKEN,
    repo: process.env.GITHUB_EXECUTION_LEDGER_REPO,
    branch: process.env.GITHUB_EXECUTION_LEDGER_BRANCH,
  };
  const token = 'github-tracking-token-test-only';
  const apiKey = 'tracking-api-key-test-only';
  const files = new Map();
  const putBodies = [];
  process.env.EXECUTION_LEDGER_API_KEY = apiKey;
  process.env.GITHUB_EXECUTION_LEDGER_TOKEN = token;
  process.env.GITHUB_EXECUTION_LEDGER_REPO = 'xiangyingchang/binance-futures-radar';
  process.env.GITHUB_EXECUTION_LEDGER_BRANCH = 'main';

  function response(status, payload) {
    return {
      status,
      ok: status >= 200 && status < 300,
      async json() { return payload; },
      async text() { return typeof payload === 'string' ? payload : JSON.stringify(payload); },
    };
  }

  function pathForUrl(url) {
    for (const filePath of [
      'data/btc-v3-execution-ledger.jsonl',
      'data/btc-v3-capital-flow.jsonl',
      'data/btc-v3-account-snapshots.jsonl',
    ]) {
      if (String(url).includes(filePath)) return filePath;
    }
    return null;
  }

  global.fetch = async (url, options = {}) => {
    const filePath = pathForUrl(url);
    assert.ok(filePath, `unexpected GitHub URL: ${url}`);
    if (options.method === 'PUT') {
      const body = String(options.body || '');
      putBodies.push(body);
      const payload = JSON.parse(body);
      const text = Buffer.from(payload.content, 'base64').toString('utf8');
      files.set(filePath, { text, sha: `sha-${files.size + 1}` });
      return response(200, { commit: { sha: `commit-${files.size}` } });
    }
    const file = files.get(filePath);
    if (!file) return response(404, { message: 'Not Found' });
    return response(200, {
      type: 'file',
      sha: file.sha,
      content: Buffer.from(file.text, 'utf8').toString('base64'),
    });
  };

  try {
    const api = require('../api/btc-v3-tracking');
    const test = api._test;
    assert.strictEqual(test.authorizeWrite({ headers: {} }).status, 401);
    assert.strictEqual(test.authorizeWrite({ headers: { authorization: `Bearer ${apiKey}` } }).ok, true);
    assert.strictEqual(test.authorizeWrite({ headers: { authorization: 'Bearer wrong' } }).status, 401);
    assert.strictEqual(test.trackingKind({ ledgerType: 'capital_flow' }), 'capital-flow');
    assert.strictEqual(test.trackingKind({ ledgerType: 'account-snapshot' }), 'account-snapshot');

    const flow = test.buildCapitalFlow({
      flowId: 'api-flow-idempotency-test',
      flowType: 'CONTRIBUTION',
      asset: 'BTC',
      amount: 0.01,
      direction: 'IN',
      effectiveAt: null,
      effectiveTimePrecision: 'approximate',
      source: 'client-must-not-control-source',
      reason: 'DCA',
      note: 'API test',
    }, '2026-08-23T00:00:00.000Z');
    assert.strictEqual(flow.recordType, 'capital_flow');
    assert.strictEqual(flow.source, 'manual');
    assert.strictEqual(flow.recordedAt, '2026-08-23T00:00:00.000Z');

    const snapshot = test.buildAccountSnapshot({
      snapshotId: 'api-snapshot-idempotency-test',
      capturedAt: null,
      captureTimePrecision: 'approximate',
      strategyEquityBtc: 0.5757,
      actualContracts: 108,
      symbol: 'ETHUSDT',
      markPrice: null,
      note: 'API test',
    }, '2026-08-23T00:00:01.000Z');
    assert.strictEqual(snapshot.recordType, 'account_snapshot');
    assert.strictEqual(snapshot.symbol, 'BTCUSD_PERP', 'snapshot API must keep the V3 symbol fixed');
    assert.strictEqual(snapshot.source, 'manual');

    const mismatchResponse = {
      statusCode: null,
      body: null,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await api({
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'different-flow-id' },
      body: { ...flow, ledgerType: 'capital-flow' },
    }, mismatchResponse);
    assert.strictEqual(mismatchResponse.statusCode, 400);
    assert.strictEqual(mismatchResponse.body.error, 'V3_TRACKING_IDEMPOTENCY_KEY_REQUIRED');

    const firstFlow = await test.appendCapitalFlowToGithub(flow);
    assert.strictEqual(firstFlow.duplicate, false);
    assert.strictEqual(accounting.parseCapitalFlowLedger(files.get('data/btc-v3-capital-flow.jsonl').text).length, 1);

    const retryFlow = await test.appendCapitalFlowToGithub({ ...flow, recordedAt: '2026-08-23T00:05:00.000Z' });
    assert.strictEqual(retryFlow.duplicate, true, 'same flowId and intent must be idempotent');
    assert.strictEqual(accounting.parseCapitalFlowLedger(files.get('data/btc-v3-capital-flow.jsonl').text).length, 1);
    await assert.rejects(
      () => test.appendCapitalFlowToGithub({ ...flow, amount: 0.02 }),
      (error) => error.status === 409,
      'same flowId with changed amount must be rejected',
    );

    const firstSnapshot = await test.appendAccountSnapshotToGithub(snapshot);
    assert.strictEqual(firstSnapshot.duplicate, false);
    assert.strictEqual(accounting.parseAccountSnapshotLedger(files.get('data/btc-v3-account-snapshots.jsonl').text).length, 1);
    const retrySnapshot = await test.appendAccountSnapshotToGithub({ ...snapshot, recordedAt: '2026-08-23T00:05:01.000Z' });
    assert.strictEqual(retrySnapshot.duplicate, true, 'same snapshotId and intent must be idempotent');
    assert.strictEqual(accounting.parseAccountSnapshotLedger(files.get('data/btc-v3-account-snapshots.jsonl').text).length, 1);
    await assert.rejects(
      () => test.appendAccountSnapshotToGithub({ ...snapshot, actualContracts: 109 }),
      (error) => error.status === 409,
      'same snapshotId with changed contracts must be rejected',
    );

    const all = await test.readAllLedgers();
    assert.strictEqual(all.capitalFlow.records.length, 1);
    assert.strictEqual(all.accountSnapshot.records.length, 1);
    assert.strictEqual(all.execution.records.length, 0, 'tracking writes must not touch the execution ledger');
    assert.ok(putBodies.every((body) => !body.includes(token)), 'GitHub token must not appear in write payloads');
    console.log('btc v3 tracking API tests passed');
  } finally {
    global.fetch = originalFetch;
    if (originalEnv.apiKey === undefined) delete process.env.EXECUTION_LEDGER_API_KEY;
    else process.env.EXECUTION_LEDGER_API_KEY = originalEnv.apiKey;
    if (originalEnv.githubToken === undefined) delete process.env.GITHUB_EXECUTION_LEDGER_TOKEN;
    else process.env.GITHUB_EXECUTION_LEDGER_TOKEN = originalEnv.githubToken;
    if (originalEnv.repo === undefined) delete process.env.GITHUB_EXECUTION_LEDGER_REPO;
    else process.env.GITHUB_EXECUTION_LEDGER_REPO = originalEnv.repo;
    if (originalEnv.branch === undefined) delete process.env.GITHUB_EXECUTION_LEDGER_BRANCH;
    else process.env.GITHUB_EXECUTION_LEDGER_BRANCH = originalEnv.branch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
