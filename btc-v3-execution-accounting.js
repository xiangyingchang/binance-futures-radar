(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BtcV3ExecutionAccounting = factory();
}(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';

  const DEFAULT_STRATEGY_VERSION = 'btc-v3.1-coinm';
  const DEFAULT_SYMBOL = 'BTCUSD_PERP';
  const ALLOWED_RECORD_TYPES = new Set(['execution', 'adjustment', 'correction', 'reversal']);
  const ALLOWED_SIDES = new Set(['BUY', 'SELL']);
  const ALLOWED_TIME_PRECISIONS = new Set(['approximate', 'exact', 'user-provided']);
  const DEFAULT_CONTRACT_SIZE_USD = 100;
  const ALLOWED_FLOW_TYPES = new Set(['INITIAL_CAPITAL', 'CONTRIBUTION', 'WITHDRAWAL', 'ADJUSTMENT']);
  const ALLOWED_FLOW_DIRECTIONS = new Set(['IN', 'OUT']);
  const ALLOWED_FLOW_TIME_PRECISIONS = new Set(['approximate', 'exact', 'user-provided']);

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function isoOrNull(value, fieldName) {
    if (value === null || value === undefined || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`${fieldName} must be a valid ISO timestamp`);
    return date.toISOString();
  }

  function normalizeRecord(input = {}) {
    const record = {
      recordType: String(input.recordType || 'execution').trim().toLowerCase(),
      executionId: String(input.executionId || '').trim(),
      strategyVersion: String(input.strategyVersion || DEFAULT_STRATEGY_VERSION).trim(),
      symbol: String(input.symbol || DEFAULT_SYMBOL).trim(),
      side: String(input.side || '').trim().toUpperCase(),
      contracts: finite(input.contracts),
      avgFillPrice: finite(input.avgFillPrice),
      executedAt: isoOrNull(input.executedAt, 'executedAt'),
      recordedAt: isoOrNull(input.recordedAt, 'recordedAt'),
      executionTimePrecision: String(input.executionTimePrecision || 'approximate').trim().toLowerCase(),
      targetExposureAtExecution: finite(input.targetExposureAtExecution),
      source: String(input.source || 'manual').trim(),
      note: String(input.note || '').trim(),
    };

    if (!ALLOWED_RECORD_TYPES.has(record.recordType)) throw new Error(`unsupported recordType: ${record.recordType}`);
    if (!record.executionId || record.executionId.length > 128) throw new Error('executionId is required and must be at most 128 characters');
    if (!record.strategyVersion) throw new Error('strategyVersion is required');
    if (!record.symbol) throw new Error('symbol is required');
    if (!ALLOWED_SIDES.has(record.side)) throw new Error('side must be BUY or SELL');
    if (!Number.isInteger(record.contracts) || record.contracts <= 0 || record.contracts > 1_000_000) {
      throw new Error('contracts must be a positive integer no greater than 1000000');
    }
    if (record.avgFillPrice === null || record.avgFillPrice <= 0) throw new Error('avgFillPrice must be positive');
    if (!ALLOWED_TIME_PRECISIONS.has(record.executionTimePrecision)) throw new Error('unsupported executionTimePrecision');
    if (record.executedAt === null && record.executionTimePrecision !== 'approximate') {
      throw new Error('missing executedAt must use executionTimePrecision=approximate');
    }
    if (record.targetExposureAtExecution === null || record.targetExposureAtExecution < 0 || record.targetExposureAtExecution > 2) {
      throw new Error('targetExposureAtExecution must be between 0 and 2');
    }
    if (!record.source || record.source.length > 32) throw new Error('source is required and must be at most 32 characters');
    if (record.note.length > 500) throw new Error('note must be at most 500 characters');
    if (record.recordedAt === null) throw new Error('recordedAt is required for a persisted record');
    return record;
  }

  function parseLedger(text = '') {
    return String(text)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        let raw;
        try { raw = JSON.parse(line); } catch (error) {
          throw new Error(`invalid execution ledger JSON on line ${index + 1}`);
        }
        try { return normalizeRecord(raw); } catch (error) {
          throw new Error(`invalid execution ledger record on line ${index + 1}: ${error.message}`);
        }
      });
  }

  function serializeLedger(records) {
    return records.map((record) => `${JSON.stringify(normalizeRecord(record))}\n`).join('');
  }

  function appendLedgerRecord(text, record) {
    const base = String(text || '');
    const prefix = base && !base.endsWith('\n') ? `${base}\n` : base;
    return `${prefix}${JSON.stringify(normalizeRecord(record))}\n`;
  }

  function intentFields(record) {
    const normalized = normalizeRecord(record);
    return [
      normalized.recordType,
      normalized.executionId,
      normalized.strategyVersion,
      normalized.symbol,
      normalized.side,
      normalized.contracts,
      normalized.avgFillPrice,
      normalized.executedAt,
      normalized.executionTimePrecision,
      normalized.targetExposureAtExecution,
      normalized.source,
      normalized.note,
    ];
  }

  function sameExecutionIntent(left, right) {
    try { return JSON.stringify(intentFields(left)) === JSON.stringify(intentFields(right)); } catch (_) { return false; }
  }

  function findExecutionById(records, executionId) {
    return records.find((record) => record.executionId === executionId) || null;
  }

  function signedContracts(record) {
    return record.side === 'BUY' ? record.contracts : -record.contracts;
  }

  function applyRecord(previous = { contracts: 0, averageEntryPrice: null }, record) {
    const delta = signedContracts(record);
    const beforeContracts = Number(previous.contracts) || 0;
    const afterContracts = beforeContracts + delta;
    const beforeAbs = Math.abs(beforeContracts);
    const deltaAbs = Math.abs(delta);
    let averageEntryPrice = previous.averageEntryPrice;

    if (afterContracts === 0) averageEntryPrice = null;
    else if (beforeContracts === 0 || !Number.isFinite(Number(averageEntryPrice))) averageEntryPrice = record.avgFillPrice;
    else if (Math.sign(beforeContracts) === Math.sign(delta)) {
      averageEntryPrice = ((beforeAbs * Number(averageEntryPrice)) + (deltaAbs * record.avgFillPrice)) / Math.abs(afterContracts);
    } else if (deltaAbs > beforeAbs) {
      averageEntryPrice = record.avgFillPrice;
    }

    return {
      contracts: afterContracts,
      averageEntryPrice: afterContracts === 0 ? null : averageEntryPrice,
    };
  }

  function realizedPnlForRecord(previous = { contracts: 0, averageEntryPrice: null }, record, contractSizeUsd = DEFAULT_CONTRACT_SIZE_USD) {
    const beforeContracts = Number(previous.contracts) || 0;
    const delta = signedContracts(record);
    if (beforeContracts === 0 || delta === 0 || Math.sign(beforeContracts) === Math.sign(delta)) return 0;
    const entry = finite(previous.averageEntryPrice);
    const contractSize = finite(contractSizeUsd);
    if (entry === null || contractSize === null || contractSize <= 0) return null;
    const closedContracts = Math.min(Math.abs(beforeContracts), Math.abs(delta));
    const signedClosedContracts = Math.sign(beforeContracts) * closedContracts;
    return signedClosedContracts * contractSize * ((1 / entry) - (1 / record.avgFillPrice));
  }

  function calculateLedgerState(records = [], { contractSizeUsd = DEFAULT_CONTRACT_SIZE_USD } = {}) {
    let position = { contracts: 0, averageEntryPrice: null };
    let realizedPnlBtc = 0;
    const timeline = [];
    for (const record of records) {
      const realized = realizedPnlForRecord(position, record, contractSizeUsd);
      position = applyRecord(position, record);
      if (realized !== null) realizedPnlBtc += realized;
      timeline.push({ record, ...position, realizedPnlBtc });
    }
    return { position, timeline, realizedPnlBtc };
  }

  function calculateUnrealizedPnl(position, markPrice, contractSizeUsd = 100) {
    const contracts = Number(position?.contracts) || 0;
    const entry = finite(position?.averageEntryPrice);
    const mark = finite(markPrice);
    const contractSize = finite(contractSizeUsd);
    if (contracts === 0) return { btc: 0, usd: 0 };
    if (entry === null || mark === null || mark <= 0 || contractSize === null || contractSize <= 0) return { btc: null, usd: null };
    const btc = contracts * contractSize * ((1 / entry) - (1 / mark));
    return { btc, usd: btc * mark };
  }

  function completionPercent(targetContracts, actualContracts) {
    if (targetContracts === null || actualContracts === null) return null;
    if (targetContracts === actualContracts) return 100;
    if (targetContracts === 0) return 0;
    const remaining = Math.abs(targetContracts - actualContracts);
    return Math.max(0, Math.min(100, (1 - (remaining / Math.max(1, Math.abs(targetContracts)))) * 100));
  }

  function calculatePositionMetrics(position, {
    equityBtc,
    contractSizeUsd = 100,
    markPrice,
    targetExposure,
  } = {}) {
    const equity = finite(equityBtc);
    const mark = finite(markPrice);
    const contractSize = finite(contractSizeUsd);
    const actualContracts = Number(position?.contracts) || 0;
    const actualOverlayBtc = mark !== null && mark > 0 && contractSize !== null
      ? (actualContracts * contractSize) / mark
      : null;
    const actualExposure = equity !== null && equity > 0 && actualOverlayBtc !== null
      ? (equity + actualOverlayBtc) / equity
      : null;
    const target = finite(targetExposure);
    const targetContracts = target !== null && equity !== null && equity > 0 && mark !== null && mark > 0 && contractSize !== null && contractSize > 0
      ? Math.round(((target - 1) * equity * mark) / contractSize)
      : null;
    const remainingContracts = targetContracts === null ? null : targetContracts - actualContracts;
    return {
      actualContracts,
      actualOverlayBtc,
      actualExposure,
      targetContracts,
      remainingContracts,
      completionPercent: completionPercent(targetContracts, actualContracts),
      averageEntryPrice: finite(position?.averageEntryPrice),
      unrealizedPnl: calculateUnrealizedPnl(position, markPrice, contractSizeUsd),
      trackingError: actualExposure !== null && target !== null ? actualExposure - target : null,
    };
  }

  function buildExecutionHistory(records, { equityBtc, contractSizeUsd = 100 } = {}) {
    const { timeline } = calculateLedgerState(records, { contractSizeUsd });
    return timeline.map((entry) => {
      const metrics = calculatePositionMetrics(entry, {
        equityBtc,
        contractSizeUsd,
        markPrice: entry.record.avgFillPrice,
        targetExposure: entry.record.targetExposureAtExecution,
      });
      return {
        ...entry.record,
        actualContracts: metrics.actualContracts,
        actualOverlayBtc: metrics.actualOverlayBtc,
        actualExposure: metrics.actualExposure,
        realizedPnlBtc: entry.realizedPnlBtc,
      };
    });
  }

  function normalizeCapitalFlow(input = {}) {
    const record = {
      recordType: String(input.recordType || 'capital_flow').trim().toLowerCase(),
      flowId: String(input.flowId || '').trim(),
      flowType: String(input.flowType || '').trim().toUpperCase(),
      asset: String(input.asset || 'BTC').trim().toUpperCase(),
      amount: finite(input.amount),
      direction: String(input.direction || '').trim().toUpperCase(),
      effectiveAt: isoOrNull(input.effectiveAt, 'effectiveAt'),
      recordedAt: isoOrNull(input.recordedAt, 'recordedAt'),
      effectiveTimePrecision: String(input.effectiveTimePrecision || 'approximate').trim().toLowerCase(),
      source: String(input.source || 'manual').trim(),
      reason: String(input.reason || '').trim(),
      note: String(input.note || '').trim(),
    };

    if (record.recordType !== 'capital_flow') throw new Error('recordType must be capital_flow');
    if (!record.flowId || record.flowId.length > 128) throw new Error('flowId is required and must be at most 128 characters');
    if (!ALLOWED_FLOW_TYPES.has(record.flowType)) throw new Error(`unsupported flowType: ${record.flowType}`);
    if (record.asset !== 'BTC') throw new Error('asset must be BTC for V3 Strategy Equity');
    if (record.amount === null || record.amount <= 0 || record.amount > 1_000_000) throw new Error('amount must be positive and no greater than 1000000 BTC');
    if (!ALLOWED_FLOW_DIRECTIONS.has(record.direction)) throw new Error('direction must be IN or OUT');
    if ((record.flowType === 'INITIAL_CAPITAL' || record.flowType === 'CONTRIBUTION') && record.direction !== 'IN') {
      throw new Error(`${record.flowType} must use direction IN`);
    }
    if (record.flowType === 'WITHDRAWAL' && record.direction !== 'OUT') throw new Error('WITHDRAWAL must use direction OUT');
    if (!ALLOWED_FLOW_TIME_PRECISIONS.has(record.effectiveTimePrecision)) throw new Error('unsupported effectiveTimePrecision');
    if (record.effectiveAt === null && record.effectiveTimePrecision !== 'approximate') {
      throw new Error('missing effectiveAt must use effectiveTimePrecision=approximate');
    }
    if (!record.source || record.source.length > 32) throw new Error('source is required and must be at most 32 characters');
    if (!record.reason || record.reason.length > 160) throw new Error('reason is required and must be at most 160 characters');
    if (record.note.length > 500) throw new Error('note must be at most 500 characters');
    if (record.recordedAt === null) throw new Error('recordedAt is required for a persisted record');
    return record;
  }

  function parseCapitalFlowLedger(text = '') {
    return String(text)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        let raw;
        try { raw = JSON.parse(line); } catch (_) { throw new Error(`invalid capital flow JSON on line ${index + 1}`); }
        try { return normalizeCapitalFlow(raw); } catch (error) {
          throw new Error(`invalid capital flow record on line ${index + 1}: ${error.message}`);
        }
      });
  }

  function serializeCapitalFlowLedger(records) {
    return records.map((record) => `${JSON.stringify(normalizeCapitalFlow(record))}\n`).join('');
  }

  function appendCapitalFlowRecord(text, record) {
    const base = String(text || '');
    const prefix = base && !base.endsWith('\n') ? `${base}\n` : base;
    return `${prefix}${JSON.stringify(normalizeCapitalFlow(record))}\n`;
  }

  function capitalFlowIntentFields(record) {
    const normalized = normalizeCapitalFlow(record);
    return [
      normalized.recordType,
      normalized.flowId,
      normalized.flowType,
      normalized.asset,
      normalized.amount,
      normalized.direction,
      normalized.effectiveAt,
      normalized.effectiveTimePrecision,
      normalized.source,
      normalized.reason,
      normalized.note,
    ];
  }

  function sameCapitalFlowIntent(left, right) {
    try { return JSON.stringify(capitalFlowIntentFields(left)) === JSON.stringify(capitalFlowIntentFields(right)); } catch (_) { return false; }
  }

  function findCapitalFlowById(records, flowId) {
    return records.find((record) => record.flowId === flowId) || null;
  }

  function signedCapitalFlow(record) {
    return record.direction === 'IN' ? record.amount : -record.amount;
  }

  function calculateCapitalFlowState(records = []) {
    let cumulativeNetCapitalBtc = 0;
    let startingCapitalBtc = 0;
    let additionalContributionsBtc = 0;
    let withdrawalsBtc = 0;
    let adjustmentsBtc = 0;
    let totalInBtc = 0;
    let totalOutBtc = 0;
    const timeline = [];

    for (const record of records) {
      const signed = signedCapitalFlow(record);
      cumulativeNetCapitalBtc += signed;
      if (record.direction === 'IN') totalInBtc += record.amount;
      else totalOutBtc += record.amount;
      if (record.flowType === 'INITIAL_CAPITAL') startingCapitalBtc += signed;
      if (record.flowType === 'CONTRIBUTION') additionalContributionsBtc += signed;
      if (record.flowType === 'WITHDRAWAL') withdrawalsBtc += record.amount;
      if (record.flowType === 'ADJUSTMENT') adjustmentsBtc += signed;
      timeline.push({ ...record, signedAmountBtc: signed, cumulativeNetCapitalBtc });
    }

    return {
      startingCapitalBtc,
      additionalContributionsBtc,
      withdrawalsBtc,
      adjustmentsBtc,
      totalInBtc,
      totalOutBtc,
      netCapitalBtc: cumulativeNetCapitalBtc,
      timeline,
    };
  }

  function normalizeAccountSnapshot(input = {}) {
    const record = {
      recordType: String(input.recordType || 'account_snapshot').trim().toLowerCase(),
      snapshotId: String(input.snapshotId || '').trim(),
      capturedAt: isoOrNull(input.capturedAt, 'capturedAt'),
      captureTimePrecision: String(input.captureTimePrecision || 'approximate').trim().toLowerCase(),
      strategyEquityBtc: finite(input.strategyEquityBtc),
      actualContracts: finite(input.actualContracts),
      symbol: String(input.symbol || DEFAULT_SYMBOL).trim(),
      markPrice: finite(input.markPrice),
      recordedAt: isoOrNull(input.recordedAt, 'recordedAt'),
      source: String(input.source || 'manual').trim(),
      note: String(input.note || '').trim(),
    };

    if (record.recordType !== 'account_snapshot') throw new Error('recordType must be account_snapshot');
    if (!record.snapshotId || record.snapshotId.length > 128) throw new Error('snapshotId is required and must be at most 128 characters');
    if (record.capturedAt === null && record.captureTimePrecision !== 'approximate') {
      throw new Error('missing capturedAt must use captureTimePrecision=approximate');
    }
    if (record.strategyEquityBtc === null || record.strategyEquityBtc < 0 || record.strategyEquityBtc > 1_000_000) {
      throw new Error('strategyEquityBtc must be between 0 and 1000000');
    }
    if (!Number.isInteger(record.actualContracts) || record.actualContracts < -1_000_000 || record.actualContracts > 1_000_000) {
      throw new Error('actualContracts must be an integer between -1000000 and 1000000');
    }
    if (!record.symbol) throw new Error('symbol is required');
    if (record.markPrice !== null && record.markPrice <= 0) throw new Error('markPrice must be positive when provided');
    if (!record.source || record.source.length > 32) throw new Error('source is required and must be at most 32 characters');
    if (record.note.length > 500) throw new Error('note must be at most 500 characters');
    if (record.recordedAt === null) throw new Error('recordedAt is required for a persisted record');
    return record;
  }

  function parseAccountSnapshotLedger(text = '') {
    return String(text)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        let raw;
        try { raw = JSON.parse(line); } catch (_) { throw new Error(`invalid account snapshot JSON on line ${index + 1}`); }
        try { return normalizeAccountSnapshot(raw); } catch (error) {
          throw new Error(`invalid account snapshot record on line ${index + 1}: ${error.message}`);
        }
      });
  }

  function serializeAccountSnapshotLedger(records) {
    return records.map((record) => `${JSON.stringify(normalizeAccountSnapshot(record))}\n`).join('');
  }

  function appendAccountSnapshotRecord(text, record) {
    const base = String(text || '');
    const prefix = base && !base.endsWith('\n') ? `${base}\n` : base;
    return `${prefix}${JSON.stringify(normalizeAccountSnapshot(record))}\n`;
  }

  function accountSnapshotIntentFields(record) {
    const normalized = normalizeAccountSnapshot(record);
    return [
      normalized.recordType,
      normalized.snapshotId,
      normalized.capturedAt,
      normalized.captureTimePrecision,
      normalized.strategyEquityBtc,
      normalized.actualContracts,
      normalized.symbol,
      normalized.markPrice,
      normalized.source,
      normalized.note,
    ];
  }

  function sameAccountSnapshotIntent(left, right) {
    try { return JSON.stringify(accountSnapshotIntentFields(left)) === JSON.stringify(accountSnapshotIntentFields(right)); } catch (_) { return false; }
  }

  function findAccountSnapshotById(records, snapshotId) {
    return records.find((record) => record.snapshotId === snapshotId) || null;
  }

  function latestAccountSnapshot(records = []) {
    return records.reduce((latest, record) => {
      if (!latest) return record;
      const latestTime = new Date(latest.recordedAt).getTime();
      const recordTime = new Date(record.recordedAt).getTime();
      return recordTime >= latestTime ? record : latest;
    }, null);
  }

  function calculateCapitalAttribution(capitalState, currentEquityBtc) {
    const equity = finite(currentEquityBtc);
    return {
      ...capitalState,
      strategyPnlBtc: equity === null ? null : equity - capitalState.netCapitalBtc,
    };
  }

  function calculateReconciliation(executionState, snapshot, capitalState) {
    if (!snapshot) {
      return {
        status: 'NO_SNAPSHOT',
        positionDifferenceContracts: null,
        equityDifferenceBtc: null,
        message: '尚无 Account Snapshot；当前 Actual Position 暂以 Execution Ledger 推导，Strategy Equity 暂以 Capital Flow basis 估算。',
      };
    }
    const positionDifferenceContracts = snapshot.actualContracts - executionState.position.contracts;
    const equityDifferenceBtc = capitalState && Number.isFinite(capitalState.netCapitalBtc)
      ? snapshot.strategyEquityBtc - capitalState.netCapitalBtc
      : null;
    const hasEquityDelta = equityDifferenceBtc !== null && Math.abs(equityDifferenceBtc) > 1e-10;
    const hasPositionMismatch = positionDifferenceContracts !== 0;
    const status = hasPositionMismatch ? 'MISMATCH' : hasEquityDelta ? 'EQUITY_DELTA' : 'MATCH';
    let message;
    if (hasPositionMismatch) {
      message = `Account Snapshot 与 Execution Ledger 相差 ${positionDifferenceContracts > 0 ? '+' : ''}${positionDifferenceContracts} 张；以 Snapshot 作为当前账户状态。`;
    } else if (hasEquityDelta) {
      message = `合约数量一致，但 Snapshot Equity 与 Capital Flow basis 相差 ${equityDifferenceBtc > 0 ? '+' : ''}${equityDifferenceBtc.toFixed(8)} BTC；这通常包含策略 PnL、Funding 或手续费。`;
    } else {
      message = 'Account Snapshot 与 Execution Ledger 合约数量一致，且 Equity 与 Capital Flow basis 暂无差异。';
    }
    return {
      status,
      positionDifferenceContracts,
      equityDifferenceBtc,
      message,
    };
  }

  function calculateTrackingState({
    executionRecords = [],
    capitalFlowRecords = [],
    accountSnapshotRecords = [],
    markPrice,
    targetExposure,
    contractSizeUsd = DEFAULT_CONTRACT_SIZE_USD,
  } = {}) {
    const executionState = calculateLedgerState(executionRecords, { contractSizeUsd });
    const capitalState = calculateCapitalFlowState(capitalFlowRecords);
    const latestSnapshot = latestAccountSnapshot(accountSnapshotRecords);
    const currentStrategyEquityBtc = latestSnapshot
      ? latestSnapshot.strategyEquityBtc
      : capitalState.netCapitalBtc;
    const currentActualContracts = latestSnapshot
      ? latestSnapshot.actualContracts
      : executionState.position.contracts;
    const liveMarkPrice = finite(markPrice) !== null ? finite(markPrice) : finite(latestSnapshot?.markPrice);
    const accountingPosition = {
      contracts: currentActualContracts,
      averageEntryPrice: latestSnapshot && currentActualContracts !== executionState.position.contracts
        ? null
        : executionState.position.averageEntryPrice,
    };
    const metrics = calculatePositionMetrics(accountingPosition, {
      equityBtc: currentStrategyEquityBtc,
      contractSizeUsd,
      markPrice: liveMarkPrice,
      targetExposure,
    });
    const capitalAttribution = calculateCapitalAttribution(capitalState, currentStrategyEquityBtc);
    const reconciliation = calculateReconciliation(executionState, latestSnapshot, capitalState);
    const unrealizedPnl = calculateUnrealizedPnl(executionState.position, liveMarkPrice, contractSizeUsd);
    const estimatedExecutionPnlBtc = executionState.realizedPnlBtc !== null && unrealizedPnl.btc !== null
      ? executionState.realizedPnlBtc + unrealizedPnl.btc
      : null;

    return {
      ...metrics,
      ...capitalAttribution,
      executionState,
      latestSnapshot,
      currentStrategyEquityBtc,
      currentActualContracts,
      actualPositionSource: latestSnapshot ? 'account_snapshot' : 'execution_ledger',
      currentMarkPrice: liveMarkPrice,
      equitySource: latestSnapshot ? 'account_snapshot' : 'capital_flow_basis',
      reconciliation,
      unrealizedPnl,
      estimatedExecutionPnlBtc,
      estimatedExecutionPnlNote: '仅含 Execution Ledger 的 realized/unrealized inverse PnL；未含 Funding、手续费和滑点。',
    };
  }

  return {
    DEFAULT_STRATEGY_VERSION,
    DEFAULT_SYMBOL,
    normalizeRecord,
    parseLedger,
    serializeLedger,
    appendLedgerRecord,
    sameExecutionIntent,
    findExecutionById,
    signedContracts,
    applyRecord,
    calculateLedgerState,
    realizedPnlForRecord,
    calculateUnrealizedPnl,
    calculatePositionMetrics,
    buildExecutionHistory,
    normalizeCapitalFlow,
    parseCapitalFlowLedger,
    serializeCapitalFlowLedger,
    appendCapitalFlowRecord,
    sameCapitalFlowIntent,
    findCapitalFlowById,
    signedCapitalFlow,
    calculateCapitalFlowState,
    normalizeAccountSnapshot,
    parseAccountSnapshotLedger,
    serializeAccountSnapshotLedger,
    appendAccountSnapshotRecord,
    sameAccountSnapshotIntent,
    findAccountSnapshotById,
    latestAccountSnapshot,
    calculateCapitalAttribution,
    calculateReconciliation,
    calculateTrackingState,
  };
}));
