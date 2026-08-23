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

  function calculateLedgerState(records = []) {
    let position = { contracts: 0, averageEntryPrice: null };
    const timeline = [];
    for (const record of records) {
      position = applyRecord(position, record);
      timeline.push({ record, ...position });
    }
    return { position, timeline };
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
    const { timeline } = calculateLedgerState(records);
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
      };
    });
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
    calculateUnrealizedPnl,
    calculatePositionMetrics,
    buildExecutionHistory,
  };
}));
