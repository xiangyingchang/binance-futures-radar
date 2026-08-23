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
  const token = 'github-token-test-only';
  let content = '';
  let sha = null;
  let lastPutBody = '';
  process.env.EXECUTION_LEDGER_API_KEY = 'execution-api-key-test-only';
  process.env.GITHUB_EXECUTION_LEDGER_TOKEN = token;
  process.env.GITHUB_EXECUTION_LEDGER_REPO = 'xiangyingchang/binance-futures-radar';
  process.env.GITHUB_EXECUTION_LEDGER_BRANCH = 'main';

  function response(status, payload) {
    return {
      status,
      ok: status >= 200 && status < 300,
      async json() { return payload; },
    };
  }

  global.fetch = async (_url, options = {}) => {
    if (options.method === 'PUT') {
      lastPutBody = String(options.body || '');
      const payload = JSON.parse(lastPutBody);
      content = Buffer.from(payload.content, 'base64').toString('utf8');
      sha = 'sha-after-write';
      return response(200, { commit: { sha: 'commit-after-write' } });
    }
    if (!sha) return response(404, { message: 'Not Found' });
    return response(200, {
      type: 'file',
      sha,
      content: Buffer.from(content, 'utf8').toString('base64'),
    });
  };

  try {
    const api = require('../api/btc-v3-execution');
    const test = api._test;
    assert.strictEqual(test.authorizeWrite({ headers: {} }).status, 401);
    assert.strictEqual(test.authorizeWrite({ headers: { authorization: 'Bearer execution-api-key-test-only' } }).ok, true);
    assert.strictEqual(test.authorizeWrite({ headers: { authorization: 'Bearer wrong' } }).status, 401);
    assert.strictEqual(test.idempotencyKey({ headers: { 'idempotency-key': 'api-idempotency-test' } }), 'api-idempotency-test');

    const record = test.buildRecord({
      executionId: 'api-idempotency-test',
      side: 'BUY',
      contracts: 108,
      avgFillPrice: 77424.7,
      executedAt: null,
      targetExposureAtExecution: 1.25,
      note: 'idempotency test',
    }, '2026-08-23T00:00:00.000Z');
    assert.strictEqual(record.strategyVersion, 'btc-v3.1-coinm');
    assert.strictEqual(record.symbol, 'BTCUSD_PERP');
    assert.strictEqual(record.source, 'manual');
    assert.strictEqual(record.executionTimePrecision, 'approximate');

    const handler = api;
    const mismatchResponse = {
      statusCode: null,
      body: null,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await handler({
      method: 'POST',
      headers: {
        authorization: 'Bearer execution-api-key-test-only',
        'idempotency-key': 'different-id',
      },
      body: record,
    }, mismatchResponse);
    assert.strictEqual(mismatchResponse.statusCode, 400, 'API must bind Idempotency-Key to executionId');
    assert.strictEqual(mismatchResponse.body.error, 'EXECUTION_LEDGER_IDEMPOTENCY_KEY_REQUIRED');

    const first = await test.appendToGithub(record);
    assert.strictEqual(first.duplicate, false);
    assert.strictEqual(accounting.parseLedger(content).length, 1);
    assert.ok(!lastPutBody.includes(token), 'GitHub token must not be written into GitHub content');

    const retry = await test.appendToGithub({ ...record, recordedAt: '2026-08-23T00:01:00.000Z' });
    assert.strictEqual(retry.duplicate, true, 'same executionId and intent must be idempotent');
    assert.strictEqual(accounting.parseLedger(content).length, 1, 'idempotent retry must not append a duplicate line');

    await assert.rejects(
      () => test.appendToGithub({ ...record, avgFillPrice: 78000 }),
      (error) => error.status === 409,
      'same executionId with changed economics must be rejected',
    );
    assert.strictEqual(accounting.parseLedger(content).length, 1);
    console.log('btc v3 execution API tests passed');
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
