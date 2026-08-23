'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runScenario, ohlcPath, scenarioDefinitions, fundingEventsByExecutionOpen } = require('../scripts/btc-v3-exposure-curve-research');

function syntheticMarket(bars, funding = []) {
  const fundingByExecutionOpen = new Map();
  for (const event of funding) fundingByExecutionOpen.set(event.fundingTime, [event]);
  return {
    contract: { contractSize: 100 },
    executionBars: bars,
    markBars: bars,
    indexDaily: [],
    funding,
    fundingByExecutionOpen,
    fundingData: {
      firstFundingTime: funding[0]?.fundingTime || null,
      lastFundingTime: funding.at(-1)?.fundingTime || null,
      missingMonths: [],
    },
  };
}

function bar(openTime, open, high, low, close) {
  return { openTime, open, high, low, close, closeTime: openTime + 3600000 - 1, intervalMs: 3600000 };
}

const zeroCosts = {
  makerFeeBps: 0,
  takerFeeBps: 0,
  makerSlippageBps: 0,
  takerSlippageBps: 0,
};

test('intraday mark-to-market settles each price segment exactly once', () => {
  const start = Date.parse('2024-01-01T00:00:00Z');
  const first = bar(start, 100, 110, 90, 105);
  const market = syntheticMarket([first]);
  const result = runScenario(
    { name: 'fixed_baseline', type: 'baseline' },
    market,
    { name: 'synthetic', startTime: start, endTime: first.closeTime },
    { fixedTargetExposure: 1.5, ...zeroCosts },
  );
  assert.equal(result.tradeCount, 1);
  const expected = 1 + (100 * (1 / 100 - 1 / 105));
  assert.ok(Math.abs(result.endingBtc - expected) < 1e-12, `ending BTC was ${result.endingBtc}`);
});

test('maker ladder fill is a single trade and preserves the lower fill price', () => {
  const start = Date.parse('2024-01-01T00:00:00Z');
  const first = bar(start, 100, 100, 90, 100);
  const market = syntheticMarket([first]);
  const result = runScenario(
    { name: 'fixed_ladder', type: 'ladder', immediateFraction: 0, levels: [-0.05] },
    market,
    { name: 'synthetic', startTime: start, endTime: first.closeTime },
    { fixedTargetExposure: 1.5, ...zeroCosts },
  );
  const expected = 1 + (100 * (1 / 95 - 1 / 100));
  assert.equal(result.tradeCount, 1);
  assert.equal(result.ladderFillRate, 1);
  assert.ok(Math.abs(result.endingBtc - expected) < 1e-12, `ending BTC was ${result.endingBtc}`);
  assert.ok(result.attributionProxies.betterBuyPriceBtc > 0);
});

test('funding is charged to the position before the next day target is reconciled', () => {
  const start = Date.parse('2024-01-01T00:00:00Z');
  const second = start + 24 * 3600000;
  const bars = [bar(start, 100, 100, 100, 100), bar(second, 100, 100, 100, 100)];
  const funding = [{ fundingTime: second, fundingRate: 0.01, fundingIntervalHours: 8 }];
  const market = syntheticMarket(bars, funding);
  const result = runScenario(
    { name: 'fixed_baseline', type: 'baseline' },
    market,
    { name: 'synthetic', startTime: start, endTime: bars[1].closeTime },
    { fixedTargetExposure: 1.5, ...zeroCosts },
  );
  assert.ok(Math.abs(result.fundingPnlBtc + 0.01) < 1e-12, `funding PnL was ${result.fundingPnlBtc}`);
  assert.ok(Math.abs(result.endingBtc - 0.99) < 1e-12, `ending BTC was ${result.endingBtc}`);
});

test('unaligned funding is scheduled at the next available execution bar, never before the gap', () => {
  const start = Date.parse('2024-01-01T00:00:00Z');
  const bars = [bar(start, 100, 100, 100, 100), bar(start + 2 * 3600000, 102, 102, 102, 102)];
  const event = { fundingTime: start + 3600000, fundingRate: 0.01, fundingIntervalHours: 8 };
  const alignment = fundingEventsByExecutionOpen([event], bars);
  assert.deepEqual([...alignment.byOpen.keys()], [start + 2 * 3600000]);
  assert.equal(alignment.unaligned[0].alignment, 'next_available_execution_bar_open');
});

test('scenario matrix contains the frozen required set and all threshold groups', () => {
  const definitions = scenarioDefinitions();
  assert.deepEqual(definitions.required.map((item) => item.name), [
    'baseline_immediate',
    'ladder_80_20',
    'ladder_60_40',
    'curve_mild',
    'curve_aggressive',
  ]);
  assert.deepEqual(definitions.thresholdGroups.map((item) => item.drops), [
    [-0.03, -0.06, -0.10],
    [-0.05, -0.10, -0.15],
    [-0.07, -0.12, -0.20],
  ]);
  assert.equal(definitions.matrix.length, 6);
  assert.deepEqual(ohlcPath({ open: 100, high: 110, low: 90, close: 105, openTime: 0, closeTime: 3599999 }).map((item) => item.price), [90, 110, 105]);
});
