 'use strict';

 const assert = require('assert');
 const accounting = require('../btc-v3-execution-accounting');
 const trackingApi = require('../api/btc-v3-tracking');
 const executionApi = require('../api/btc-v3-execution');

 const ACCESS_KEY = 'v3-tracking-access-key-test-only';
 const GITHUB_TOKEN = 'github-v3-tracking-token-test-only';
 const PRIVATE_REPO = 'xiangyingchang/binance-futures-radar-private-data';
 const PUBLIC_REPO = 'xiangyingchang/binance-futures-radar';

 function mockResponse() {
   return {
     statusCode: null,
     body: null,
     headers: {},
     setHeader(name, value) { this.headers[name] = value; },
     status(code) { this.statusCode = code; return this; },
     json(payload) { this.body = payload; return this; },
   };
 }

 async function main() {
   const originalFetch = global.fetch;
   const savedEnv = {
     accessKey: process.env.V3_TRACKING_ACCESS_KEY,
     githubToken: process.env.GITHUB_V3_TRACKING_DATA_TOKEN,
     repo: process.env.GITHUB_V3_TRACKING_DATA_REPO,
     branch: process.env.GITHUB_V3_TRACKING_DATA_BRANCH,
   };
   const files = new Map();
   const requestedUrls = [];
   let putCount = 0;

   process.env.V3_TRACKING_ACCESS_KEY = ACCESS_KEY;
   process.env.GITHUB_V3_TRACKING_DATA_TOKEN = GITHUB_TOKEN;
   process.env.GITHUB_V3_TRACKING_DATA_REPO = PRIVATE_REPO;
   process.env.GITHUB_V3_TRACKING_DATA_BRANCH = 'main';

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
     requestedUrls.push(String(url));
     assert.ok(String(url).startsWith('https://api.github.com/repos/xiangyingchang/binance-futures-radar-private-data/contents/'),
       'tracking API must read/write the private data repository: ' + url);
     const filePath = pathForUrl(url);
     assert.ok(filePath, 'unexpected GitHub URL: ' + url);
     assert.ok(String(options.headers?.Authorization || '').endsWith('Bearer ' + GITHUB_TOKEN) || String(options.headers?.authorization || '').endsWith('Bearer ' + GITHUB_TOKEN) || String(options.headers?.Authorization || '') === 'Bearer ' + GITHUB_TOKEN,
       'GitHub requests must use the server-side token');
     if (options.method === 'PUT') {
       putCount += 1;
       const payload = JSON.parse(String(options.body || '{}'));
       const text = Buffer.from(payload.content, 'base64').toString('utf8');
       files.set(filePath, { text, sha: 'sha-' + putCount });
       return response(200, { commit: { sha: 'commit-' + putCount } });
     }
     const file = files.get(filePath);
     if (!file) return response(404, { message: 'Not Found' });
     return response(200, { type: 'file', sha: file.sha, content: Buffer.from(file.text, 'utf8').toString('base64') });
   };

   try {
     // 16. Anonymous tracking GET = 401
     const anonGet = mockResponse();
     await trackingApi({ method: 'GET', headers: {} }, anonGet);
     assert.strictEqual(anonGet.statusCode, 401, 'anonymous GET must be rejected');
     assert.ok(!JSON.stringify(anonGet.body).includes('strategyEquity'), '401 must not leak ledger fields');

     const configuredKey = process.env.V3_TRACKING_ACCESS_KEY;
     delete process.env.V3_TRACKING_ACCESS_KEY;
     const missingAccessKey = mockResponse();
     await trackingApi({ method: 'GET', headers: {} }, missingAccessKey);
     assert.strictEqual(missingAccessKey.statusCode, 503, 'missing access key configuration must be a service configuration error');
     process.env.V3_TRACKING_ACCESS_KEY = configuredKey;

     // 17. Wrong key = 401; Correct key = 200
     const wrongKey = mockResponse();
     await trackingApi({ method: 'GET', headers: { authorization: 'Bearer wrong-key' } }, wrongKey);
     assert.strictEqual(wrongKey.statusCode, 401);
     const goodGet = mockResponse();
     await trackingApi({ method: 'GET', headers: { authorization: 'Bearer ' + ACCESS_KEY } }, goodGet);
     assert.strictEqual(goodGet.statusCode, 200);
     assert.ok(goodGet.body.appendOnly);

     // 18/19. Idempotency and 409 semantics
     const flowRecord = trackingApi._test.buildCapitalFlow({
       flowId: 'flow-idem-test',
       flowType: 'CONTRIBUTION',
       asset: 'BTC',
       amount: 0.02,
       direction: 'IN',
       effectiveAt: null,
       effectiveTimePrecision: 'approximate',
       reason: 'DCA',
     }, '2026-08-23T00:00:00.000Z');
     const firstAppend = await trackingApi._test.appendCapitalFlowToGithub(flowRecord);
     assert.strictEqual(firstAppend.duplicate, false);
     const retryAppend = await trackingApi._test.appendCapitalFlowToGithub({ ...flowRecord, recordedAt: '2026-08-23T01:00:00.000Z' });
     assert.strictEqual(retryAppend.duplicate, true, 'same flowId and intent must be idempotent');
     assert.strictEqual(accounting.parseCapitalFlowLedger(files.get('data/btc-v3-capital-flow.jsonl').text).length, 1);
     await assert.rejects(
       () => trackingApi._test.appendCapitalFlowToGithub({ ...flowRecord, amount: 0.03 }),
       (error) => error.status === 409,
       'same flowId with changed economics must be rejected with 409',
     );

     // POST without auth = 401
     const anonPost = mockResponse();
     await trackingApi({ method: 'POST', headers: {}, body: { ledgerType: 'capital-flow', ...flowRecord } }, anonPost);
     assert.strictEqual(anonPost.statusCode, 401);
     // POST with wrong Idempotency-Key = 400
     const mismatch = mockResponse();
     await trackingApi({
       method: 'POST',
       headers: { authorization: 'Bearer ' + ACCESS_KEY, 'idempotency-key': 'different' },
       body: { ledgerType: 'capital-flow', ...flowRecord },
     }, mismatch);
     assert.strictEqual(mismatch.statusCode, 400);

     // Execution API boundary: config must target the private repo
     assert.strictEqual(executionApi._test.config().repository, PRIVATE_REPO);
     assert.notStrictEqual(executionApi._test.config().repository, PUBLIC_REPO);

     // Execution API anonymous GET = 401
     const anonExecGet = mockResponse();
     await executionApi({ method: 'GET', headers: {} }, anonExecGet);
     assert.strictEqual(anonExecGet.statusCode, 401);
     const authedExecGet = mockResponse();
     await executionApi({ method: 'GET', headers: { authorization: 'Bearer ' + ACCESS_KEY } }, authedExecGet);
     assert.strictEqual(authedExecGet.statusCode, 200);

     // Execution API anonymous POST = 401
     const anonExecPost = mockResponse();
     await executionApi({ method: 'POST', headers: {}, body: {} }, anonExecPost);
     assert.strictEqual(anonExecPost.statusCode, 401);

     // 20. Missing private repo config = 503
     delete process.env.GITHUB_V3_TRACKING_DATA_REPO;
     assert.throws(() => trackingApi._test.config('data/btc-v3-capital-flow.jsonl'), (error) => error.status === 503);
     assert.throws(() => executionApi._test.config(), (error) => error.status === 503);

     // 21. No public repo fallback
     process.env.GITHUB_V3_TRACKING_DATA_REPO = PUBLIC_REPO;
     assert.throws(() => trackingApi._test.config('data/btc-v3-capital-flow.jsonl'), (error) => error.status === 503 && /public code repository/.test(error.message));
     assert.throws(() => executionApi._test.config(), (error) => error.status === 503 && /public code repository/.test(error.message));

     assert.ok(requestedUrls.every((url) => url.includes(PRIVATE_REPO)), 'no request may target the public code repo');
     console.log('btc v3 tracking API privacy tests passed');
   } finally {
     global.fetch = originalFetch;
     for (const [key, value] of Object.entries(savedEnv)) {
       if (value === undefined) delete process.env[key];
       else process.env[key] = value;
     }
   }
 }

 main().catch((error) => {
   console.error(error);
   process.exitCode = 1;
 });
