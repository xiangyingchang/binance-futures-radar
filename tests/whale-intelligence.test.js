'use strict';

const assert = require('assert');
const {
  WATCHED_ENTITIES,
  isTrackedAddress,
  buildWhaleSnapshot,
} = require('../lib/whale-intelligence');

const entity = WATCHED_ENTITIES[0];
const address = entity.addresses[0];
const now = Date.now();
const ts = String(Math.floor((now - 60 * 60 * 1000) / 1000));

assert.strictEqual(isTrackedAddress(address.toUpperCase(), entity), true);
assert.strictEqual(isTrackedAddress('0x0000000000000000000000000000000000000001', entity), false);

const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const dex = '0x1111111111111111111111111111111111111111';

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

console.log('whale intelligence tests passed');
