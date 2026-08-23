'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const accounting = require('../btc-v3-execution-accounting');
const { computeSignal } = require('../lib/btc-v3-strategy');

function record(overrides = {}) {
  return accounting.normalizeRecord({
    recordType: 'execution',
    executionId: 'test_' + Math.random().toString(36).slice(2),
    strategyVersion: 'btc-v3.1-coinm',
    symbol: 'BTCUSD_PERP',
    side: 'BUY',
    contracts: 108,
    avgFillPrice: 77424.7,
    executedAt: null,
    recordedAt: '2026-08-23T00:00:00.000Z',
    executionTimePrecision: 'approximate',
    targetExposureAtExecution: 1.25,
    source: 'manual',
    note: 'test',
    ...overrides,
  });
}

const firstBuy = record({ executionId: 'first', contracts: 108, avgFillPrice: 77424.7 });
const afterBuy = accounting.calculateLedgerState([firstBuy]).position;
assert.strictEqual(afterBuy.contracts, 108, 'BUY should increase net contracts');
assert.strictEqual(afterBuy.averageEntryPrice, 77424.7);

const secondBuy = record({ executionId: 'second', contracts: 50, avgFillPrice: 78000 });
const weighted = accounting.calculateLedgerState([firstBuy, secondBuy]).position;
const expectedAverage = ((108 * 77424.7) + (50 * 78000)) / 158;
assert.strictEqual(weighted.contracts, 158);
assert.ok(Math.abs(weighted.averageEntryPrice - expectedAverage) < 1e-9, 'same-side fills should use weighted average entry');

const partialSell = record({ executionId: 'partial-sell', side: 'SELL', contracts: 58, avgFillPrice: 79000 });
const afterPartialSell = accounting.calculateLedgerState([firstBuy, secondBuy, partialSell]).position;
assert.strictEqual(afterPartialSell.contracts, 100, 'SELL should reduce net contracts');
assert.strictEqual(afterPartialSell.averageEntryPrice, weighted.averageEntryPrice, 'partial close should preserve remaining entry price');

const fullSell = record({ executionId: 'full-sell', side: 'SELL', contracts: 100, avgFillPrice: 80000 });
const flat = accounting.calculateLedgerState([firstBuy, secondBuy, partialSell, fullSell]).position;
assert.strictEqual(flat.contracts, 0, 'full close should return position to zero');
assert.strictEqual(flat.averageEntryPrice, null, 'full close should clear average entry');

const strategyCloses = Array.from({ length: 420 }, (_, index) => 10000 * (1.002 ** index));
const strategyTargetBefore = computeSignal(strategyCloses).finalTarget;
accounting.calculateLedgerState([firstBuy, secondBuy, partialSell]);
const strategyTargetAfter = computeSignal(strategyCloses).finalTarget;
assert.strictEqual(strategyTargetAfter, strategyTargetBefore, 'execution ledger must not affect Strategy Target');

const flipSell = record({ executionId: 'flip-sell', side: 'SELL', contracts: 120, avgFillPrice: 80000 });
const flipped = accounting.calculateLedgerState([firstBuy, flipSell]).position;
assert.strictEqual(flipped.contracts, -12, 'oversized SELL should flip the position short');
assert.strictEqual(flipped.averageEntryPrice, 80000, 'new short remainder should use the reversal fill price');

const metrics = accounting.calculatePositionMetrics(afterBuy, {
  equityBtc: 0.57,
  contractSizeUsd: 100,
  markPrice: 77424.7,
  targetExposure: 1.25,
});
assert.strictEqual(metrics.actualContracts, 108);
assert.ok(Math.abs(metrics.actualOverlayBtc - ((108 * 100) / 77424.7)) < 1e-12, 'overlay should use face value divided by relevant BTC price');
assert.strictEqual(metrics.targetContracts, 110, 'target contracts should use BTC equity and current price');
assert.ok(metrics.actualExposure > 1 && metrics.actualExposure < 1.25, 'actual exposure should be portfolio exposure, not exchange leverage');
assert.ok(metrics.unrealizedPnl.btc === 0 && metrics.unrealizedPnl.usd === 0, 'PnL at entry price should be zero');

const higherMarkMetrics = accounting.calculatePositionMetrics(afterBuy, {
  equityBtc: 0.57,
  contractSizeUsd: 100,
  markPrice: 80000,
  targetExposure: 1.25,
});
assert.ok(higherMarkMetrics.unrealizedPnl.btc > 0, 'inverse long should show positive BTC PnL when mark rises');

assert.strictEqual(accounting.sameExecutionIntent(firstBuy, { ...firstBuy, recordedAt: '2026-08-24T00:00:00.000Z' }), true, 'recordedAt changes must remain idempotent');
assert.strictEqual(accounting.sameExecutionIntent(firstBuy, { ...firstBuy, avgFillPrice: 78000 }), false, 'same executionId with changed fill must not be idempotent');

const ledgerPath = path.join(__dirname, '..', 'data', 'btc-v3-execution-ledger.jsonl');
const firstPersisted = accounting.parseLedger(fs.readFileSync(ledgerPath, 'utf8'))[0];
assert.strictEqual(firstPersisted.executionId, 'exec_20260823_btcusd_perp_buy_108_77424_7');
assert.strictEqual(firstPersisted.executedAt, null, 'first trade must not invent an execution timestamp');
assert.strictEqual(firstPersisted.executionTimePrecision, 'approximate');
assert.strictEqual(firstPersisted.contracts, 108);
assert.strictEqual(firstPersisted.side, 'BUY');

const forwardLedger = fs.readFileSync(path.join(__dirname, '..', 'data', 'btc-v3-forward-test.jsonl'), 'utf8');
assert.ok(forwardLedger.includes('"recordType":"signal"'), 'Strategy Forward Test ledger remains signal-only');
assert.ok(!forwardLedger.includes('exec_20260823_btcusd_perp_buy_108_77424_7'), 'execution record must not enter Strategy ledger');
const executionFrontend = fs.readFileSync(path.join(__dirname, '..', 'btc-v3-execution.js'), 'utf8');
assert.ok(executionFrontend.includes("fetch('/api/btc-v3-execution'"), 'history must load from the server API');
assert.ok(!executionFrontend.includes('localStorage'), 'execution history must not use browser localStorage');

console.log('btc v3 execution accounting tests passed');
