'use strict';

const assert = require('assert');
const {
  WATCHED_ENTITIES,
  isTrackedAddress,
  buildWhaleSnapshot,
} = require('../lib/whale-intelligence');
const apiTest = require('../api/whale-intelligence')._test;

const entity = WATCHED_ENTITIES[0];
const address = entity.addresses[0];
const now = Date.now();
const ts = String(Math.floor((now - 60 * 60 * 1000) / 1000));
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const dex = '0x1111111111111111111111111111111111111111';

assert.strictEqual(isTrackedAddress(address.toUpperCase(), entity), true);
assert.strictEqual(isTrackedAddress('0x0000000000000000000000000000000000000001', entity), false);

const accumulating = buildWhaleSnapshot({
  entity,
  ethPriceUsd: 2000,
  now,
  normalRows: [],
  internalRows: [],
  tokenRows: [
    {
      hash: '0xaccumulate', timeStamp: ts, from: dex, to: address,
      contractAddress: weth, value: String(6000n * 10n ** 18n), tokenDecimal: '18',
    },
    {
      hash: '0xaccumulate', timeStamp: ts, from: address, to: dex,
      contractAddress: usdc, value: String(12_000_000n * 10n ** 6n), tokenDecimal: '6',
    },
  ],
});
assert.strictEqual(accumulating.state.state, 'ACCUMULATING');
assert.ok(accumulating.summary24h.ethNet > 5900);
assert.ok(accumulating.summary24h.stableNetUsd < -11_000_000);
assert.strictEqual(accumulating.significantActions[0].classification, 'ACCUMULATING');

const distributing = buildWhaleSnapshot({
  entity,
  ethPriceUsd: 2500,
  now,
  normalRows: [],
  internalRows: [],
  tokenRows: [
    {
      hash: '0xdistribute', timeStamp: ts, from: address, to: dex,
      contractAddress: weth, value: String(5000n * 10n ** 18n), tokenDecimal: '18',
    },
    {
      hash: '0xdistribute', timeStamp: ts, from: dex, to: address,
      contractAddress: usdc, value: String(12_500_000n * 10n ** 6n), tokenDecimal: '6',
    },
  ],
});
assert.strictEqual(distributing.state.state, 'DISTRIBUTING');
assert.ok(distributing.summary24h.ethNet < -4900);
assert.ok(distributing.summary24h.stableNetUsd > 12_000_000);
assert.strictEqual(distributing.significantActions[0].classification, 'DISTRIBUTING');

const topic = apiTest.padTopicAddress(address);
assert.strictEqual(apiTest.topicToAddress(topic), address);
assert.strictEqual(apiTest.decodeUint('0x0de0b6b3a7640000'), '1000000000000000000');
assert.strictEqual(apiTest.buildRanges(100, 15100).length, 3);

const answer = 2338n * 100000000n;
const fakeRoundData = `0x${'0'.repeat(64)}${answer.toString(16).padStart(64, '0')}${'0'.repeat(64 * 3)}`;
assert.strictEqual(apiTest.decodeChainlinkEthUsd(fakeRoundData), 2338);

const log = {
  address: weth,
  transactionHash: '0xabc',
  blockNumber: '0x64',
  topics: [
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    apiTest.padTopicAddress(dex),
    topic,
  ],
  data: '0x0de0b6b3a7640000',
};
const rows = apiTest.logsToTokenRows([log], new Map([[100, Number(ts)]]));
assert.strictEqual(rows.length, 1);
assert.strictEqual(rows[0].to, address);
assert.strictEqual(rows[0].value, '1000000000000000000');

console.log('whale intelligence tests passed');
