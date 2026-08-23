'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');

const {
  CONFIG,
  computeSignal,
  emaSeries,
  smaAt,
  realizedVol,
  trailingDrawdown,
  inversePnlBtc,
  fundingPnlBtc,
  targetContracts,
  maintenanceHeadroom,
} = require('../lib/btc-v3-strategy');
const { parseKlines } = require('../lib/binance-coinm');

const DAY = 86400000;
const WINDOW = 199 * DAY;
const FEE_BPS = 5;
const SLIPPAGE_BPS = 5;
const STRESS_MAINTENANCE_RATE = 0.10;
const RESEARCH_VERSION = 'btc-v3.1-ma-sensitivity-1';
const RESEARCH_API_BASE = 'https://www.binance.com';
const RESEARCH_API_TIMEOUT_MS = 20000;

const FROZEN = Object.freeze({
  strategyVersion: CONFIG.version,
  maLong: CONFIG.maLong,
  maSlopeDays: CONFIG.maSlopeDays,
  valuationLookbackDays: CONFIG.valuationLookbackDays,
  volLookbackDays: CONFIG.volLookbackDays,
  targetAnnualVol: CONFIG.targetAnnualVol,
  annualizationDays: CONFIG.annualizationDays,
  cheapDrawdown: CONFIG.cheapDrawdown,
  veryCheapDrawdown: CONFIG.veryCheapDrawdown,
  cheapMaDeviation: CONFIG.cheapMaDeviation,
  veryCheapMaDeviation: CONFIG.veryCheapMaDeviation,
  minVolCap: CONFIG.minVolCap,
  maxSignalExposure: CONFIG.maxSignalExposure,
  publicMarginCap: CONFIG.publicMarginCap,
  feeBps: FEE_BPS,
  slippageBps: SLIPPAGE_BPS,
  stressMaintenanceRate: STRESS_MAINTENANCE_RATE,
  timingModel: 'T-1 closed index signal -> T perpetual open rebalance; funding uses only mark candles closed by the funding timestamp',
});

const VARIANTS = Object.freeze([
  {
    id: 'short_ema15_30_sma200',
    family: 'short',
    label: 'EMA15/30 + SMA200',
    short: { type: 'EMA', fast: 15, slow: 30 },
    long: { type: 'SMA', period: 200 },
    baseline: true,
  },
  {
    id: 'short_ema20_60_sma200',
    family: 'short',
    label: 'EMA20/60 + SMA200',
    short: { type: 'EMA', fast: 20, slow: 60 },
    long: { type: 'SMA', period: 200 },
    primaryAlternative: true,
  },
  {
    id: 'short_ema20_50_sma200',
    family: 'short',
    label: 'EMA20/50 + SMA200',
    short: { type: 'EMA', fast: 20, slow: 50 },
    long: { type: 'SMA', period: 200 },
    control: true,
  },
  {
    id: 'short_ema10_30_sma200',
    family: 'short',
    label: 'EMA10/30 + SMA200',
    short: { type: 'EMA', fast: 10, slow: 30 },
    long: { type: 'SMA', period: 200 },
    control: true,
  },
  {
    id: 'long_ema15_30_ema200',
    family: 'long',
    label: 'EMA15/30 + EMA200',
    short: { type: 'EMA', fast: 15, slow: 30 },
    long: { type: 'EMA', period: 200 },
    primaryAlternative: true,
  },
]);

const WINDOW_DEFS = Object.freeze([
  { id: 'full_sample', label: 'Full Sample', start: null, end: null },
  { id: '2020_2023', label: '2020-2023', start: '2020-01-01', end: '2023-12-31' },
  { id: '2024_2026_oos', label: '2024-2026 OOS', start: '2024-01-01', end: '2026-12-31' },
]);

const MATERIALITY = Object.freeze({
  cagrPp: 1.0,
  maxDrawdownPp: 2.0,
  endingBtcRelativePct: 5.0,
  turnoverRelativePct: 10.0,
});

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function mean(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function median(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function maxDrawdown(values) {
  let peak = -Infinity;
  let worst = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, (value / peak) - 1);
  }
  return worst;
}

function cagrPct(startValue, endValue, years) {
  if (!(startValue > 0) || !(endValue > 0) || !(years > 0)) return null;
  return ((endValue / startValue) ** (1 / years) - 1) * 100;
}

function isoDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  return (Date.parse(endDate + 'T00:00:00.000Z') - Date.parse(startDate + 'T00:00:00.000Z')) / DAY;
}

function dateInWindow(date, windowDef) {
  if (windowDef.start && date < windowDef.start) return false;
  if (windowDef.end && date > windowDef.end) return false;
  return true;
}

function addEquity(equityBtc, value, label) {
  if (!Number.isFinite(value)) throw new Error('Non-finite BTC accounting value: ' + label);
  const next = equityBtc + value;
  if (!Number.isFinite(next)) throw new Error('Non-finite BTC equity after: ' + label);
  return next;
}

function signalRegimeKey(signal) {
  if (!signal || !signal.ready) return 'warmup';
  return signal.bearLock ? 'bear_lock' : 'trend_' + signal.trendScore;
}

function computeSensitivitySignal(closes, variant) {
  const values = Array.isArray(closes) ? closes.map((value) => finiteNumber(value)) : [];
  const minRequired = Math.max(FROZEN.valuationLookbackDays, FROZEN.maLong + FROZEN.maSlopeDays);
  if (values.length < minRequired || values.some((value) => value === null || value <= 0)) {
    return {
      ready: false,
      reason: 'need_at_least_' + minRequired + '_valid_closed_daily_closes',
      version: FROZEN.strategyVersion,
    };
  }

  const lastIndex = values.length - 1;
  const close = values[lastIndex];
  const shortFastSeries = emaSeries(values, variant.short.fast);
  const shortSlowSeries = emaSeries(values, variant.short.slow);
  const shortFast = shortFastSeries[lastIndex];
  const shortSlow = shortSlowSeries[lastIndex];
  const longSeries = variant.long.type === 'EMA'
    ? emaSeries(values, variant.long.period)
    : values.map((_, index) => smaAt(values, variant.long.period, index));
  const maLong = longSeries[lastIndex];
  const maLongPast = longSeries[lastIndex - FROZEN.maSlopeDays];
  const maLongSlope30 = (maLongPast && maLongPast > 0) ? (maLong / maLongPast) - 1 : null;
  const drawdown365 = trailingDrawdown(values, FROZEN.valuationLookbackDays);
  const valuationMa200 = smaAt(values, FROZEN.maLong, lastIndex);
  const ma200Deviation = valuationMa200 ? (close / valuationMa200) - 1 : null;
  const rv30 = realizedVol(values, FROZEN.volLookbackDays);

  const aboveMaLong = close > maLong;
  const shortBull = shortFast > shortSlow;
  const maSlopePositive = maLongSlope30 > 0;
  const trendScore = Number(aboveMaLong) + Number(shortBull) + Number(maSlopePositive);
  const baseTargets = [0.50, 0.75, 1.00, 1.25];
  const regimeTarget = baseTargets[trendScore];
  const bearLock = !aboveMaLong && maLongSlope30 < 0;

  const cheap = drawdown365 <= FROZEN.cheapDrawdown || ma200Deviation <= FROZEN.cheapMaDeviation;
  const veryCheap = drawdown365 <= FROZEN.veryCheapDrawdown || ma200Deviation <= FROZEN.veryCheapMaDeviation;
  let valuationAdjustedTarget = regimeTarget;
  if (trendScore === 2 && cheap) valuationAdjustedTarget = Math.max(valuationAdjustedTarget, 1.25);
  if (trendScore === 3 && cheap) valuationAdjustedTarget = Math.max(valuationAdjustedTarget, 1.50);
  if (trendScore === 3 && veryCheap) valuationAdjustedTarget = Math.max(valuationAdjustedTarget, 2.00);
  if (bearLock) valuationAdjustedTarget = 0;

  const volatilityCap = rv30 > 0
    ? Math.min(FROZEN.maxSignalExposure, Math.max(FROZEN.minVolCap, FROZEN.targetAnnualVol / rv30))
    : FROZEN.minVolCap;
  const rawSignalTarget = bearLock ? 0 : Math.min(valuationAdjustedTarget, volatilityCap, FROZEN.maxSignalExposure);
  const finalTarget = Math.min(rawSignalTarget, FROZEN.publicMarginCap);

  return {
    ready: true,
    version: FROZEN.strategyVersion,
    close,
    emaFast: shortFast,
    emaSlow: shortSlow,
    maLong,
    maLongPast,
    maLongSlope30,
    drawdown365,
    ma200Deviation,
    rv30,
    aboveMaLong,
    shortBull,
    maSlopePositive,
    trendScore,
    bearLock,
    cheap,
    veryCheap,
    regimeTarget,
    valuationAdjustedTarget,
    volatilityCap,
    rawSignalTarget,
    marginCap: FROZEN.publicMarginCap,
    finalTarget,
    tactical2xRequested: rawSignalTarget > FROZEN.publicMarginCap,
    dataQualityFlags: [],
    autoTrade: false,
  };
}

function assertBaselineParity() {
  const sample = Array.from({ length: 480 }, (_, index) => 10000 * (1 + (Math.sin(index / 17) * 0.0004) + 0.0012) ** index);
  const expected = computeSignal(sample);
  const actual = computeSensitivitySignal(sample, VARIANTS[0]);
  assert.strictEqual(actual.ready, expected.ready);
  for (const key of ['trendScore', 'bearLock', 'cheap', 'veryCheap', 'regimeTarget', 'valuationAdjustedTarget', 'volatilityCap', 'finalTarget']) {
    assert.strictEqual(actual[key], expected[key], 'baseline parity failed for ' + key);
  }
  for (const key of ['emaFast', 'emaSlow', 'maLong', 'maLongPast', 'maLongSlope30', 'drawdown365', 'ma200Deviation', 'rv30']) {
    const expectedKey = key === 'emaFast' ? 'ema15'
      : key === 'emaSlow' ? 'ema30'
        : key === 'maLong' ? 'ma200'
          : key === 'maLongPast' ? 'ma200Past'
            : key === 'maLongSlope30' ? 'ma200Slope30'
              : key === 'ma200Deviation' ? 'ma200Deviation'
                : key;
    assert.ok(Math.abs(actual[key] - expected[expectedKey]) < 1e-12, 'baseline parity failed for ' + key);
  }
  return true;
}

async function fetchResearchJson(endpoint, params = {}) {
  const target = new URL(RESEARCH_API_BASE + endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_API_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'binance-futures-radar-v3-ma-sensitivity/1.0',
      },
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      payload = null;
    }
    if (!response.ok) {
      const message = payload?.msg || payload?.message || ('HTTP ' + response.status);
      throw new Error('Binance research API ' + endpoint + ' failed: ' + message + ' (' + response.status + ')');
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Binance research API timed out after ' + RESEARCH_API_TIMEOUT_MS + 'ms: ' + endpoint);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWindowed(endpoint, params, startTime, endTime) {
  const all = [];
  for (let start = startTime; start <= endTime; start += WINDOW + 1) {
    const end = Math.min(endTime, start + WINDOW);
    const rows = await fetchResearchJson(endpoint, {
      ...params,
      startTime: start,
      endTime: end,
      limit: 1500,
    });
    if (Array.isArray(rows)) all.push(...rows);
  }
  const seen = new Set();
  return all.filter((row) => {
    const key = Array.isArray(row) ? Number(row[0]) : Number(row.fundingTime);
    if (!Number.isFinite(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (Array.isArray(a) ? Number(a[0]) : Number(a.fundingTime))
    - (Array.isArray(b) ? Number(b[0]) : Number(b.fundingTime)));
}

async function fetchFundingRange(symbol, startTime, endTime) {
  const out = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const batch = await fetchResearchJson('/dapi/v1/fundingRate', {
      symbol,
      startTime: cursor,
      endTime,
      limit: 1000,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 1000) break;
    const last = Number(batch.at(-1).fundingTime);
    if (!Number.isFinite(last) || last < cursor) break;
    cursor = last + 1;
  }
  return out.map((row) => ({
    fundingTime: Number(row.fundingTime),
    fundingRate: Number(row.fundingRate),
  })).filter((row) => Number.isFinite(row.fundingTime) && Number.isFinite(row.fundingRate))
    .sort((a, b) => a.fundingTime - b.fundingTime);
}

function nearestClosedMark(markCandles, timestamp) {
  let lo = 0;
  let hi = markCandles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candle = markCandles[mid];
    if (candle.closeTime <= timestamp) {
      best = candle;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best ? best.close : null;
}

function hashInputs(contract, indexDaily, executionDaily, markCandles, funding) {
  return crypto.createHash('sha256').update(JSON.stringify({
    contract,
    indexDaily,
    executionDaily,
    markCandles,
    funding,
  })).digest('hex');
}

function prepareData(contract, indexRaw, executionRaw, markRaw, funding) {
  const indexDaily = parseKlines(indexRaw);
  const executionDaily = parseKlines(executionRaw);
  const markCandles = parseKlines(markRaw);
  const executionByOpen = new Map(executionDaily.map((row) => [row.openTime, row]));
  const fundingByDay = new Map();
  for (const row of funding) {
    const dayOpen = Math.floor(row.fundingTime / DAY) * DAY;
    if (!fundingByDay.has(dayOpen)) fundingByDay.set(dayOpen, []);
    fundingByDay.get(dayOpen).push(row);
  }
  return {
    contract,
    indexDaily,
    executionDaily,
    markCandles,
    funding,
    executionByOpen,
    fundingByDay,
    inputSha256: hashInputs(contract, indexDaily, executionDaily, markCandles, funding),
  };
}

function runScenario(variant, data) {
  let equityBtc = 1;
  let contracts = 0;
  let lastPrice = null;
  let totalFeesBtc = 0;
  let totalSlippageBtc = 0;
  let totalFundingBtc = 0;
  let liquidated = false;
  const closes = [];
  const closeDates = [];
  const rows = [];

  for (const indexCandle of data.indexDaily) {
    const execution = data.executionByOpen.get(indexCandle.openTime);
    if (!execution) continue;

    if (lastPrice !== null) {
      equityBtc = addEquity(
        equityBtc,
        inversePnlBtc(contracts, data.contract.contractSize, lastPrice, execution.open),
        'close-to-open revaluation',
      );
    }
    lastPrice = execution.open;

    const dailyFunding = data.fundingByDay.get(indexCandle.openTime) || [];
    const midnightFunding = dailyFunding.filter((row) => row.fundingTime <= indexCandle.openTime);
    for (const item of midnightFunding) {
      const mark = nearestClosedMark(data.markCandles, item.fundingTime) || execution.open;
      equityBtc = addEquity(
        equityBtc,
        inversePnlBtc(contracts, data.contract.contractSize, lastPrice, mark),
        'midnight funding mark revaluation',
      );
      lastPrice = mark;
      const fundingPnl = fundingPnlBtc(contracts, data.contract.contractSize, mark, item.fundingRate);
      equityBtc = addEquity(equityBtc, fundingPnl, 'midnight funding');
      totalFundingBtc += fundingPnl;
    }
    if (lastPrice !== execution.open) {
      equityBtc = addEquity(
        equityBtc,
        inversePnlBtc(contracts, data.contract.contractSize, lastPrice, execution.open),
        'funding mark-to-open revaluation',
      );
      lastPrice = execution.open;
    }

    const equityBeforeTrade = equityBtc;
    const usdBeforeTrade = equityBeforeTrade * execution.open;
    const previousSignal = closes.length >= FROZEN.valuationLookbackDays
      ? computeSensitivitySignal(closes, variant)
      : null;
    const targetExposure = previousSignal && previousSignal.ready ? previousSignal.finalTarget : 1;
    const sizing = targetContracts({
      targetExposure,
      equityBtc,
      price: execution.open,
      contractSizeUsd: data.contract.contractSize,
      currentContracts: contracts,
    });
    if (!sizing) throw new Error('Unable to size on ' + isoDate(indexCandle.openTime));

    const delta = sizing.deltaContracts;
    let feeBtc = 0;
    let slippageBtc = 0;
    if (delta !== 0) {
      const slip = SLIPPAGE_BPS / 10000;
      const fillPrice = execution.open * (delta > 0 ? (1 + slip) : (1 - slip));
      slippageBtc = inversePnlBtc(delta, data.contract.contractSize, fillPrice, execution.open);
      if (!(slippageBtc <= 1e-12)) {
        throw new Error('Slippage unexpectedly improved PnL on ' + isoDate(indexCandle.openTime));
      }
      equityBtc = addEquity(equityBtc, slippageBtc, 'slippage');
      const fee = Math.abs(delta) * data.contract.contractSize / fillPrice * (FEE_BPS / 10000);
      feeBtc = -fee;
      equityBtc = addEquity(equityBtc, feeBtc, 'fee');
      totalSlippageBtc += slippageBtc;
      totalFeesBtc += fee;
      contracts = sizing.signedContracts;
      lastPrice = execution.open;
    }

    const worstPrice = contracts >= 0 ? execution.low : execution.high;
    const stressedEquity = equityBtc + inversePnlBtc(
      contracts,
      data.contract.contractSize,
      execution.open,
      worstPrice,
    );
    const stress = maintenanceHeadroom({
      equityBtc: stressedEquity,
      signedContracts: contracts,
      contractSizeUsd: data.contract.contractSize,
      markPrice: worstPrice,
      maintenanceRate: STRESS_MAINTENANCE_RATE,
    });
    if (!stress || !stress.passes || stressedEquity <= 0) {
      liquidated = true;
      rows.push({
        date: isoDate(indexCandle.openTime),
        openTime: indexCandle.openTime,
        liquidated: true,
        targetExposure,
        contracts,
      });
      break;
    }

    const intradayFunding = dailyFunding.filter((row) => (
      row.fundingTime > indexCandle.openTime && row.fundingTime <= execution.closeTime
    ));
    for (const item of intradayFunding) {
      const mark = nearestClosedMark(data.markCandles, item.fundingTime) || lastPrice;
      equityBtc = addEquity(
        equityBtc,
        inversePnlBtc(contracts, data.contract.contractSize, lastPrice, mark),
        'intraday funding mark revaluation',
      );
      lastPrice = mark;
      const fundingPnl = fundingPnlBtc(contracts, data.contract.contractSize, mark, item.fundingRate);
      equityBtc = addEquity(equityBtc, fundingPnl, 'intraday funding');
      totalFundingBtc += fundingPnl;
    }

    equityBtc = addEquity(
      equityBtc,
      inversePnlBtc(contracts, data.contract.contractSize, lastPrice, execution.close),
      'daily close revaluation',
    );
    lastPrice = execution.close;
    const signalDate = closeDates.at(-1) || null;
    closes.push(indexCandle.close);
    closeDates.push(isoDate(indexCandle.openTime));
    const realizedExposure = equityBtc > 0
      ? 1 + ((contracts * data.contract.contractSize / execution.close) / equityBtc)
      : null;
    rows.push({
      date: isoDate(indexCandle.openTime),
      openTime: indexCandle.openTime,
      indexClose: indexCandle.close,
      perpOpen: execution.open,
      perpClose: execution.close,
      equityBtc,
      navUsd: equityBtc * execution.close,
      equityBeforeTrade,
      usdBeforeTrade,
      targetExposure,
      realizedExposure,
      contracts,
      tradeDeltaContracts: delta,
      turnoverBtcNotional: Math.abs(delta) * data.contract.contractSize / execution.open,
      feeBtc,
      slippageBtc,
      signalDate,
      signalReady: Boolean(previousSignal && previousSignal.ready),
      emaBull: previousSignal?.shortBull ?? null,
      aboveMaLong: previousSignal?.aboveMaLong ?? null,
      maSlopePositive: previousSignal?.maSlopePositive ?? null,
      trendScore: previousSignal?.trendScore ?? null,
      bearLock: previousSignal?.bearLock ?? false,
      regimeKey: signalRegimeKey(previousSignal),
      finalTarget: previousSignal?.finalTarget ?? 1,
      maLong: previousSignal?.maLong ?? null,
      maLongPast: previousSignal?.maLongPast ?? null,
      maLongSlope30: previousSignal?.maLongSlope30 ?? null,
      drawdown365: previousSignal?.drawdown365 ?? null,
      rv30: previousSignal?.rv30 ?? null,
      volatilityCap: previousSignal?.volatilityCap ?? null,
      valuationAdjustedTarget: previousSignal?.valuationAdjustedTarget ?? null,
      stressHeadroomMultiple: stress.headroomMultiple,
    });
  }

  return {
    variant,
    rows,
    liquidated,
    totalFeesBtc,
    totalSlippageBtc,
    totalFundingBtc,
    signalReadyDate: rows.find((row) => row.signalReady)?.date || null,
  };
}

function crossEvents(rows) {
  const events = [];
  let previous = null;
  for (const row of rows) {
    if (!row.signalReady || row.emaBull === null) continue;
    const current = row.emaBull ? 'bullish' : 'bearish';
    if (previous && previous.state !== current) {
      events.push({
        date: row.date,
        direction: current,
        daysSincePrevious: daysBetween(previous.date, row.date),
      });
    }
    previous = { date: row.date, state: current };
  }
  return events;
}

function whipsawCount(events, maxDays = 30) {
  let count = 0;
  for (let index = 0; index + 1 < events.length; index += 1) {
    if (events[index].direction !== events[index + 1].direction
      && events[index + 1].daysSincePrevious <= maxDays) {
      count += 1;
    }
  }
  return count;
}

function countTransitions(rows, field) {
  let previous = null;
  let transitions = 0;
  for (const row of rows) {
    if (!row.signalReady || row[field] === null || row[field] === undefined) continue;
    if (previous !== null && row[field] !== previous) transitions += 1;
    previous = row[field];
  }
  return transitions;
}

function distribution(rows, field) {
  const output = {};
  for (const row of rows) {
    if (!row.signalReady || row[field] === null || row[field] === undefined) continue;
    const key = String(row[field]);
    output[key] = (output[key] || 0) + 1;
  }
  return output;
}

function summarizeWindow(run, windowDef) {
  const selected = run.rows.filter((row) => dateInWindow(row.date, windowDef) && !row.liquidated);
  if (!selected.length) {
    return {
      available: false,
      reason: 'no_completed_observations_in_window',
    };
  }

  const first = selected[0];
  const last = selected.at(-1);
  const years = Math.max((daysBetween(first.date, last.date) + 1) / FROZEN.annualizationDays, 1 / 365);
  const startEquityBtc = first.equityBeforeTrade;
  const endingBtc = last.equityBtc;
  const startUsd = first.usdBeforeTrade;
  const endingUsd = last.navUsd;
  const btcValues = [startEquityBtc, ...selected.map((row) => row.equityBtc)];
  const usdValues = [startUsd, ...selected.map((row) => row.navUsd)];
  const signalRows = selected.filter((row) => row.signalReady);
  const events = crossEvents(selected);
  const trend3Rows = signalRows.filter((row) => row.trendScore === 3);
  const positiveLongTrendRows = signalRows.filter((row) => row.aboveMaLong && row.maSlopePositive);
  const avgExposure = mean(selected.map((row) => row.targetExposure));
  const avgRealizedExposure = mean(selected.map((row) => row.realizedExposure));
  const turnoverBtcNotional = selected.reduce((sum, row) => sum + row.turnoverBtcNotional, 0);
  const averageEquityBtc = mean([startEquityBtc, ...selected.map((row) => row.equityBtc)]);
  const hodlStartUsd = startEquityBtc * first.perpOpen;
  const hodlEndUsd = startEquityBtc * last.perpClose;
  const hodlCagr = cagrPct(hodlStartUsd, hodlEndUsd, years);

  return {
    available: true,
    startDate: first.date,
    endDate: last.date,
    observationDays: selected.length,
    signalReadyDays: signalRows.length,
    startEquityBtc: safeNumber(startEquityBtc),
    endingBtc: safeNumber(endingBtc),
    periodBtcReturnPct: safeNumber((endingBtc / startEquityBtc - 1) * 100),
    startUsd: safeNumber(startUsd),
    endingUsd: safeNumber(endingUsd),
    periodUsdReturnPct: safeNumber((endingUsd / startUsd - 1) * 100),
    btcCagrPct: safeNumber(cagrPct(startEquityBtc, endingBtc, years)),
    usdCagrPct: safeNumber(cagrPct(startUsd, endingUsd, years)),
    hodlUsdCagrPct: safeNumber(hodlCagr),
    usdCagrVsHodlPp: safeNumber(cagrPct(startUsd, endingUsd, years) - hodlCagr),
    btcMaxDrawdownPct: safeNumber(maxDrawdown(btcValues) * 100),
    usdMaxDrawdownPct: safeNumber(maxDrawdown(usdValues) * 100),
    tradeCount: selected.filter((row) => row.tradeDeltaContracts !== 0).length,
    turnoverBtcNotional: safeNumber(turnoverBtcNotional),
    turnoverPctOfAverageEquity: averageEquityBtc > 0
      ? safeNumber((turnoverBtcNotional / averageEquityBtc) * 100)
      : null,
    trendScoreDistribution: distribution(selected, 'trendScore'),
    trendScoreSwitchCount: countTransitions(selected, 'trendScore'),
    regimeSwitchCount: countTransitions(selected, 'regimeKey'),
    bearLockDays: selected.filter((row) => row.bearLock).length,
    bearLockPctOfDays: safeNumber(selected.filter((row) => row.bearLock).length / selected.length * 100),
    averageExposure: safeNumber(avgExposure),
    averageExposureSignalReady: safeNumber(mean(signalRows.map((row) => row.targetExposure))),
    averageRealizedExposure: safeNumber(avgRealizedExposure),
    trend3Days: trend3Rows.length,
    trend3AverageExposure: safeNumber(mean(trend3Rows.map((row) => row.targetExposure))),
    positiveLongTrendDays: positiveLongTrendRows.length,
    positiveLongTrendAverageExposure: safeNumber(mean(positiveLongTrendRows.map((row) => row.targetExposure))),
    shortTrendCrossCount: events.length,
    shortTrendBullishCrosses: events.filter((event) => event.direction === 'bullish').length,
    shortTrendBearishCrosses: events.filter((event) => event.direction === 'bearish').length,
    medianDaysBetweenShortCrosses: safeNumber(median(events.map((event) => event.daysSincePrevious))),
    whipsawCrossCount30d: whipsawCount(events, 30),
    liquidated: run.liquidated,
    totalFeesBtc: safeNumber(run.totalFeesBtc),
    totalSlippageBtc: safeNumber(run.totalSlippageBtc),
    totalFundingBtc: safeNumber(run.totalFundingBtc),
  };
}

function diffMetrics(baseline, candidate) {
  const delta = (key) => {
    if (!baseline || !candidate || !Number.isFinite(baseline[key]) || !Number.isFinite(candidate[key])) return null;
    return candidate[key] - baseline[key];
  };
  const relative = (key) => {
    if (!baseline || !candidate || !Number.isFinite(baseline[key]) || !Number.isFinite(candidate[key])
      || baseline[key] === 0) return null;
    return ((candidate[key] / baseline[key]) - 1) * 100;
  };
  return {
    btcCagrPp: delta('btcCagrPct'),
    usdCagrPp: delta('usdCagrPct'),
    btcMaxDrawdownPp: delta('btcMaxDrawdownPct'),
    usdMaxDrawdownPp: delta('usdMaxDrawdownPct'),
    endingBtcRelativePct: relative('endingBtc'),
    tradeCountDelta: delta('tradeCount'),
    turnoverRelativePct: relative('turnoverBtcNotional'),
    turnoverPpOfAverageEquity: delta('turnoverPctOfAverageEquity'),
    trendScoreSwitchDelta: delta('trendScoreSwitchCount'),
    regimeSwitchDelta: delta('regimeSwitchCount'),
    bearLockDaysDelta: delta('bearLockDays'),
    averageExposureDelta: delta('averageExposure'),
    averageRealizedExposureDelta: delta('averageRealizedExposure'),
    trend3DaysDelta: delta('trend3Days'),
    trend3AverageExposureDelta: delta('trend3AverageExposure'),
    positiveLongTrendDaysDelta: delta('positiveLongTrendDays'),
    positiveLongTrendAverageExposureDelta: delta('positiveLongTrendAverageExposure'),
    shortTrendCrossDelta: delta('shortTrendCrossCount'),
    whipsawCrossDelta: delta('whipsawCrossCount30d'),
    usdCagrVsHodlPp: delta('usdCagrVsHodlPp'),
  };
}

function outcomeCounts(diff) {
  const candidateWins = [
    diff.btcCagrPp >= MATERIALITY.cagrPp,
    diff.usdCagrPp >= MATERIALITY.cagrPp,
    diff.btcMaxDrawdownPp >= MATERIALITY.maxDrawdownPp,
    diff.usdMaxDrawdownPp >= MATERIALITY.maxDrawdownPp,
  ].filter(Boolean).length;
  const baselineWins = [
    diff.btcCagrPp <= -MATERIALITY.cagrPp,
    diff.usdCagrPp <= -MATERIALITY.cagrPp,
    diff.btcMaxDrawdownPp <= -MATERIALITY.maxDrawdownPp,
    diff.usdMaxDrawdownPp <= -MATERIALITY.maxDrawdownPp,
  ].filter(Boolean).length;
  return { candidateWins, baselineWins };
}

function classifyPair(pairDiffs, baselineName, candidateName) {
  const oos = pairDiffs['2024_2026_oos'];
  const full = pairDiffs.full_sample;
  const preOos = pairDiffs['2020_2023'];
  if (!oos || !full || !preOos) {
    return {
      classification: 'inconclusive',
      reason: 'one_or_more_required_windows_unavailable',
      candidate: candidateName,
      baseline: baselineName,
    };
  }
  const oosCounts = outcomeCounts(oos);
  const contextCounts = [outcomeCounts(full), outcomeCounts(preOos)];
  const candidateContextWins = contextCounts.filter((item) => item.candidateWins > item.baselineWins).length;
  const baselineContextWins = contextCounts.filter((item) => item.baselineWins > item.candidateWins).length;
  const candidateRiskWorse = oos.btcMaxDrawdownPp <= -MATERIALITY.maxDrawdownPp
    && oos.usdMaxDrawdownPp <= -MATERIALITY.maxDrawdownPp;
  const baselineRiskWorse = oos.btcMaxDrawdownPp >= MATERIALITY.maxDrawdownPp
    && oos.usdMaxDrawdownPp >= MATERIALITY.maxDrawdownPp;
  const oosAllBelowMaterial = [
    Math.abs(oos.btcCagrPp),
    Math.abs(oos.usdCagrPp),
  ].every((value) => value < MATERIALITY.cagrPp)
    && [
      Math.abs(oos.btcMaxDrawdownPp),
      Math.abs(oos.usdMaxDrawdownPp),
    ].every((value) => value < MATERIALITY.maxDrawdownPp)
    && Math.abs(oos.endingBtcRelativePct || 0) < MATERIALITY.endingBtcRelativePct;

  let classification = 'inconclusive';
  let reason = 'material_tradeoff_or_window_direction_conflict';
  if (oosAllBelowMaterial) {
    classification = 'no_material_difference';
    reason = 'OOS outcome differences stay below the predeclared materiality thresholds';
  } else if (oosCounts.candidateWins >= 2 && !candidateRiskWorse && candidateContextWins >= 1) {
    classification = candidateName === '20_60' ? '20_60_preferred' : 'EMA200_preferred';
    reason = 'candidate materially improves at least two OOS outcome metrics, does not lose both drawdown metrics, and has context support';
  } else if (oosCounts.baselineWins >= 2 && !baselineRiskWorse && baselineContextWins >= 1) {
    classification = baselineName === '15_30' ? '15_30_preferred' : 'SMA200_preferred';
    reason = 'baseline materially improves at least two OOS outcome metrics, does not lose both drawdown metrics, and has context support';
  }
  return {
    classification,
    reason,
    baseline: baselineName,
    candidate: candidateName,
    oosOutcomeCounts: oosCounts,
    contextOutcomeCounts: {
      full_sample: contextCounts[0],
      '2020_2023': contextCounts[1],
    },
    materiality: MATERIALITY,
  };
}

function buildComparison(results, baselineId, candidateId, baselineName, candidateName, controls = []) {
  const byWindow = {};
  for (const windowDef of WINDOW_DEFS) {
    const baseline = results[baselineId].windows[windowDef.id];
    const candidate = results[candidateId].windows[windowDef.id];
    byWindow[windowDef.id] = {
      baseline,
      candidate,
      deltaCandidateMinusBaseline: diffMetrics(baseline, candidate),
    };
  }
  const diffs = Object.fromEntries(Object.entries(byWindow).map(([key, value]) => [
    key,
    value.deltaCandidateMinusBaseline,
  ]));
  return {
    baseline: baselineName,
    candidate: candidateName,
    controls,
    byWindow,
    classification: classifyPair(diffs, baselineName, candidateName),
  };
}

function buildResult(data, scenarioRuns) {
  const scenarios = {};
  for (const variant of VARIANTS) {
    const run = scenarioRuns[variant.id];
    scenarios[variant.id] = {
      id: variant.id,
      family: variant.family,
      label: variant.label,
      short: variant.short,
      long: variant.long,
      baseline: Boolean(variant.baseline),
      primaryAlternative: Boolean(variant.primaryAlternative),
      control: Boolean(variant.control),
      windows: Object.fromEntries(WINDOW_DEFS.map((windowDef) => [
        windowDef.id,
        summarizeWindow(run, windowDef),
      ])),
      signalReadyDate: run.signalReadyDate,
      liquidated: run.liquidated,
    };
  }

  const short = buildComparison(
    scenarios,
    'short_ema15_30_sma200',
    'short_ema20_60_sma200',
    '15_30',
    '20_60',
    ['EMA20/50', 'EMA10/30'],
  );
  const long = buildComparison(
    scenarios,
    'short_ema15_30_sma200',
    'long_ema15_30_ema200',
    'SMA200',
    'EMA200',
  );
  const shortControls = {
    ema20_50: buildComparison(
      scenarios,
      'short_ema15_30_sma200',
      'short_ema20_50_sma200',
      '15_30',
      'EMA20/50',
    ),
    ema10_30: buildComparison(
      scenarios,
      'short_ema15_30_sma200',
      'short_ema10_30_sma200',
      '15_30',
      'EMA10/30',
    ),
  };

  return {
    researchVersion: RESEARCH_VERSION,
    generatedAt: new Date().toISOString(),
    branch: 'research/v3-ma-sensitivity',
    strategyVersion: FROZEN.strategyVersion,
    objective: 'Validate robustness of frozen V3.1 EMA15/30 + SMA200 against the predeclared common alternatives; do not search for the historical optimum.',
    frozenParameters: {
      ...FROZEN,
      shortBaseline: 'EMA15/30',
      longBaseline: 'SMA200',
      bearLock: 'Close < selected 200MA and selected 200MA 30D slope < 0 -> valuationAdjustedTarget=0',
      valuation: 'Frozen V3.1 365D drawdown and SMA200 deviation thresholds; only Trend Score price-vs-long-MA and long-MA slope change in the EMA200 scenario',
      volatility: 'RV30 from closed daily simple returns; clamp(0.60 / RV30, 0.50, 2.00)',
      margin: 'publicMarginCap=1.50x',
      signalVariableScope: {
        short: ['EMA15/30', 'EMA20/60', 'EMA20/50', 'EMA10/30'],
        long: ['SMA200', 'EMA200'],
      },
    },
    windows: WINDOW_DEFS,
    materiality: MATERIALITY,
    data: {
      apiHost: RESEARCH_API_BASE,
      contract: data.contract,
      startDate: data.indexDaily.length ? isoDate(data.indexDaily[0].openTime) : null,
      endDate: data.indexDaily.length ? isoDate(data.indexDaily.at(-1).openTime) : null,
      indexDailyCount: data.indexDaily.length,
      executionDailyCount: data.executionDaily.length,
      markCandleCount: data.markCandles.length,
      fundingCount: data.funding.length,
      inputSha256: data.inputSha256,
      endpoints: [
        '/dapi/v1/exchangeInfo',
        '/dapi/v1/indexPriceKlines',
        '/dapi/v1/continuousKlines',
        '/dapi/v1/markPriceKlines',
        '/dapi/v1/fundingRate',
      ],
    },
    integrity: {
      baselineParity: assertBaselineParity(),
      noProductionFilesChangedByRunner: true,
      noLookAhead: {
        signalUsesOnlyClosedIndexCloses: true,
        executionAtNextPerpetualOpen: true,
        fundingMarkCloseTimeAtOrBeforeFundingTimestamp: true,
        currentDayOHLCExcludedFromSignal: true,
      },
      executionModelFrozen: true,
      parameterSearchStoppedAtPredeclaredSet: true,
    },
    scenarios,
    comparisons: {
      short,
      shortControls,
      long,
    },
    conclusions: {
      shortClassification: short.classification.classification,
      longClassification: long.classification.classification,
    },
  };
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function formatPct(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return formatNumber(value, digits) + '%';
}

function formatX(value) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(3) + 'x';
}

function signedPp(value) {
  if (!Number.isFinite(value)) return '—';
  return (value >= 0 ? '+' : '') + value.toFixed(2);
}

function formatMetricTable(results, variantIds) {
  const lines = [];
  lines.push('| 组合 | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | turnover BTC | trades | score/regime switches | Bear Lock days | avg exposure |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const variantId of variantIds) {
    const result = results[variantId];
    const metric = result.windows.full_sample;
    lines.push('| ' + result.label
      + ' | ' + formatNumber(metric.endingBtc, 4)
      + ' | ' + formatPct(metric.btcCagrPct)
      + ' | ' + formatPct(metric.usdCagrPct)
      + ' | ' + formatPct(metric.btcMaxDrawdownPct)
      + ' | ' + formatPct(metric.usdMaxDrawdownPct)
      + ' | ' + formatNumber(metric.turnoverBtcNotional, 2)
      + ' | ' + formatNumber(metric.tradeCount, 0)
      + ' | ' + formatNumber(metric.trendScoreSwitchCount, 0) + '/' + formatNumber(metric.regimeSwitchCount, 0)
      + ' | ' + formatNumber(metric.bearLockDays, 0)
      + ' | ' + formatX(metric.averageExposure)
      + ' |');
  }
  return lines.join('\n');
}

function formatWindowTable(results, variantIds, windowId) {
  const lines = [];
  lines.push('| 组合 | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | turnover BTC | trades | score switches | regime switches | Bear Lock days | avg exposure |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const variantId of variantIds) {
    const result = results[variantId];
    const metric = result.windows[windowId];
    lines.push('| ' + result.label
      + ' | ' + formatNumber(metric.endingBtc, 4)
      + ' | ' + formatPct(metric.btcCagrPct)
      + ' | ' + formatPct(metric.usdCagrPct)
      + ' | ' + formatPct(metric.btcMaxDrawdownPct)
      + ' | ' + formatPct(metric.usdMaxDrawdownPct)
      + ' | ' + formatNumber(metric.turnoverBtcNotional, 2)
      + ' | ' + formatNumber(metric.tradeCount, 0)
      + ' | ' + formatNumber(metric.trendScoreSwitchCount, 0)
      + ' | ' + formatNumber(metric.regimeSwitchCount, 0)
      + ' | ' + formatNumber(metric.bearLockDays, 0)
      + ' | ' + formatX(metric.averageExposure)
      + ' |');
  }
  return lines.join('\n');
}

function driverSentence(comparison, results, baselineId, candidateId) {
  const oos = comparison.byWindow['2024_2026_oos'];
  const delta = oos.deltaCandidateMinusBaseline;
  const parts = [];
  if (Number.isFinite(delta.shortTrendCrossDelta)) {
    parts.push((delta.shortTrendCrossDelta > 0 ? '更多' : '更少') + Math.abs(delta.shortTrendCrossDelta).toFixed(0) + ' 次短期交叉');
  }
  if (Number.isFinite(delta.whipsawCrossDelta)) {
    parts.push('30 日内反向 whipsaw ' + (delta.whipsawCrossDelta > 0 ? '增加' : '减少') + Math.abs(delta.whipsawCrossDelta).toFixed(0) + ' 次');
  }
  if (Number.isFinite(delta.averageExposureDelta)) {
    parts.push('平均目标敞口 ' + (delta.averageExposureDelta >= 0 ? '增加' : '减少') + ' ' + Math.abs(delta.averageExposureDelta).toFixed(3) + 'x');
  }
  if (Number.isFinite(delta.turnoverRelativePct)) {
    parts.push('实际换手 BTC 名义量 ' + (delta.turnoverRelativePct >= 0 ? '增加' : '减少') + ' ' + Math.abs(delta.turnoverRelativePct).toFixed(1) + '%');
  }
  if (Number.isFinite(delta.trend3AverageExposureDelta)) {
    parts.push('Trend 3 日平均敞口 ' + (delta.trend3AverageExposureDelta >= 0 ? '增加' : '减少') + ' ' + Math.abs(delta.trend3AverageExposureDelta).toFixed(3) + 'x');
  }
  if (Number.isFinite(delta.trend3DaysDelta)) {
    parts.push('Trend 3 天数 ' + (delta.trend3DaysDelta >= 0 ? '增加' : '减少') + ' ' + Math.abs(delta.trend3DaysDelta).toFixed(0) + ' 天');
  }
  const outcome = 'OOS BTC CAGR ' + signedPp(delta.btcCagrPp)
    + 'pp、USD CAGR ' + signedPp(delta.usdCagrPp)
    + 'pp、USD max DD ' + signedPp(delta.usdMaxDrawdownPp) + 'pp';
  return outcome + '；主要可观测差异是' + (parts.length ? parts.join('、') : '未出现可量化的执行或状态差异')
    + '。对照组合为 ' + results[baselineId].label + '，测试组合为 ' + results[candidateId].label + '。';
}

function renderReport(result) {
  const shortIds = VARIANTS.filter((variant) => variant.family === 'short').map((variant) => variant.id);
  const longIds = [VARIANTS[0].id, VARIANTS[4].id];
  const shortComparison = result.comparisons.short;
  const longComparison = result.comparisons.long;
  const data = result.data;
  const lines = [];
  lines.push('# BTC V3.1 均线敏感性测试');
  lines.push('');
  lines.push('研究分支：research/v3-ma-sensitivity；研究版本：' + RESEARCH_VERSION);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push('- 短期均线分类：' + shortComparison.classification.classification);
  lines.push('- 长期均线分类：' + longComparison.classification.classification);
  lines.push('- 这不是参数寻优：短期只比较 EMA15/30、EMA20/60、EMA20/50、EMA10/30；长期只比较 SMA200 与 EMA200，未继续扩大搜索。');
  lines.push('');
  lines.push('分类按事先声明的门槛判断：OOS 至少两个主要结果指标达到 materiality，且不能同时恶化 BTC/USD 两种 max drawdown，并需要至少一个历史窗口方向支持；否则为 inconclusive 或 no_material_difference。');
  lines.push('');
  lines.push('## 数据与冻结边界');
  lines.push('');
  lines.push('- 生成时间：' + result.generatedAt);
  lines.push('- API host：' + data.apiHost + '；使用官方 /dapi/v1 路径。信号：Binance COIN-M BTCUSD Index Price 完整日线；执行：BTCUSD_PERP continuous perpetual 日线；Funding：BTCUSD_PERP funding history；Funding mark 只取在 funding timestamp 前已闭合的 4H mark candle。');
  lines.push('- 数据范围：' + data.startDate + ' 至 ' + data.endDate + '；index ' + data.indexDailyCount + ' 根、execution ' + data.executionDailyCount + ' 根、mark ' + data.markCandleCount + ' 根、funding ' + data.fundingCount + ' 条。');
  lines.push('- 输入数据 SHA-256：' + data.inputSha256);
  lines.push('- 执行时序：T-1 已闭合 signal → T 开盘调仓；当前日 OHLC 不进入当天开盘选择；逆向 COIN-M PnL、整数合约、5 bps fee、5 bps adverse slippage、实际 funding、10% 静态维护率 stress 全部冻结。');
  lines.push('- EMA200 对照只替换 Trend Score 的 price > 200MA 与 200MA 30D slope；估值层的 365D drawdown、SMA200 deviation、RV30、Bear Lock 规则和所有执行参数保持冻结。');
  lines.push('- 基准 parity：' + (result.integrity.baselineParity ? 'PASS' : 'FAIL') + '；未修改 lib/btc-v3-strategy.js 或生产 V3.1 策略。');
  lines.push('');
  lines.push('## Full Sample');
  lines.push('');
  lines.push(formatMetricTable(result.scenarios, shortIds));
  lines.push('');
  lines.push('长期均线单独比较（短期固定 EMA15/30）：');
  lines.push('');
  lines.push(formatMetricTable(result.scenarios, longIds));
  lines.push('');
  lines.push('ending BTC 是同一笔从 1 BTC 开始的连续账户在窗口末的 BTC NAV；窗口 CAGR 从窗口起点 NAV 到窗口末 NAV 计算。turnover BTC 是实际成交合约名义量按执行开盘价折算的 BTC 总量。');
  lines.push('');
  lines.push('## 2020-2023');
  lines.push('');
  lines.push(formatWindowTable(result.scenarios, shortIds, '2020_2023'));
  lines.push('');
  lines.push(formatWindowTable(result.scenarios, longIds, '2020_2023'));
  lines.push('');
  lines.push('## 2024-2026 OOS');
  lines.push('');
  lines.push(formatWindowTable(result.scenarios, shortIds, '2024_2026_oos'));
  lines.push('');
  lines.push(formatWindowTable(result.scenarios, longIds, '2024_2026_oos'));
  lines.push('');
  lines.push('## 收益差异归因');
  lines.push('');
  lines.push('### 短期均线：EMA15/30 vs EMA20/60');
  lines.push('');
  lines.push(driverSentence(shortComparison, result.scenarios, 'short_ema15_30_sma200', 'short_ema20_60_sma200'));
  lines.push('');
  lines.push('EMA20/50 与 EMA10/30 是预先限定的控制组合，仅用于识别更慢/更快的方向是否稳定，不参与最终分类：');
  lines.push('');
  lines.push(driverSentence(result.comparisons.shortControls.ema20_50, result.scenarios, 'short_ema15_30_sma200', 'short_ema20_50_sma200'));
  lines.push('');
  lines.push(driverSentence(result.comparisons.shortControls.ema10_30, result.scenarios, 'short_ema15_30_sma200', 'short_ema10_30_sma200'));
  lines.push('');
  lines.push('### 长期均线：SMA200 vs EMA200');
  lines.push('');
  lines.push(driverSentence(longComparison, result.scenarios, 'short_ema15_30_sma200', 'long_ema15_30_ema200'));
  lines.push('');
  lines.push('解释口径：交叉次数和 30 日内反向交叉用于反应速度与 whipsaw；平均敞口用于隔离持仓更多带来的收益差异；实际 turnover/trade count 用于交易成本与执行扰动；Trend 3 日数及其平均敞口用于观察大趋势捕获。以上均为回测后的描述性分析，没有回写信号或参数。');
  lines.push('');
  lines.push('## 限制');
  lines.push('');
  lines.push('- 这仍是研究回测，不是生产策略变更，也不构成实盘授权。');
  lines.push('- 历史维护率层级无法逐时重建，沿用 V3.1 的 10% 静态 stress；若出现 liquidation，窗口结果会标记为失败而不会把缺失收益当成 0。');
  lines.push('- 2024-2026 OOS 是按固定组合直接评估的留出窗口；不允许根据 OOS 结果继续调整 EMA/MA 参数。');
  lines.push('');
  lines.push('结果 JSON：research/btc-v3-ma-sensitivity-result.json');
  lines.push('');
  return lines.join('\n');
}

async function loadData() {
  const exchangeInfo = await fetchResearchJson('/dapi/v1/exchangeInfo', {});
  const rawContract = Array.isArray(exchangeInfo?.symbols)
    ? exchangeInfo.symbols.find((item) => item?.symbol === CONFIG.coinMSymbol)
    : null;
  if (!rawContract) throw new Error('COIN-M contract not found: ' + CONFIG.coinMSymbol);
  const contract = {
    symbol: rawContract.symbol,
    pair: rawContract.pair,
    contractType: rawContract.contractType,
    contractStatus: rawContract.contractStatus,
    onboardDate: Number(rawContract.onboardDate),
    contractSize: Number(rawContract.contractSize),
    quoteAsset: rawContract.quoteAsset,
    baseAsset: rawContract.baseAsset,
    marginAsset: rawContract.marginAsset,
    liquidationFee: Number(rawContract.liquidationFee),
    marketTakeBound: Number(rawContract.marketTakeBound),
  };
  if (contract.marginAsset !== 'BTC' || contract.contractType !== 'PERPETUAL') {
    throw new Error('Canonical instrument mismatch: ' + JSON.stringify(contract));
  }
  const startTime = contract.onboardDate;
  const endTime = Date.now() - DAY;
  const [indexRaw, executionRaw, markRaw, funding] = await Promise.all([
    fetchWindowed('/dapi/v1/indexPriceKlines', { pair: CONFIG.coinMPair, interval: '1d' }, startTime, endTime),
    fetchWindowed('/dapi/v1/continuousKlines', {
      pair: CONFIG.coinMPair,
      contractType: 'PERPETUAL',
      interval: '1d',
    }, startTime, endTime),
    fetchWindowed('/dapi/v1/markPriceKlines', { symbol: CONFIG.coinMSymbol, interval: '4h' }, startTime, endTime),
    fetchFundingRange(CONFIG.coinMSymbol, startTime, endTime),
  ]);
  return prepareData(contract, indexRaw, executionRaw, markRaw, funding);
}

async function main() {
  const data = await loadData();
  const scenarioRuns = {};
  for (const variant of VARIANTS) {
    scenarioRuns[variant.id] = runScenario(variant, data);
  }
  const result = buildResult(data, scenarioRuns);
  const researchDir = path.join(__dirname, '..', 'research');
  fs.mkdirSync(researchDir, { recursive: true });
  const resultPath = path.join(researchDir, 'btc-v3-ma-sensitivity-result.json');
  const reportPath = path.join(researchDir, 'btc-v3-ma-sensitivity-report.md');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(reportPath, renderReport(result));
  console.log(JSON.stringify({
    resultPath,
    reportPath,
    branch: result.branch,
    generatedAt: result.generatedAt,
    shortClassification: result.conclusions.shortClassification,
    longClassification: result.conclusions.longClassification,
    data: result.data,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  FROZEN,
  MATERIALITY,
  VARIANTS,
  WINDOW_DEFS,
  computeSensitivitySignal,
  crossEvents,
  summarizeWindow,
  classifyPair,
  buildResult,
};
