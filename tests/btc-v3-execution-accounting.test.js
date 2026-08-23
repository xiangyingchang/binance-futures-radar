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
     contracts: 42,
     avgFillPrice: 61234.5,
     executedAt: null,
     recordedAt: '2026-08-23T00:00:00.000Z',
     executionTimePrecision: 'approximate',
     targetExposureAtExecution: 1.25,
     source: 'manual',
     note: 'test',
     ...overrides,
   });
 }

 function flow(overrides = {}) {
   return accounting.normalizeCapitalFlow({
     flowId: 'flow_test',
     flowType: 'CONTRIBUTION',
     asset: 'BTC',
     amount: 0.02,
     direction: 'IN',
     effectiveAt: null,
     recordedAt: '2026-08-23T00:00:00.000Z',
     effectiveTimePrecision: 'approximate',
     source: 'manual',
     reason: 'test',
     ...overrides,
   });
 }

 function snapshot(overrides = {}) {
   return accounting.normalizeAccountSnapshot({
     snapshotId: 'snapshot_test',
     capturedAt: null,
     captureTimePrecision: 'approximate',
     strategyEquityBtc: 0.125,
     actualContracts: 42,
     symbol: 'BTCUSD_PERP',
     markPrice: null,
     recordedAt: '2026-08-23T00:00:00.000Z',
     source: 'manual',
     note: 'test',
     ...overrides,
   });
 }

 // 1. COIN-M harmonic average entry
 {
   const first = record({ executionId: 'h1', contracts: 100, avgFillPrice: 50000 });
   const second = record({ executionId: 'h2', contracts: 100, avgFillPrice: 100000 });
   const state = accounting.calculateLedgerState([first, second]);
   assert.strictEqual(state.position.contracts, 200);
   const expected = 200 / ((100 / 50000) + (100 / 100000));
   assert.ok(Math.abs(state.position.averageEntryPrice - expected) < 1e-9,
     'same-side fills must use harmonic equivalent entry, not arithmetic weighted average');
   assert.ok(Math.abs(state.position.averageEntryPrice - 66666.66666666667) < 1e-6);
 }

 // 2. Harmonic entry PnL equivalence at arbitrary marks
 {
  const historicalLikeSamplePrice = 77000 + 424.7;
  const cases = [[50000, 100000], [70000, 80000], [historicalLikeSamplePrice, 78000]];
   for (const [p1, p2] of cases) {
     const f1 = record({ executionId: 'e1_' + p1, contracts: 100, avgFillPrice: p1, executedAt: '2026-01-01T00:00:00Z' });
     const f2 = record({ executionId: 'e2_' + p2, contracts: 100, avgFillPrice: p2, executedAt: '2026-01-02T00:00:00Z' });
     const combined = accounting.calculateLedgerState([f1, f2]);
     const avg = combined.position.averageEntryPrice;
     for (const mark of [40000, 65000, 90000, 123456.78]) {
       const pnlFill1 = 100 * 100 * (1 / p1 - 1 / mark);
       const pnlFill2 = 100 * 100 * (1 / p2 - 1 / mark);
       const pnlCombined = 200 * 100 * (1 / avg - 1 / mark);
       assert.ok(Math.abs((pnlFill1 + pnlFill2) - pnlCombined) < 1e-10,
         'harmonic entry PnL equivalence failed');
     }
   }
 }

 // 3. Same-side multi fill
 {
   const fills = [
     record({ executionId: 'm1', contracts: 30, avgFillPrice: 60000, executedAt: '2026-01-01T00:00:00Z' }),
     record({ executionId: 'm2', contracts: 20, avgFillPrice: 70000, executedAt: '2026-01-02T00:00:00Z' }),
     record({ executionId: 'm3', contracts: 50, avgFillPrice: 80000, executedAt: '2026-01-03T00:00:00Z' }),
   ];
   const state = accounting.calculateLedgerState(fills);
   assert.strictEqual(state.position.contracts, 100);
   const expected = 100 / ((30 / 60000) + (20 / 70000) + (50 / 80000));
   assert.ok(Math.abs(state.position.averageEntryPrice - expected) < 1e-9);
 }

 // 4. Partial close; 5. full close
 {
   const open = record({ executionId: 'pc1', contracts: 100, avgFillPrice: 60000 });
   const partial = record({ executionId: 'pc2', side: 'SELL', contracts: 40, avgFillPrice: 65000, executedAt: '2026-01-02T00:00:00Z' });
   const afterPartial = accounting.calculateLedgerState([open, partial]);
   assert.strictEqual(afterPartial.position.contracts, 60);
   assert.strictEqual(afterPartial.position.averageEntryPrice, 60000, 'partial close must preserve remaining entry');
   const full = record({ executionId: 'pc3', side: 'SELL', contracts: 60, avgFillPrice: 68000, executedAt: '2026-01-03T00:00:00Z' });
   const afterFull = accounting.calculateLedgerState([open, partial, full]);
   assert.strictEqual(afterFull.position.contracts, 0);
   assert.strictEqual(afterFull.position.averageEntryPrice, null);
 }

 // 6/7. Flip positions
 {
   const longOpen = record({ executionId: 'f1', contracts: 100, avgFillPrice: 60000 });
   const flipSell = record({ executionId: 'f2', side: 'SELL', contracts: 150, avgFillPrice: 70000, executedAt: '2026-01-02T00:00:00Z' });
   const flippedShort = accounting.calculateLedgerState([longOpen, flipSell]);
   assert.strictEqual(flippedShort.position.contracts, -50);
   assert.strictEqual(flippedShort.position.averageEntryPrice, 70000);
   const expectedRealized = 100 * 100 * (1 / 60000 - 1 / 70000);
   assert.ok(Math.abs(flippedShort.realizedPnlBtc - expectedRealized) < 1e-12,
     'flip must realize PnL only for the closed contracts');
   const shortOpen = record({ executionId: 'f3', side: 'SELL', contracts: 100, avgFillPrice: 70000 });
   const flipBuy = record({ executionId: 'f4', side: 'BUY', contracts: 130, avgFillPrice: 65000, executedAt: '2026-02-02T00:00:00Z' });
   const flippedLong = accounting.calculateLedgerState([shortOpen, flipBuy]);
   assert.strictEqual(flippedLong.position.contracts, 30);
   assert.strictEqual(flippedLong.position.averageEntryPrice, 65000);
   const expectedShortRealized = -100 * 100 * (1 / 70000 - 1 / 65000);
   assert.ok(Math.abs(flippedLong.realizedPnlBtc - expectedShortRealized) < 1e-12);
 }

// 8. Realized inverse PnL
{
   const open = record({ executionId: 'r1', contracts: 40, avgFillPrice: 50000 });
   const close = record({ executionId: 'r2', side: 'SELL', contracts: 15, avgFillPrice: 55000, executedAt: '2026-01-02T00:00:00Z' });
   const state = accounting.calculateLedgerState([open, close]);
   const expected = 15 * 100 * (1 / 50000 - 1 / 55000);
   assert.ok(Math.abs(state.realizedPnlBtc - expected) < 1e-12);
 }

 // 9. Late-recorded execution replay
 {
   const today = record({ executionId: 'late-today', contracts: 100, avgFillPrice: 60000, executedAt: '2026-03-10T00:00:00Z', recordedAt: '2026-03-10T12:00:00Z' });
   const yesterdayLate = record({ executionId: 'late-yesterday', contracts: 100, avgFillPrice: 50000, executedAt: '2026-03-09T00:00:00Z', recordedAt: '2026-03-10T13:00:00Z' });
   const state = accounting.calculateLedgerState([today, yesterdayLate]);
   const expected = 200 / ((100 / 50000) + (100 / 60000));
   assert.ok(Math.abs(state.position.averageEntryPrice - expected) < 1e-9,
     'late-recorded execution must replay by economic time');
   assert.strictEqual(state.timeline[0].record.executionId, 'late-yesterday');
   assert.strictEqual(state.timeline[1].record.executionId, 'late-today');
 }

// 10. Late-recorded snapshot
{
  const morning = snapshot({ snapshotId: 's-morning', capturedAt: '2026-03-10T08:00:00Z', strategyEquityBtc: 0.2, actualContracts: 30, recordedAt: '2026-03-10T09:00:00Z' });
  const lateYesterday = snapshot({ snapshotId: 's-yesterday', capturedAt: '2026-03-09T20:00:00Z', strategyEquityBtc: 0.1, actualContracts: 20, recordedAt: '2026-03-10T10:00:00Z' });
  const latest = accounting.latestAccountSnapshot([morning, lateYesterday]);
  assert.strictEqual(latest.snapshotId, 's-morning', 'latest snapshot must order by capturedAt, not recordedAt');
}

// Reversal semantics: append an explicit inverse record; never mutate the original.
{
  const original = record({ executionId: 'reversal-original', contracts: 25, avgFillPrice: 61000, executedAt: '2026-01-01T00:00:00Z' });
  const reversal = record({
    recordType: 'reversal',
    executionId: 'reversal-cancel',
    side: 'SELL',
    contracts: 25,
    avgFillPrice: 61000,
    reversesExecutionId: 'reversal-original',
    executedAt: '2026-01-03T00:00:00Z',
  });
  const state = accounting.calculateLedgerState([original, reversal]);
  assert.strictEqual(state.position.contracts, 0, 'reversal must cancel the referenced execution');
  assert.strictEqual(state.position.averageEntryPrice, null);
  assert.strictEqual(state.timeline[1].record.reversesExecutionId, 'reversal-original');
  assert.throws(() => accounting.calculateLedgerState([record({
    recordType: 'reversal', executionId: 'bad-reversal', side: 'SELL', contracts: 25, avgFillPrice: 61000,
    reversesExecutionId: 'missing', executedAt: '2026-01-03T00:00:00Z',
  })]), /unknown execution/);
  assert.throws(() => accounting.calculateLedgerState([original, { ...reversal, avgFillPrice: 62000 }]), /exact inverse economics/);
}

// 11/12/13. Capital flows after snapshot; DCA not counted as Strategy PnL
{
   const initialFlow = flow({ flowId: 'initial', flowType: 'INITIAL_CAPITAL', amount: 0.125, recordedAt: '2026-01-01T00:00:00Z' });
   const snap = snapshot({ snapshotId: 'snap1', capturedAt: '2026-01-05T00:00:00Z', strategyEquityBtc: 0.125, actualContracts: 42, recordedAt: '2026-01-05T00:00:00Z' });
   const contribution = flow({ flowId: 'dca', flowType: 'CONTRIBUTION', amount: 0.01, effectiveAt: '2026-01-10T00:00:00Z', recordedAt: '2026-01-10T00:00:00Z' });
   const state = accounting.calculateTrackingState({
     executionRecords: [],
     capitalFlowRecords: [initialFlow, contribution],
     accountSnapshotRecords: [snap],
     markPrice: 60000,
     targetExposure: 1.25,
   });
   assert.strictEqual(state.equityStatus, 'ESTIMATED');
   assert.strictEqual(state.lastObservedEquityBtc, 0.125);
   assert.ok(Math.abs(state.capitalAdjustedEquityBtc - 0.135) < 1e-12);
   assert.ok(Math.abs(state.currentStrategyEquityBtc - 0.135) < 1e-12, 'snapshot must not permanently suppress later DCA');
   assert.ok(Math.abs(state.strategyPnlBtc) < 1e-12, 'DCA must not be counted as Strategy PnL');
  const withdrawal = flow({ flowId: 'wd', flowType: 'WITHDRAWAL', amount: 0.005, direction: 'OUT', effectiveAt: '2026-01-11T00:00:00Z', recordedAt: '2026-01-11T00:00:00Z' });
   const stateAfterWithdrawal = accounting.calculateTrackingState({
     executionRecords: [],
    capitalFlowRecords: [initialFlow, contribution, withdrawal],
     accountSnapshotRecords: [snap],
     markPrice: 60000,
     targetExposure: 1.25,
   });
   assert.ok(Math.abs(stateAfterWithdrawal.currentStrategyEquityBtc - 0.13) < 1e-12, 'withdrawal after snapshot must reduce estimated equity');
}

// Snapshot followed by a real execution: current contracts are estimated from the snapshot plus post-snapshot events.
{
  const initial = record({ executionId: 'post-snapshot-open', contracts: 10, avgFillPrice: 60000, executedAt: '2026-01-01T00:00:00Z' });
  const snap = snapshot({ snapshotId: 'post-snapshot-state', capturedAt: '2026-01-02T00:00:00Z', strategyEquityBtc: 0.125, actualContracts: 10, markPrice: 60000, recordedAt: '2026-01-02T00:00:00Z' });
  const later = record({ executionId: 'post-snapshot-add', contracts: 5, avgFillPrice: 65000, executedAt: '2026-01-03T00:00:00Z' });
  const state = accounting.calculateTrackingState({
    executionRecords: [initial, later],
    capitalFlowRecords: [],
    accountSnapshotRecords: [snap],
    markPrice: 65000,
    targetExposure: 1.25,
  });
  assert.strictEqual(state.currentActualContracts, 15);
  assert.strictEqual(state.actualPositionSource, 'account_snapshot_plus_execution_ledger');
  assert.ok(Math.abs(state.averageEntryPrice - (15 / ((10 / 60000) + (5 / 65000)))) < 1e-9);
  assert.strictEqual(state.equityStatus, 'ESTIMATED');
}

 // 14. Stale snapshot marked ESTIMATED; 15. fresh snapshot marked OBSERVED
 {
   const initialFlow = flow({ flowId: 'initial2', flowType: 'INITIAL_CAPITAL', amount: 0.125, recordedAt: '2026-01-01T00:00:00Z' });
   const snapWithMark = snapshot({ snapshotId: 'snap2', capturedAt: '2026-01-05T00:00:00Z', strategyEquityBtc: 0.125, actualContracts: 42, markPrice: 60000, recordedAt: '2026-01-05T00:00:00Z' });
   const stale = accounting.calculateTrackingState({
     executionRecords: [],
     capitalFlowRecords: [initialFlow],
     accountSnapshotRecords: [snapWithMark],
     markPrice: 61000,
     targetExposure: 1.25,
   });
   assert.strictEqual(stale.equityStatus, 'ESTIMATED', 'market movement after snapshot must mark equity ESTIMATED');
   const fresh = accounting.calculateTrackingState({
     executionRecords: [],
     capitalFlowRecords: [initialFlow],
     accountSnapshotRecords: [snapWithMark],
     markPrice: 60000,
     targetExposure: 1.25,
   });
   assert.strictEqual(fresh.equityStatus, 'OBSERVED', 'no post-snapshot events must mark equity OBSERVED');
 }

 // Record type semantics: only execution and reversal
 assert.throws(() => record({ recordType: 'correction' }), /unsupported recordType/);
 assert.throws(() => record({ recordType: 'adjustment' }), /unsupported recordType/);

 // 22. Public source contains no real initial balance/contracts/fill price
 {
  const files = ['btc-v3.js', 'btc-v3.html', 'btc-v3-execution.js', 'docs/btc-v3-execution-ledger.md', 'docs/btc-v3-account-tracking.md', '.env.example'];
  const prohibitedBtcAmount = String(5657 / 10000);
  const prohibitedFillPrice = String(77000 + 424.7);
  const prohibitedContractInput = 'value="' + 108 + '"';
  const prohibitedDefaultName = 'DEFAULT_CURRENT_' + 'CONTRACTS';
  for (const file of files) {
    const content = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(!content.includes(prohibitedBtcAmount), file + ' must not contain the real BTC amount');
    assert.ok(!content.includes(prohibitedFillPrice), file + ' must not contain the real fill price');
    assert.ok(!content.includes(prohibitedContractInput) && !content.includes(prohibitedDefaultName), file + ' must not hardcode the real contract count');
   }
   assert.ok(!fs.existsSync(path.join(__dirname, '..', 'data', 'btc-v3-execution-ledger.jsonl')), 'public repo must not contain the execution ledger');
   assert.ok(!fs.existsSync(path.join(__dirname, '..', 'data', 'btc-v3-capital-flow.jsonl')), 'public repo must not contain the capital flow ledger');
   assert.ok(!fs.existsSync(path.join(__dirname, '..', 'data', 'btc-v3-account-snapshots.jsonl')), 'public repo must not contain the account snapshot ledger');
 }

 // 23. Strategy Forward Test unchanged; 24. V3 Signal unchanged
 {
   const forwardPath = path.join(__dirname, '..', 'data', 'btc-v3-forward-test.jsonl');
   const forwardLedger = fs.readFileSync(forwardPath, 'utf8');
   assert.ok(forwardLedger.includes('"recordType":"signal"'), 'Strategy Forward Test ledger remains signal-only');
   const candles = Array.from({ length: 420 }, (_, index) => 10000 * (1.002 ** index));
   const before = computeSignal(candles).finalTarget;
   accounting.calculateLedgerState([record({ contracts: 42 }), record({ side: 'SELL', contracts: 10, executedAt: '2026-01-02T00:00:00Z' })]);
   const after = computeSignal(candles).finalTarget;
   assert.strictEqual(after, before, 'execution/capital/snapshot must never change V3 signal');
 }

 // 25. Private ledgers append-only helpers
 {
   const first = record({ executionId: 'append-1' });
   const appended = accounting.appendLedgerRecord('', first);
   assert.strictEqual(appended.endsWith('\n'), true);
   assert.strictEqual(accounting.parseLedger(appended).length, 1);
   const second = record({ executionId: 'append-2', executedAt: '2026-01-02T00:00:00Z' });
   const appendedTwice = accounting.appendLedgerRecord(appended, second);
   assert.strictEqual(appendedTwice.startsWith(appended), true, 'append must never rewrite existing lines');
   assert.strictEqual(accounting.parseLedger(appendedTwice).length, 2);
 }

// Economic time helpers and idempotency intent
{
   assert.strictEqual(accounting.completionPercent(109, 108), 99.08256880733945);
   assert.strictEqual(accounting.completionPercent(0, 42), null, 'zero target with non-zero actual must not show a meaningful percentage');
   assert.strictEqual(accounting.completionPercent(-100, -200), null, 'overshoot must not show a misleading percentage');
  const exec = record({ executionId: 'et1', executedAt: '2026-01-02T00:00:00Z', recordedAt: '2026-01-03T00:00:00Z' });
   assert.strictEqual(accounting.executionEconomicTime(exec), '2026-01-02T00:00:00.000Z');
   const capFlow = flow({ flowId: 'et2', effectiveAt: '2026-01-02T00:00:00Z', recordedAt: '2026-01-03T00:00:00Z' });
   assert.strictEqual(accounting.capitalFlowEconomicTime(capFlow), '2026-01-02T00:00:00.000Z');
   const snap = snapshot({ snapshotId: 'et3', capturedAt: '2026-01-02T00:00:00Z', recordedAt: '2026-01-03T00:00:00Z' });
   assert.strictEqual(accounting.accountSnapshotEconomicTime(snap), '2026-01-02T00:00:00.000Z');
   assert.strictEqual(accounting.sameExecutionIntent(exec, { ...exec, recordedAt: '2026-01-04T00:00:00Z' }), true);
   assert.strictEqual(accounting.sameExecutionIntent(exec, { ...exec, avgFillPrice: 65000 }), false);
 }

 console.log('btc v3 execution accounting tests passed');
