'use strict';

const assert = require('assert');
const {
  CONFIG,
  smaAt,
  realizedVol,
  computeSignal,
  inversePnlBtc,
  fundingPnlBtc,
  targetContracts,
  maintenanceHeadroom,
} = require('../lib/btc-v3-strategy');

const rising = Array.from({ length: 420 }, (_, i) => 10000 * (1.002 ** i));
const signal = computeSignal(rising);
assert.strictEqual(signal.ready, true);
assert.strictEqual(signal.trendScore, 3);
assert.strictEqual(signal.bearLock, false);
assert.ok(signal.finalTarget > 1);
assert.ok(signal.finalTarget <= CONFIG.publicMarginCap);
assert.strictEqual(signal.autoTrade, false);

const falling = Array.from({ length: 420 }, (_, i) => 50000 * (0.998 ** i));
const bear = computeSignal(falling);
assert.strictEqual(bear.ready, true);
assert.strictEqual(bear.bearLock, true);
assert.strictEqual(bear.finalTarget, 0);

assert.strictEqual(smaAt([1, 2, 3, 4], 2), 3.5);
assert.ok(realizedVol(rising) >= 0);

const longPnl = inversePnlBtc(10, 100, 50000, 60000);
assert.ok(longPnl > 0, 'inverse long should gain BTC when price rises');
const shortPnl = inversePnlBtc(-10, 100, 50000, 40000);
assert.ok(shortPnl > 0, 'inverse short should gain BTC when price falls');

const longFunding = fundingPnlBtc(10, 100, 50000, 0.0001);
assert.ok(longFunding < 0, 'positive funding should cost long positions');
const shortFunding = fundingPnlBtc(-10, 100, 50000, 0.0001);
assert.ok(shortFunding > 0, 'positive funding should pay short positions');

const target = targetContracts({ targetExposure: 1.5, equityBtc: 1, price: 50000, contractSizeUsd: 100 });
assert.strictEqual(target.signedContracts, 250);
assert.strictEqual(target.side, 'BUY');
const hedge = targetContracts({ targetExposure: 0, equityBtc: 1, price: 50000, contractSizeUsd: 100 });
assert.strictEqual(hedge.signedContracts, -500);

const margin = maintenanceHeadroom({ equityBtc: 1, signedContracts: 250, contractSizeUsd: 100, markPrice: 50000, maintenanceRate: 0.10 });
assert.strictEqual(margin.passes, true);
assert.ok(margin.headroomMultiple > 10);

const insufficient = computeSignal(rising.slice(0, 200));
assert.strictEqual(insufficient.ready, false);

console.log('btc v3 strategy tests passed');
