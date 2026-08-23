'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runScenario } = require('../scripts/btc-v3-exposure-curve-research');
const { buildCrashClusters, fundingSlotDiagnostics, renderEventsCsv } = require('../scripts/btc-v3-exposure-curve-v3-validation');

const DAY = 86400000;
const HOUR = 3600000;

function bar(openTime, open, high, low, close) {
  return { openTime, open, high, low, close, closeTime: openTime + HOUR - 1, intervalMs: HOUR };
}

test('crash clusters use the execution path when Index does not show the same intraday drawdown', () => {
  const start = Date.parse('2024-01-01T00:00:00Z');
  const executionBars = [
    bar(start, 100, 101, 100, 100),
    bar(start + DAY, 100, 100, 90, 99),
  ];
  const indexDaily = [
    { openTime: start, open: 100, high: 101, low: 99, close: 100, closeTime: start + DAY - 1 },
    { openTime: start + DAY, open: 100, high: 101, low: 98, close: 99, closeTime: start + 2 * DAY - 1 },
  ];
  const clusters = buildCrashClusters(
    { executionBars, indexDaily },
    { startTime: start, endTime: start + DAY },
  );
  assert.equal(clusters.clusterForTimestamp(start + DAY + 30 * 60000), 'crash-2024-01-02');
  assert.equal(clusters.clusters[0].sources[0].executionCrash, true);
});

test('capture trace exposes actual maker fills and lot PnL without changing the 1H path', () => {
  const start = Date.parse('2024-01-01T00:00:00Z');
  const executionBar = bar(start, 200, 200, 180, 190);
  const market = {
    contract: { contractSize: 100 },
    executionBars: [executionBar],
    markBars: [executionBar],
    indexDaily: [],
    funding: [],
    fundingByExecutionOpen: new Map(),
    fundingData: { firstFundingTime: null, lastFundingTime: null, missingMonths: [] },
  };
  const result = runScenario(
    { name: 'curve_trace', type: 'curve', levels: [{ drop: -0.05, bonus: 0.40 }] },
    market,
    { name: 'synthetic', startTime: start, endTime: executionBar.closeTime },
    { fixedTargetExposure: 1.0, captureTrace: true, crashClusterForTimestamp: () => 'crash-test' },
  );
  assert.equal(result.makerFillEvents.length, 1);
  assert.equal(result.makerFillEvents[0].clusterId, 'crash-test');
  assert.ok(result.lotRecords.some((lot) => lot.source === 'maker_fill'));
  assert.equal(result.trace.length, 1);
});

test('event CSV includes fill-level attribution columns', () => {
  const csv = renderEventsCsv([{
    fills: [{
      scenario: 'curve_mild',
      fillId: 'fill-1',
      fillTimeUtc: '2024-01-01T00:00:00.000Z',
      crashClusterId: 'crash-2024-01-01',
      sameCrashClusterMultipleFills: true,
      relativeBaselineIncrementalPnlBtc: 0.01,
    }],
  }]);
  assert.match(csv, /baselineTargetExposure/);
  assert.match(csv, /relativeBaselineIncrementalPnlBtc/);
  assert.match(csv, /sameCrashClusterMultipleFills/);
  assert.match(csv, /fill-1/);
});

test('funding diagnostics reports archive-internal missing 8-hour slots without imputing them', () => {
  const start = Date.UTC(2024, 0, 1);
  const end = Date.UTC(2024, 0, 31, 23, 59, 59, 999);
  const funding = [];
  for (let timestamp = start; timestamp <= Date.UTC(2024, 0, 31); timestamp += 8 * HOUR) {
    funding.push({ fundingTime: timestamp, fundingIntervalHours: 8, fundingRate: 0.0001 });
  }
  const diagnostics = fundingSlotDiagnostics(
    { funding, fundingData: { firstFundingTime: start, missingMonths: [] } },
    { startTime: start, endTime: end },
  );
  assert.equal(diagnostics.expectedEvents, 93);
  assert.equal(diagnostics.availableEvents, 91);
  assert.equal(diagnostics.missingSlots.length, 2);
  assert.deepEqual(diagnostics.internalArchiveGapMonths, ['2024-01']);
  assert.equal(diagnostics.internalGapPattern, true);
});
