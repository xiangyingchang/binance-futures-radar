'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FEATURE_DEFINITIONS,
  RULE_SPECS,
  finalClassification,
  renderCsv,
} = require('../scripts/btc-v3-exposure-curve-v4-mechanism');

test('V4 uses a fixed, pre-registered rule set without fitted 2025/2026 thresholds', () => {
  assert.deepEqual(
    RULE_SPECS.map((rule) => rule.name),
    [
      'bear_lock_on',
      'trend_score_low',
      'ma200_slope_negative',
      'baseline_exposure_high',
      'rv30_high',
      'price_below_ma200',
      'ema_bearish',
      'pre7d_negative',
      'pre30d_negative',
      'pre7d_three_down',
      'pre7d_five_down',
      'pre7d_seven_down',
      '365d_drawdown_20',
    ],
  );
  assert.ok(RULE_SPECS.every((rule) => typeof rule.predicate === 'function'));
  assert.equal(FEATURE_DEFINITIONS.length >= 18, true);
});

test('V4 invalidates the result when frozen-data or future-information checks fail', () => {
  const result = finalClassification([], {
    stage3ResultPresent: true,
    clusterSetReproduced: true,
    frozenParametersMatch: true,
    onlyPreCrashInputs: false,
    noFundingImputation: true,
  });
  assert.equal(result.classification, 'invalid');
});

test('V4 cluster CSV contains every required pre-crash feature and funding audit field', () => {
  const csv = renderCsv([{
    scenario: 'curve_mild',
    year: 2026,
    clusterId: 'crash-2026-01-01',
    v3TrendScore: 0,
    bearLock: true,
    baselineTargetExposure: 0,
    preCrash7dRealizedVol: 0.5,
    fundingStatus7d: 'partial',
  }]);
  for (const feature of FEATURE_DEFINITIONS) assert.match(csv, new RegExp(feature.key));
  assert.match(csv, /fundingExpectedSlots7d/);
  assert.match(csv, /fundingCoverageRatio7d/);
  assert.match(csv, /crash-2026-01-01/);
});
