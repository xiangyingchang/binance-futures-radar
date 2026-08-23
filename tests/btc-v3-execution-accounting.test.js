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

const realizedOpen = record({ executionId: 'realized-open', contracts: 40, avgFillPrice: 50000 });
const realizedClose = record({ executionId: 'realized-close', side: 'SELL', contracts: 15, avgFillPrice: 55000 });
const realizedState = accounting.calculateLedgerState([realizedOpen, realizedClose]);
assert.strictEqual(realizedState.position.contracts, 25, 'partial close should leave the expected contracts');
assert.strictEqual(realizedState.position.averageEntryPrice, 50000, 'partial close should preserve the remaining cost basis');
assert.ok(realizedState.realizedPnlBtc > 0, 'inverse long partial close should realize positive BTC PnL');

const initialFlowPath = path.join(__dirname, '..', 'data', 'btc-v3-capital-flow.jsonl');
const snapshotPath = path.join(__dirname, '..', 'data', 'btc-v3-account-snapshots.jsonl');
const initialFlow = accounting.parseCapitalFlowLedger(fs.readFileSync(initialFlowPath, 'utf8'))[0];
const initialSnapshot = accounting.parseAccountSnapshotLedger(fs.readFileSync(snapshotPath, 'utf8'))[0];
assert.strictEqual(initialFlow.flowType, 'INITIAL_CAPITAL');
assert.strictEqual(initialFlow.amount, 0.5657);
assert.strictEqual(initialFlow.direction, 'IN');
assert.strictEqual(initialFlow.effectiveAt, null, 'initial capital must not invent an effective timestamp');
assert.strictEqual(initialFlow.effectiveTimePrecision, 'approximate');
assert.strictEqual(initialSnapshot.strategyEquityBtc, 0.5657);
assert.strictEqual(initialSnapshot.actualContracts, 108);
assert.strictEqual(initialSnapshot.symbol, 'BTCUSD_PERP');
assert.strictEqual(initialSnapshot.markPrice, null, 'initial manual snapshot must not treat the fill price as a current mark');

const contribution = accounting.normalizeCapitalFlow({
  flowId: 'contribution',
  flowType: 'CONTRIBUTION',
  asset: 'BTC',
  amount: 0.01,
  direction: 'IN',
  effectiveAt: null,
  recordedAt: '2026-09-01T00:00:00.000Z',
  effectiveTimePrecision: 'approximate',
  source: 'manual',
  reason: 'DCA',
});
const withdrawal = accounting.normalizeCapitalFlow({
  flowId: 'withdrawal',
  flowType: 'WITHDRAWAL',
  asset: 'BTC',
  amount: 0.01,
  direction: 'OUT',
  effectiveAt: null,
  recordedAt: '2026-09-02T00:00:00.000Z',
  effectiveTimePrecision: 'approximate',
  source: 'manual',
  reason: 'Strategy withdrawal',
});
const capitalState = accounting.calculateCapitalFlowState([initialFlow, contribution, withdrawal]);
assert.strictEqual(capitalState.startingCapitalBtc, 0.5657);
assert.strictEqual(capitalState.additionalContributionsBtc, 0.01);
assert.strictEqual(capitalState.withdrawalsBtc, 0.01);
assert.strictEqual(capitalState.netCapitalBtc, 0.5657, 'withdrawal should reduce net capital');
const contributionOnlyState = accounting.calculateCapitalFlowState([initialFlow, contribution]);
assert.strictEqual(accounting.calculateCapitalAttribution(contributionOnlyState, 0.5757).strategyPnlBtc, 0, 'contribution must not be counted as Strategy PnL');
assert.throws(() => accounting.normalizeCapitalFlow({
  flowId: 'funding-is-not-capital',
  flowType: 'FUNDING',
  asset: 'BTC',
  amount: 0.001,
  direction: 'IN',
  recordedAt: '2026-09-03T00:00:00.000Z',
  reason: 'Funding',
}), /unsupported flowType/, 'Funding must not be recorded as a Capital Flow');
assert.throws(() => accounting.normalizeCapitalFlow({
  flowId: 'fee-is-not-capital',
  flowType: 'FEE',
  asset: 'BTC',
  amount: 0.001,
  direction: 'OUT',
  recordedAt: '2026-09-03T00:00:00.000Z',
  reason: 'Fee',
}), /unsupported flowType/, 'Fees must not be recorded as a Capital Flow');

const tracking = accounting.calculateTrackingState({
  executionRecords: [firstBuy],
  capitalFlowRecords: [initialFlow],
  accountSnapshotRecords: [initialSnapshot],
  markPrice: 77424.7,
  targetExposure: 1.25,
});
assert.strictEqual(tracking.currentStrategyEquityBtc, 0.5657, 'Strategy Equity must be isolated from total user BTC');
assert.strictEqual(tracking.currentActualContracts, 108);
assert.strictEqual(tracking.reconciliation.status, 'MATCH', 'initial snapshot should reconcile to the first execution');
assert.strictEqual(tracking.reconciliation.positionDifferenceContracts, 0);
assert.strictEqual(tracking.reconciliation.equityDifferenceBtc, 0);
assert.strictEqual(tracking.targetContracts, 109, 'target contracts should round using the current Strategy Equity');
assert.strictEqual(tracking.remainingContracts, 1);
assert.ok(Math.abs(tracking.actualExposure - (1 + ((108 * 100) / 77424.7) / 0.5657)) < 1e-12, 'Actual Exposure must use Strategy Equity and COIN-M delta');
assert.strictEqual(tracking.actualPositionSource, 'account_snapshot');
assert.strictEqual(tracking.equitySource, 'account_snapshot');

const mismatchedSnapshot = accounting.normalizeAccountSnapshot({
  snapshotId: 'snapshot-mismatch',
  capturedAt: null,
  captureTimePrecision: 'approximate',
  strategyEquityBtc: 0.6,
  actualContracts: 109,
  symbol: 'BTCUSD_PERP',
  markPrice: 77424.7,
  recordedAt: '2026-09-04T00:00:00.000Z',
  source: 'manual',
  note: 'reconcile test',
});
const mismatchTracking = accounting.calculateTrackingState({
  executionRecords: [firstBuy],
  capitalFlowRecords: [initialFlow],
  accountSnapshotRecords: [initialSnapshot, mismatchedSnapshot],
  markPrice: 77424.7,
  targetExposure: 1.25,
});
assert.strictEqual(mismatchTracking.reconciliation.status, 'MISMATCH', 'snapshot contract differences must be visible');
assert.strictEqual(mismatchTracking.reconciliation.positionDifferenceContracts, 1);
assert.strictEqual(mismatchTracking.reconciliation.equityDifferenceBtc, 0.0343);
const appendedSnapshots = accounting.appendAccountSnapshotRecord(fs.readFileSync(snapshotPath, 'utf8'), mismatchedSnapshot);
assert.strictEqual(accounting.parseAccountSnapshotLedger(appendedSnapshots).length, 2, 'snapshot corrections must append rather than overwrite');
const appendedFlows = accounting.appendCapitalFlowRecord(fs.readFileSync(initialFlowPath, 'utf8'), contribution);
assert.strictEqual(accounting.parseCapitalFlowLedger(appendedFlows).length, 2, 'capital flow changes must append rather than overwrite');

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
