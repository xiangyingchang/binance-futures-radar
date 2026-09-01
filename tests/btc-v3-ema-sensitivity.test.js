'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { computeSignal } = require('../lib/btc-v3-strategy');
const {
  EMA_VARIANTS,
  computeSensitivitySignal,
  nearestClosedMark,
  executionPriceAtFunding,
} = require('../scripts/btc-v3-ema-sensitivity');

function syntheticCloses(count = 420) {
  return Array.from({ length: count }, (_, index) => {
    const cycle = Math.sin(index / 17) * 2;
    const trend = index * 0.4;
    return 100 + trend + cycle;
  });
}

test('only the four frozen EMA pairs are present', () => {
  assert.deepEqual(EMA_VARIANTS.map((variant) => [variant.emaFast, variant.emaSlow]), [
    [15, 30],
    [20, 60],
    [20, 50],
    [10, 30],
  ]);
});

test('EMA15/EMA30 sensitivity baseline delegates to the production signal', () => {
  const closes = syntheticCloses();
  const production = computeSignal(closes);
  const sensitivity = computeSensitivitySignal(closes, 15, 30);
  assert.equal(sensitivity.signalImplementation, 'lib/btc-v3-strategy.js::computeSignal');
  for (const key of ['trendScore', 'bearLock', 'finalTarget', 'ma200', 'ma200Slope30', 'rv30', 'ema15', 'ema30']) {
    assert.equal(sensitivity[key], production[key], key);
  }
});

test('non-baseline EMA variants preserve the frozen gates and only change EMA values', () => {
  const closes = syntheticCloses();
  const baseline = computeSensitivitySignal(closes, 15, 30);
  const slow = computeSensitivitySignal(closes, 20, 60);
  assert.equal(slow.emaFastPeriod, 20);
  assert.equal(slow.emaSlowPeriod, 60);
  assert.equal(slow.ma200, baseline.ma200);
  assert.equal(slow.ma200Slope30, baseline.ma200Slope30);
  assert.equal(slow.drawdown365, baseline.drawdown365);
  assert.equal(slow.ma200Deviation, baseline.ma200Deviation);
  assert.equal(slow.rv30, baseline.rv30);
  assert.equal(slow.marginCap, baseline.marginCap);
});

test('funding mark lookup never uses a still-forming candle', () => {
  const hour = 3600000;
  const candles = [
    { openTime: 0, closeTime: 4 * hour - 1, close: 100 },
    { openTime: 4 * hour, closeTime: 8 * hour - 1, close: 110 },
  ];
  assert.equal(nearestClosedMark(candles, 2 * hour), null);
  assert.equal(nearestClosedMark(candles, 4 * hour), 100);
  assert.equal(nearestClosedMark(candles, 8 * hour), 110);
});

test('funding execution fallback uses the prior closed daily bar or next open', () => {
  const day = 86400000;
  const bars = [
    { openTime: 0, closeTime: day - 1, open: 100, close: 105 },
    { openTime: day, closeTime: 2 * day - 1, open: 110, close: 115 },
  ];
  assert.equal(executionPriceAtFunding(bars, 12 * 3600000), 100);
  assert.equal(executionPriceAtFunding(bars, day), 110);
  assert.equal(executionPriceAtFunding(bars, 3 * day), 115);
});
