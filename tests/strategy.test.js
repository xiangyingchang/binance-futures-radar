'use strict';

const assert = require('assert');
const {
  calculateRsiSeries,
  currentRsi,
  percentileRank,
  hardFilterReasons,
  scoreCandidate,
} = require('../lib/strategy');

const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
assert.strictEqual(currentRsi(rising, 14), 100, 'steady rise should produce RSI 100');

const flat = Array.from({ length: 40 }, () => 100);
assert.strictEqual(currentRsi(flat, 14), 50, 'flat series should produce RSI 50');

const series = calculateRsiSeries(rising, 14);
assert.strictEqual(series.length, rising.length);
assert.strictEqual(series.slice(0, 14).every((v) => v === null), true);

const pctl = percentileRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 9);
assert.strictEqual(pctl, 90);

assert.deepStrictEqual(hardFilterReasons({
  base: 'TEST',
  rank: 180,
  listingAgeDays: 120,
  quoteVolumeUsd: 50_000_000,
  dailyRsi: 94,
  return7dPct: 80,
}), []);

const scored = scoreCandidate({
  rank: 180,
  listingAgeDays: 120,
  quoteVolumeUsd: 50_000_000,
  dailyRsi: 94,
  return7dPct: 80,
  fundingPercentile: 96,
  oi24hPct: 35,
  oi7dPct: 55,
  reversal: {
    bearishDivergence: true,
    structureBreak4h: true,
    rsi1hCrossBelow80: false,
    structureBreak1h: false,
    reversalCount: 2,
  },
});
assert.strictEqual(scored.status, 'SHORT_SETUP');
assert.ok(scored.score >= 85);

const squeezeRisk = scoreCandidate({
  rank: 180,
  listingAgeDays: 120,
  quoteVolumeUsd: 50_000_000,
  dailyRsi: 94,
  return7dPct: 80,
  fundingPercentile: 96,
  oi24hPct: 35,
  oi7dPct: 55,
  manualSqueezeRisk: true,
  reversal: {
    bearishDivergence: true,
    structureBreak4h: true,
    rsi1hCrossBelow80: false,
    structureBreak1h: false,
    reversalCount: 2,
  },
});
assert.strictEqual(squeezeRisk.status, 'WATCH', 'manual SQUEEZE_RISK must veto a new short setup');
assert.strictEqual(squeezeRisk.manualVetoApplied, true);
assert.ok(squeezeRisk.score >= 85, 'veto should preserve signal quality score for later re-evaluation');

const degraded = scoreCandidate({
  rank: 180,
  listingAgeDays: 120,
  quoteVolumeUsd: 50_000_000,
  dailyRsi: 94,
  return7dPct: 80,
  fundingPercentile: null,
  oi24hPct: null,
  oi7dPct: null,
  reversal: { bearishDivergence: true, structureBreak4h: true, reversalCount: 2 },
});
assert.notStrictEqual(degraded.status, 'SHORT_SETUP', 'missing crowding data must never become SHORT_SETUP');

console.log('strategy tests passed');
