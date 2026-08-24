 'use strict';

 const assert = require('assert');
 const api = require('../api/btc-v3-execution');

 const ACCESS_KEY = 'v3-execution-access-key-test-only';
 const GITHUB_TOKEN = 'github-execution-token-test-only';
 const PRIVATE_REPO = 'xiangyingchang/binance-futures-radar-private-data';

 function response(status, payload) {
   return {
     status,
     ok: status >= 200 && status < 300,
     async json() { return payload; },
     async text() { return typeof payload === 'string' ? payload : JSON.stringify(payload); },
   };
 }

 function res() {
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
   process.env.V3_TRACKING_ACCESS_KEY = ACCESS_KEY;
   process.env.GITHUB_V3_TRACKING_DATA_TOKEN = GITHUB_TOKEN;
   process.env.GITHUB_V3_TRACKING_DATA_REPO = PRIVATE_REPO;
   process.env.GITHUB_V3_TRACKING_DATA_BRANCH = 'main';
   const requested = [];
   global.fetch = async (url, options = {}) => {
     requested.push(String(url));
     assert.ok(String(url).includes(PRIVATE_REPO));
     assert.strictEqual(options.headers.Authorization, 'Bearer ' + GITHUB_TOKEN);
     return response(404, { message: 'Not Found' });
   };
   try {
     assert.strictEqual(api._test.config().repository, PRIVATE_REPO);
     const anonymous = res();
     await api({ method: 'GET', headers: {} }, anonymous);
     assert.strictEqual(anonymous.statusCode, 401);
     assert.ok(!JSON.stringify(anonymous.body).includes('records'));

     const wrong = res();
     await api({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, wrong);
     assert.strictEqual(wrong.statusCode, 401);

     const correct = res();
     await api({ method: 'GET', headers: { authorization: 'Bearer ' + ACCESS_KEY } }, correct);
     assert.strictEqual(correct.statusCode, 200);
     assert.deepStrictEqual(correct.body.records, []);

     const anonymousPost = res();
     await api({ method: 'POST', headers: {}, body: {} }, anonymousPost);
     assert.strictEqual(anonymousPost.statusCode, 401);

     const missingKey = res();
     await api({ method: 'POST', headers: { authorization: 'Bearer ' + ACCESS_KEY }, body: {} }, missingKey);
     assert.strictEqual(missingKey.statusCode, 400, 'authenticated POST still requires a valid body and idempotency key');

     delete process.env.GITHUB_V3_TRACKING_DATA_TOKEN;
     const noToken = res();
     await api({ method: 'GET', headers: { authorization: 'Bearer ' + ACCESS_KEY } }, noToken);
     assert.strictEqual(noToken.statusCode, 503);

     assert.ok(requested.every((url) => url.includes(PRIVATE_REPO)));
     console.log('btc v3 execution API privacy tests passed');
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
