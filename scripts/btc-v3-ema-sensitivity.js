'use strict';

/*
 * Research-only V3.1 EMA sensitivity test.
 *
 * This deliberately does not alter lib/btc-v3-strategy.js.  EMA variants are
 * evaluated against a local copy of the frozen V3.1 signal formula while the
 * 15/30 case calls the production computeSignal implementation directly.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  CONFIG,
  computeSignal,
  emaSeries,
  realizedVol,
  trailingDrawdown,
  smaAt,
  clamp,
  inversePnlBtc,
  fundingPnlBtc,
  targetContracts,
  maintenanceHeadroom,
} = require('../lib/btc-v3-strategy');

const DAY = 86400000;
const HOUR = 3600000;
const EIGHT_HOURS = 8 * HOUR;
const VISION_BASE = 'https://data.binance.vision/data/futures/cm/monthly';
const VISION_START_TIME = Date.UTC(2020, 7, 1);
const IN_SAMPLE_END = Date.UTC(2023, 11, 31, 23, 59, 59, 999);
const OUT_OF_SAMPLE_START = Date.UTC(2024, 0, 1);
const DEFAULT_END_DATE = '2026-07-31';
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'btc-v3-exposure-curve-v2-cache');
const FEE_BPS = numberOr(process.env.BTC_V3_FEE_BPS, 5);
const SLIPPAGE_BPS = numberOr(process.env.BTC_V3_SLIPPAGE_BPS, 5);
const STRESS_MAINTENANCE_RATE = numberOr(process.env.BTC_V3_MAINT_RATE, 0.10);
const EMA_VARIANTS = Object.freeze([
  Object.freeze({ name: 'ema15_30', label: 'EMA15/EMA30', emaFast: 15, emaSlow: 30 }),
  Object.freeze({ name: 'ema20_60', label: 'EMA20/EMA60', emaFast: 20, emaSlow: 60 }),
  Object.freeze({ name: 'ema20_50', label: 'EMA20/EMA50', emaFast: 20, emaSlow: 50 }),
  Object.freeze({ name: 'ema10_30', label: 'EMA10/EMA30', emaFast: 10, emaSlow: 30 }),
]);

const VISION_CONTRACT = Object.freeze({
  symbol: CONFIG.coinMSymbol,
  pair: CONFIG.coinMPair,
  contractType: 'PERPETUAL',
  contractStatus: 'TRADING',
  contractSize: 100,
  quoteAsset: 'USD',
  baseAsset: 'BTC',
  marginAsset: 'BTC',
  metadataSource: 'Existing frozen V3 COIN-M contract specification; contractSize is 100 USD.',
});

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function dateOnly(timestamp) {
  return iso(timestamp).slice(0, 10);
}

function dayStart(timestamp) {
  return Math.floor(timestamp / DAY) * DAY;
}

function monthKeys(startTime, endTime) {
  const first = new Date(startTime);
  const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  const last = new Date(endTime);
  const end = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1);
  const months = [];
  while (cursor.getTime() <= end) {
    months.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function requestedEndTime() {
  const requested = process.env.BTC_V3_EMA_END || process.env.BTC_V3_EXPOSURE_END || DEFAULT_END_DATE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) throw new Error(`Invalid BTC_V3_EMA_END: ${requested}`);
  const timestamp = Date.parse(`${requested}T23:59:59.999Z`);
  if (!Number.isFinite(timestamp) || timestamp < OUT_OF_SAMPLE_START) {
    throw new Error(`EMA sensitivity end must be a valid date on/after 2024-01-01: ${requested}`);
  }
  return timestamp;
}

function visionArchiveUrl(kind, symbol, interval, year, month) {
  const monthText = String(month).padStart(2, '0');
  return `${VISION_BASE}/${kind}/${symbol}/${interval}/${symbol}-${interval}-${year}-${monthText}.zip`;
}

function fundingArchiveUrl(symbol, year, month) {
  const monthText = String(month).padStart(2, '0');
  return `${VISION_BASE}/fundingRate/${symbol}/${symbol}-fundingRate-${year}-${monthText}.zip`;
}

function cacheFileFor(url) {
  const cacheDir = process.env.BTC_V3_EXPOSURE_CACHE_DIR || DEFAULT_CACHE_DIR;
  fs.mkdirSync(cacheDir, { recursive: true });
  const key = crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
  return path.join(cacheDir, `${key}.csv`);
}

async function fetchVisionCsv(url) {
  const cacheFile = cacheFileFor(url);
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-v3-ema-sensitivity-'));
  const archivePath = path.join(tempDir, 'archive.zip');
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/zip',
        'User-Agent': 'binance-futures-radar-v3-ema-sensitivity/1.0',
      },
      signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Binance Vision archive ${response.status}: ${url}`);
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
    const csv = execFileSync('unzip', ['-p', archivePath], {
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    });
    fs.writeFileSync(cacheFile, csv);
    return csv;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Binance Vision archive timed out: ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseKlineCsv(csv, intervalMs) {
  if (!csv) return [];
  return csv.split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.split(','))
    .map((row) => ({
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
      intervalMs,
    }))
    .filter((row) => [row.openTime, row.open, row.high, row.low, row.close, row.closeTime]
      .every((value) => Number.isFinite(value)) && row.open > 0 && row.high > 0 && row.low > 0 && row.close > 0)
    .sort((a, b) => a.openTime - b.openTime);
}

function parseFundingCsv(csv) {
  if (!csv) return [];
  const rows = csv.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split(','));
  if (!rows.length) return [];
  const header = rows[0].map((value) => value.trim());
  const timeIndex = header.indexOf('calc_time');
  const intervalIndex = header.indexOf('funding_interval_hours');
  const rateIndex = header.indexOf('last_funding_rate');
  const offset = timeIndex >= 0 && rateIndex >= 0 ? 1 : 0;
  return rows.slice(offset).map((row) => ({
    fundingTime: Number(row[timeIndex >= 0 ? timeIndex : 0]),
    fundingIntervalHours: Number(row[intervalIndex >= 0 ? intervalIndex : 1]),
    fundingRate: Number(row[rateIndex >= 0 ? rateIndex : 2]),
  })).filter((row) => Number.isFinite(row.fundingTime) && Number.isFinite(row.fundingRate));
}

function dedupeByTime(rows, key = 'openTime') {
  const seen = new Set();
  return rows.filter((row) => {
    const value = Number(row[key]);
    if (!Number.isFinite(value) || seen.has(value)) return false;
    seen.add(value);
    return true;
  }).sort((a, b) => Number(a[key]) - Number(b[key]));
}

function validateMonthlyCandles(rows, year, month, intervalMs, { allowPartialStart, allowPartialEnd }) {
  if (!rows.length) return { ok: false, reason: 'empty_archive', maxGapMs: null, missingOpenTimes: [] };
  let maxGapMs = 0;
  const missingOpenTimes = [];
  for (let i = 1; i < rows.length; i += 1) {
    const gap = rows[i].openTime - rows[i - 1].openTime;
    maxGapMs = Math.max(maxGapMs, gap);
    if (gap > intervalMs * 1.5) {
      for (let timestamp = rows[i - 1].openTime + intervalMs; timestamp < rows[i].openTime; timestamp += intervalMs) missingOpenTimes.push(timestamp);
    }
  }
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month, 0, 23, 59, 59, 999);
  const expectedLastOpen = monthEnd - intervalMs + 1;
  if (!allowPartialStart && rows[0].openTime > monthStart) {
    for (let timestamp = monthStart; timestamp < rows[0].openTime; timestamp += intervalMs) missingOpenTimes.push(timestamp);
  }
  if (!allowPartialEnd && rows.at(-1).openTime < expectedLastOpen) {
    for (let timestamp = rows.at(-1).openTime + intervalMs; timestamp <= expectedLastOpen; timestamp += intervalMs) missingOpenTimes.push(timestamp);
  }
  if (missingOpenTimes.length) {
    const reason = missingOpenTimes[0] >= rows.at(-1).openTime ? 'trailing_gap' : `internal_gap_${maxGapMs}ms`;
    return { ok: false, reason, maxGapMs, missingOpenTimes };
  }
  return { ok: true, reason: null, maxGapMs, missingOpenTimes: [] };
}

async function loadVisionSeries({ kind, symbol, interval, intervalMs, startTime, endTime, label }) {
  const months = monthKeys(startTime, endTime);
  const allRows = [];
  const diagnostics = [];
  const batchSize = 8;
  for (let offset = 0; offset < months.length; offset += batchSize) {
    const batch = await Promise.all(months.slice(offset, offset + batchSize).map(async ({ year, month }, batchIndex) => {
      const globalIndex = offset + batchIndex;
      const url = visionArchiveUrl(kind, symbol, interval, year, month);
      const csv = await fetchVisionCsv(url);
      const rows = parseKlineCsv(csv, intervalMs);
      const monthEnd = Date.UTC(year, month, 0, 23, 59, 59, 999);
      const validation = validateMonthlyCandles(rows, year, month, intervalMs, {
        allowPartialStart: globalIndex === 0,
        allowPartialEnd: globalIndex === months.length - 1 && endTime < monthEnd,
      });
      if (!validation.ok && !rows.length) {
        throw new Error(`${label} ${year}-${String(month).padStart(2, '0')} has no usable rows: ${validation.reason}`);
      }
      return { year, month, rows, validation, url };
    }));
    for (const part of batch) {
      allRows.push(...part.rows);
      diagnostics.push({
        month: `${part.year}-${String(part.month).padStart(2, '0')}`,
        rows: part.rows.length,
        maxGapMs: part.validation.maxGapMs,
        partial: !part.validation.ok,
        partialReason: part.validation.reason,
        missingOpenTimes: part.validation.missingOpenTimes,
        url: part.url,
      });
    }
  }
  const candles = dedupeByTime(allRows).filter((row) => row.closeTime <= endTime);
  return {
    label,
    candles,
    interval,
    intervalMs,
    diagnostics,
    partialMonths: diagnostics.filter((item) => item.partial).map((item) => item.month),
    partialReasons: diagnostics.filter((item) => item.partial).map((item) => ({
      month: item.month,
      reason: item.partialReason,
      missingOpenTimes: item.missingOpenTimes.slice(0, 100).map(iso),
    })),
    requestedMonths: months.length,
    firstOpenTime: candles[0]?.openTime || null,
    lastOpenTime: candles.at(-1)?.openTime || null,
  };
}

async function loadFunding(startTime, endTime) {
  const months = monthKeys(startTime, endTime);
  const availableRows = [];
  const availableMonths = [];
  const missingMonths = [];
  const batchSize = 8;
  for (let offset = 0; offset < months.length; offset += batchSize) {
    const batch = await Promise.all(months.slice(offset, offset + batchSize).map(async ({ year, month }) => {
      const url = fundingArchiveUrl(CONFIG.coinMSymbol, year, month);
      const csv = await fetchVisionCsv(url);
      if (csv === null) return { year, month, rows: [], url, missing: true };
      return { year, month, rows: parseFundingCsv(csv), url, missing: false };
    }));
    for (const part of batch) {
      if (part.missing || !part.rows.length) missingMonths.push(`${part.year}-${String(part.month).padStart(2, '0')}`);
      else {
        availableMonths.push(`${part.year}-${String(part.month).padStart(2, '0')}`);
        availableRows.push(...part.rows);
      }
    }
  }
  const funding = dedupeByTime(availableRows, 'fundingTime').filter((row) => row.fundingTime <= endTime);
  return {
    rows: funding,
    source: 'Binance Vision official COIN-M monthly fundingRate archives',
    availableMonths,
    missingMonths,
    firstFundingTime: funding[0]?.fundingTime || null,
    lastFundingTime: funding.at(-1)?.fundingTime || null,
    archivePattern: `https://data.binance.vision/data/futures/cm/monthly/fundingRate/${CONFIG.coinMSymbol}/${CONFIG.coinMSymbol}-fundingRate-YYYY-MM.zip`,
  };
}

function fundingByDay(funding) {
  const result = new Map();
  for (const event of funding) {
    const key = dayStart(event.fundingTime);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(event);
  }
  return result;
}

async function loadMarketData() {
  const startTime = VISION_START_TIME;
  const endTime = requestedEndTime();
  const [indexSeries, executionSeries, markSeries, fundingData] = await Promise.all([
    loadVisionSeries({
      kind: 'indexPriceKlines', symbol: CONFIG.coinMPair, interval: '1d', intervalMs: DAY,
      startTime, endTime, label: 'BTCUSD Index daily signal source',
    }),
    loadVisionSeries({
      kind: 'klines', symbol: CONFIG.coinMSymbol, interval: '1d', intervalMs: DAY,
      startTime, endTime, label: 'BTCUSD_PERP daily execution source',
    }),
    loadVisionSeries({
      kind: 'markPriceKlines', symbol: CONFIG.coinMSymbol, interval: '4h', intervalMs: 4 * HOUR,
      startTime, endTime, label: 'BTCUSD_PERP 4H mark/funding source',
    }),
    loadFunding(startTime, endTime),
  ]);
  const indexDaily = indexSeries.candles;
  const executionDaily = executionSeries.candles;
  const markCandles = markSeries.candles;
  if (!indexDaily.length || !executionDaily.length || !markCandles.length) throw new Error('Required historical series is empty.');
  const executionByOpen = new Map(executionDaily.map((row) => [row.openTime, row]));
  const firstOverlap = indexDaily.find((row) => executionByOpen.has(row.openTime));
  if (!firstOverlap) throw new Error('No overlapping daily index and execution candles.');
  const actualStartTime = firstOverlap.openTime;
  return {
    contract: { ...VISION_CONTRACT, onboardDate: actualStartTime },
    indexDaily,
    executionDaily,
    executionByOpen,
    markCandles,
    funding: fundingData.rows,
    fundingByDay: fundingByDay(fundingData.rows),
    fundingData,
    dataSource: 'Binance Vision official COIN-M monthly archives',
    startTime,
    endTime,
    actualStartTime,
    actualEndTime: Math.min(endTime, indexDaily.at(-1).closeTime, executionDaily.at(-1).closeTime),
    series: { index: indexSeries, execution: executionSeries, mark: markSeries },
  };
}

function nearestClosedMark(markCandles, timestamp) {
  let low = 0;
  let high = markCandles.length - 1;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candle = markCandles[middle];
    if (candle.closeTime <= timestamp) {
      best = candle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best ? best.close : null;
}

function executionPriceAtFunding(executionDaily, timestamp) {
  let low = 0;
  let high = executionDaily.length - 1;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const bar = executionDaily[middle];
    if (bar.openTime <= timestamp) {
      best = bar;
      low = middle + 1;
    } else high = middle - 1;
  }
  const next = executionDaily[low];
  if (best && best.openTime === timestamp) return best.open;
  if (best && timestamp <= best.closeTime) return best.open;
  if (best && (!next || timestamp < next.openTime)) return best.close;
  return next?.open || best?.close || null;
}

function maxDrawdown(values) {
  let peak = -Infinity;
  let worst = 0;
  for (const value of values) {
    if (!(value > 0)) continue;
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, (value / peak) - 1);
  }
  return worst;
}

function annualizedReturn(start, end, days) {
  if (!(start > 0) || !(end > 0) || !(days > 0)) return null;
  return Math.pow(end / start, 365 / days) - 1;
}

function computeSensitivitySignal(closes, emaFast, emaSlow) {
  if (emaFast === CONFIG.emaFast && emaSlow === CONFIG.emaSlow) {
    const productionSignal = computeSignal(closes);
    return {
      ...productionSignal,
      emaFastPeriod: emaFast,
      emaSlowPeriod: emaSlow,
      emaFastValue: productionSignal.ema15,
      emaSlowValue: productionSignal.ema30,
      signalImplementation: 'lib/btc-v3-strategy.js::computeSignal',
    };
  }
  const values = Array.isArray(closes) ? closes.map((value) => numberOr(value, null)) : [];
  const minRequired = Math.max(CONFIG.valuationLookbackDays, CONFIG.maLong + CONFIG.maSlopeDays);
  if (values.length < minRequired || values.some((value) => value === null || value <= 0)) {
    return { ready: false, reason: `need_at_least_${minRequired}_valid_closed_daily_closes`, version: CONFIG.version };
  }
  const lastIndex = values.length - 1;
  const close = values[lastIndex];
  const fast = emaSeries(values, emaFast)[lastIndex];
  const slow = emaSeries(values, emaSlow)[lastIndex];
  const ma200 = smaAt(values, CONFIG.maLong, lastIndex);
  const ma200Past = smaAt(values, CONFIG.maLong, lastIndex - CONFIG.maSlopeDays);
  const ma200Slope30 = ma200Past && ma200Past > 0 ? (ma200 / ma200Past) - 1 : null;
  const drawdown365 = trailingDrawdown(values, CONFIG.valuationLookbackDays);
  const ma200Deviation = ma200 ? (close / ma200) - 1 : null;
  const rv30 = realizedVol(values, CONFIG.volLookbackDays);
  const aboveMa200 = close > ma200;
  const emaBull = fast > slow;
  const maSlopePositive = ma200Slope30 > 0;
  const trendScore = Number(aboveMa200) + Number(emaBull) + Number(maSlopePositive);
  const regimeTarget = [0.50, 0.75, 1.00, 1.25][trendScore];
  const bearLock = !aboveMa200 && ma200Slope30 < 0;
  const cheap = drawdown365 <= CONFIG.cheapDrawdown || ma200Deviation <= CONFIG.cheapMaDeviation;
  const veryCheap = drawdown365 <= CONFIG.veryCheapDrawdown || ma200Deviation <= CONFIG.veryCheapMaDeviation;
  let valuationAdjustedTarget = regimeTarget;
  if (trendScore === 2 && cheap) valuationAdjustedTarget = Math.max(valuationAdjustedTarget, 1.25);
  if (trendScore === 3 && cheap) valuationAdjustedTarget = Math.max(valuationAdjustedTarget, 1.50);
  if (trendScore === 3 && veryCheap) valuationAdjustedTarget = Math.max(valuationAdjustedTarget, 2.00);
  if (bearLock) valuationAdjustedTarget = 0;
  const volatilityCap = rv30 > 0
    ? clamp(CONFIG.targetAnnualVol / rv30, CONFIG.minVolCap, CONFIG.maxSignalExposure)
    : CONFIG.minVolCap;
  const rawSignalTarget = bearLock ? 0 : Math.min(valuationAdjustedTarget, volatilityCap, CONFIG.maxSignalExposure);
  const marginCap = CONFIG.publicMarginCap;
  const finalTarget = Math.min(rawSignalTarget, marginCap);
  return {
    ready: true,
    version: CONFIG.version,
    close,
    emaFastPeriod: emaFast,
    emaSlowPeriod: emaSlow,
    emaFastValue: fast,
    emaSlowValue: slow,
    ma200,
    ma200Past,
    ma200Slope30,
    drawdown365,
    ma200Deviation,
    rv30,
    aboveMa200,
    emaBull,
    maSlopePositive,
    trendScore,
    bearLock,
    cheap,
    veryCheap,
    regimeTarget,
    valuationAdjustedTarget,
    volatilityCap,
    rawSignalTarget,
    marginCap,
    finalTarget,
    tactical2xRequested: rawSignalTarget > CONFIG.publicMarginCap,
    dataQualityFlags: !Number.isFinite(rv30) ? ['rv30_unavailable'] : [],
    autoTrade: false,
    signalImplementation: 'research-local copy of frozen V3.1 formula; only EMA periods differ',
  };
}

function markTo(state, toPrice) {
  if (!Number.isFinite(toPrice) || toPrice <= 0) throw new Error(`Invalid mark price ${toPrice}`);
  if (state.lastPrice !== null && state.contracts !== 0) {
    const pnl = inversePnlBtc(state.contracts, state.contractSize, state.lastPrice, toPrice);
    if (!Number.isFinite(pnl)) throw new Error('Non-finite mark-to-market PnL.');
    state.equityBtc += pnl;
  }
  state.lastPrice = toPrice;
}

function applyTrade(state, newContracts, referencePrice) {
  const delta = newContracts - state.contracts;
  if (delta === 0) return null;
  const slip = SLIPPAGE_BPS / 10000;
  const fillPrice = referencePrice * (delta > 0 ? 1 + slip : 1 - slip);
  const slippagePnl = inversePnlBtc(delta, state.contractSize, fillPrice, referencePrice);
  if (!(slippagePnl <= 1e-12)) throw new Error(`Adverse slippage improved PnL: ${slippagePnl}`);
  const fee = Math.abs(delta) * state.contractSize / fillPrice * (FEE_BPS / 10000);
  state.equityBtc += slippagePnl;
  state.equityBtc -= fee;
  state.feesBtc += fee;
  state.slippageCostBtc += Math.max(0, -slippagePnl);
  state.turnoverUsd += Math.abs(delta) * state.contractSize;
  state.contracts = newContracts;
  state.tradeCount += 1;
  return { delta, fillPrice, fee, slippagePnl };
}

function processFunding(state, event, market) {
  state.fundingEventCount += 1;
  if (state.contracts === 0) return;
  const mark = nearestClosedMark(market.markCandles, event.fundingTime)
    || executionPriceAtFunding(market.executionDaily, event.fundingTime);
  if (!(mark > 0)) throw new Error(`No point-in-time mark for funding at ${iso(event.fundingTime)}`);
  if (!nearestClosedMark(market.markCandles, event.fundingTime)) state.fundingMarkFallbackCount += 1;
  markTo(state, mark);
  const pnl = fundingPnlBtc(state.contracts, state.contractSize, mark, event.fundingRate);
  if (!Number.isFinite(pnl)) throw new Error(`Non-finite funding PnL at ${iso(event.fundingTime)}`);
  state.equityBtc += pnl;
  state.fundingPnlBtc += pnl;
  state.fundingAppliedEventCount += 1;
}

function countStateSwitches(rows, field) {
  let switches = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index][field] !== rows[index - 1][field]) switches += 1;
  }
  return switches;
}

function countEpisodes(rows, field, value = true) {
  let episodes = 0;
  let active = false;
  for (const row of rows) {
    const matches = row[field] === value;
    if (matches && !active) episodes += 1;
    active = matches;
  }
  return episodes;
}

function countShortLivedStateEpisodes(rows, field, maxDays = 30) {
  if (!rows.length) return 0;
  let episodes = 0;
  let startIndex = 0;
  for (let index = 1; index <= rows.length; index += 1) {
    const changed = index === rows.length || rows[index][field] !== rows[startIndex][field];
    if (!changed) continue;
    const isInterior = startIndex > 0 && index < rows.length;
    const durationDays = (rows[index - 1].timestamp - rows[startIndex].timestamp) / DAY + 1;
    if (isInterior && durationDays <= maxDays) episodes += 1;
    startIndex = index;
  }
  return episodes;
}

function closeAtOrAfter(indexDaily, timestamp, endTime) {
  for (const row of indexDaily) {
    if (row.openTime >= timestamp && row.openTime <= endTime) return row.close;
  }
  return null;
}

function missedBigTrendDiagnostics(signalRows, indexDaily, endTime) {
  const qualifying = signalRows.filter((row) => {
    const futureClose = closeAtOrAfter(indexDaily, row.timestamp + 30 * DAY, endTime);
    return futureClose !== null && futureClose / row.close - 1 >= 0.20 && !row.emaBull;
  });
  let episodes = 0;
  let previous = null;
  for (const row of qualifying) {
    if (previous === null || row.timestamp - previous > DAY * 1.5) episodes += 1;
    previous = row.timestamp;
  }
  return {
    missedBigTrendDays: qualifying.length,
    missedBigTrendEpisodes: episodes,
    definition: 'Diagnostic only: signal day with next available 30D Index close return >= +20% while EMA fast <= EMA slow; future data is never used for execution.',
  };
}

function fundingCoverage(market, period) {
  const inPeriod = market.funding.filter((event) => event.fundingTime >= period.startTime && event.fundingTime <= period.endTime);
  const firstAvailable = market.fundingData.firstFundingTime;
  const intervalHours = modeOf(
    market.funding
      .filter((event) => event.fundingTime >= Math.max(period.startTime - 90 * DAY, firstAvailable || period.startTime)
        && event.fundingTime <= period.endTime)
      .map((event) => numberOr(event.fundingIntervalHours, 8)),
    8,
  );
  const intervalMs = intervalHours * HOUR;
  const availableFrom = firstAvailable === null ? null : Math.max(period.startTime, firstAvailable);
  const expectedStart = availableFrom === null ? null : Math.ceil(availableFrom / intervalMs) * intervalMs;
  const expectedEnd = availableFrom === null ? null : Math.floor(period.endTime / intervalMs) * intervalMs;
  const expectedEvents = expectedStart !== null && expectedEnd >= expectedStart
    ? Math.floor((expectedEnd - expectedStart) / intervalMs) + 1
    : 0;
  const slots = new Set(inPeriod.map((event) => Math.round(event.fundingTime / intervalMs) * intervalMs));
  const missingSlots = [];
  if (expectedStart !== null) {
    for (let timestamp = expectedStart; timestamp <= expectedEnd; timestamp += intervalMs) {
      if (!slots.has(timestamp)) missingSlots.push(timestamp);
    }
  }
  const periodMonths = new Set(monthKeys(period.startTime, period.endTime).map(({ year, month }) => `${year}-${String(month).padStart(2, '0')}`));
  const missingMonths = market.fundingData.missingMonths.filter((month) => periodMonths.has(month));
  const status = expectedEvents > 0 && missingSlots.length === 0 && missingMonths.length === 0 && firstAvailable <= period.startTime
    ? 'complete'
    : inPeriod.length || missingMonths.length || firstAvailable !== null ? 'partial' : 'unavailable';
  return {
    status,
    periodStart: dateOnly(period.startTime),
    periodEnd: dateOnly(period.endTime),
    availableFrom: firstAvailable === null ? null : dateOnly(firstAvailable),
    availableTo: market.fundingData.lastFundingTime === null ? null : dateOnly(market.fundingData.lastFundingTime),
    intervalHours,
    availableEvents: inPeriod.length,
    expectedEvents,
    eventCoverageRatio: expectedEvents ? inPeriod.length / expectedEvents : 0,
    missingSlotCount: missingSlots.length,
    missingSlots: missingSlots.slice(0, 100).map(iso),
    missingMonths,
    noZeroImputation: true,
    note: 'Unknown Funding periods are not filled with synthetic zero rates; the simulated equity is partial where official records are absent.',
  };
}

function modeOf(values, fallback) {
  if (!values.length) return fallback;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function periodDefinitions(market) {
  const effectiveEnd = Math.min(market.endTime, market.actualEndTime);
  return [
    { name: 'full', startTime: market.actualStartTime, endTime: effectiveEnd },
    { name: 'inSample', startTime: market.actualStartTime, endTime: Math.min(IN_SAMPLE_END, effectiveEnd) },
    { name: 'outOfSample', startTime: Math.max(OUT_OF_SAMPLE_START, market.actualStartTime), endTime: effectiveEnd },
  ].filter((period) => period.endTime >= period.startTime);
}

function runVariant(variant, market, period) {
  const bars = market.indexDaily
    .filter((indexCandle) => indexCandle.openTime >= period.startTime && indexCandle.openTime <= period.endTime)
    .map((indexCandle) => ({ indexCandle, execution: market.executionByOpen.get(indexCandle.openTime) }))
    .filter((row) => row.execution);
  if (!bars.length) throw new Error(`No paired daily bars for ${variant.name} ${period.name}`);

  const closes = market.indexDaily
    .filter((row) => row.openTime < period.startTime && row.closeTime < period.startTime)
    .map((row) => row.close);
  const state = {
    equityBtc: 1,
    contracts: 0,
    contractSize: market.contract.contractSize,
    lastPrice: null,
    feesBtc: 0,
    slippageCostBtc: 0,
    fundingPnlBtc: 0,
    fundingEventCount: 0,
    fundingAppliedEventCount: 0,
    fundingMarkFallbackCount: 0,
    turnoverUsd: 0,
    tradeCount: 0,
    btcNav: [],
    usdNav: [],
    dailyRows: [],
    signalRows: [],
    liquidated: false,
  };

  for (const { indexCandle, execution } of bars) {
    if (state.lastPrice !== null) markTo(state, execution.open);
    for (const event of (market.fundingByDay.get(indexCandle.openTime) || [])
      .filter((item) => item.fundingTime <= indexCandle.openTime)) processFunding(state, event, market);
    if (state.lastPrice !== execution.open) markTo(state, execution.open);

    const signal = computeSensitivitySignal(closes, variant.emaFast, variant.emaSlow);
    const targetExposure = signal.ready ? signal.finalTarget : 1;
    const sizing = targetContracts({
      targetExposure,
      equityBtc: state.equityBtc,
      price: execution.open,
      contractSizeUsd: state.contractSize,
      currentContracts: state.contracts,
    });
    if (!sizing) throw new Error(`Unable to size ${variant.name} at ${dateOnly(indexCandle.openTime)}`);
    applyTrade(state, sizing.signedContracts, execution.open);

    const worstPrice = state.contracts >= 0 ? execution.low : execution.high;
    const stressedEquity = state.equityBtc + inversePnlBtc(state.contracts, state.contractSize, execution.open, worstPrice);
    const stress = maintenanceHeadroom({
      equityBtc: stressedEquity,
      signedContracts: state.contracts,
      contractSizeUsd: state.contractSize,
      markPrice: worstPrice,
      maintenanceRate: STRESS_MAINTENANCE_RATE,
    });
    if (!stress || !stress.passes || !(stressedEquity > 0)) {
      state.liquidated = true;
      break;
    }

    for (const event of (market.fundingByDay.get(indexCandle.openTime) || [])
      .filter((item) => item.fundingTime > indexCandle.openTime && item.fundingTime <= execution.closeTime)) processFunding(state, event, market);
    markTo(state, execution.close);
    if (!(state.equityBtc > 0)) {
      state.liquidated = true;
      break;
    }
    closes.push(indexCandle.close);
    const navUsd = state.equityBtc * execution.close;
    const exposure = 1 + ((state.contracts * state.contractSize) / execution.close) / state.equityBtc;
    state.btcNav.push(state.equityBtc);
    state.usdNav.push(navUsd);
    state.signalRows.push({
      timestamp: indexCandle.openTime,
      close: indexCandle.close,
      emaBull: signal.ready ? signal.emaBull : null,
      trendScore: signal.ready ? signal.trendScore : null,
      bearLock: signal.ready ? signal.bearLock : false,
      finalTarget: targetExposure,
    });
    state.dailyRows.push({
      date: dateOnly(indexCandle.openTime),
      timestamp: indexCandle.openTime,
      indexClose: indexCandle.close,
      executionOpen: execution.open,
      executionClose: execution.close,
      equityBtc: state.equityBtc,
      navUsd,
      exposure,
      contracts: state.contracts,
      targetExposure,
      trendScore: signal.ready ? signal.trendScore : null,
      bearLock: signal.ready ? signal.bearLock : false,
      emaBull: signal.ready ? signal.emaBull : null,
      emaFastValue: signal.ready ? signal.emaFastValue : null,
      emaSlowValue: signal.ready ? signal.emaSlowValue : null,
    });
  }

  const firstBar = bars[0].execution;
  const lastRow = state.dailyRows.at(-1);
  const lastBar = lastRow ? market.executionByOpen.get(lastRow.timestamp) : firstBar;
  const periodDays = Math.max(1 / 365, ((lastBar?.closeTime || firstBar.closeTime) - firstBar.openTime + 1) / DAY);
  const signalRows = state.signalRows.filter((row) => row.emaBull !== null);
  const trendScoreSwitches = countStateSwitches(signalRows, 'trendScore');
  const emaBullSwitches = countStateSwitches(signalRows, 'emaBull');
  const bearLockDays = signalRows.filter((row) => row.bearLock).length;
  const diagnostics = missedBigTrendDiagnostics(signalRows, market.indexDaily, period.endTime);
  const startingUsd = firstBar.open;
  const endingBtc = state.equityBtc;
  const endingUsd = endingBtc * (lastRow?.executionClose || firstBar.close);
  const averageExposure = state.dailyRows.length
    ? state.dailyRows.reduce((sum, row) => sum + row.exposure, 0) / state.dailyRows.length
    : null;
  const maxExposure = state.dailyRows.length ? Math.max(...state.dailyRows.map((row) => row.exposure)) : null;
  return {
    name: variant.name,
    label: variant.label,
    emaFast: variant.emaFast,
    emaSlow: variant.emaSlow,
    period: period.name,
    startDate: dateOnly(firstBar.openTime),
    endDate: lastRow?.date || dateOnly(firstBar.openTime),
    days: periodDays,
    startingBtc: 1,
    endingBtc,
    endingUsd,
    btcCagr: annualizedReturn(1, endingBtc, periodDays),
    usdCagr: annualizedReturn(startingUsd, endingUsd, periodDays),
    btcMaxDrawdown: maxDrawdown(state.btcNav),
    usdMaxDrawdown: maxDrawdown(state.usdNav),
    averageExposure,
    maxExposure,
    turnoverUsd: state.turnoverUsd,
    feesBtc: state.feesBtc,
    fundingPnlBtc: state.fundingPnlBtc,
    slippageBtc: state.slippageCostBtc,
    tradeCount: state.tradeCount,
    trendScoreSwitches,
    emaBullSwitches,
    emaWhipsawEpisodes: countShortLivedStateEpisodes(signalRows, 'emaBull', 30),
    bearLockEpisodes: countEpisodes(signalRows, 'bearLock', true),
    bearLockDays,
    missedBigTrendDays: diagnostics.missedBigTrendDays,
    missedBigTrendEpisodes: diagnostics.missedBigTrendEpisodes,
    liquidated: state.liquidated,
    fundingEventCount: state.fundingEventCount,
    fundingAppliedEventCount: state.fundingAppliedEventCount,
    fundingMarkFallbackCount: state.fundingMarkFallbackCount,
    fundingCoverage: fundingCoverage(market, period),
    diagnosticDefinitions: { missedBigTrend: diagnostics.definition, emaWhipsaw: 'Interior EMA bull/bear state segment lasting <=30 calendar days.' },
  };
}

function periodDelta(current, baseline) {
  return {
    endingBtc: current.endingBtc - baseline.endingBtc,
    btcCagr: current.btcCagr - baseline.btcCagr,
    usdCagr: current.usdCagr - baseline.usdCagr,
    btcMaxDrawdown: current.btcMaxDrawdown - baseline.btcMaxDrawdown,
    usdMaxDrawdown: current.usdMaxDrawdown - baseline.usdMaxDrawdown,
    averageExposure: current.averageExposure - baseline.averageExposure,
    turnoverUsd: current.turnoverUsd - baseline.turnoverUsd,
    feesBtc: current.feesBtc - baseline.feesBtc,
    fundingPnlBtc: current.fundingPnlBtc - baseline.fundingPnlBtc,
    slippageBtc: current.slippageBtc - baseline.slippageBtc,
    tradeCount: current.tradeCount - baseline.tradeCount,
    trendScoreSwitches: current.trendScoreSwitches - baseline.trendScoreSwitches,
    emaBullSwitches: current.emaBullSwitches - baseline.emaBullSwitches,
    emaWhipsawEpisodes: current.emaWhipsawEpisodes - baseline.emaWhipsawEpisodes,
    bearLockEpisodes: current.bearLockEpisodes - baseline.bearLockEpisodes,
    bearLockDays: current.bearLockDays - baseline.bearLockDays,
    missedBigTrendDays: current.missedBigTrendDays - baseline.missedBigTrendDays,
    missedBigTrendEpisodes: current.missedBigTrendEpisodes - baseline.missedBigTrendEpisodes,
  };
}

function addBaselineComparisons(variants) {
  const baseline = variants.find((variant) => variant.name === 'ema15_30');
  if (!baseline) throw new Error('EMA15/EMA30 baseline missing.');
  for (const variant of variants) {
    variant.periods = Object.fromEntries(Object.entries(variant.periods).map(([periodName, current]) => {
      const reference = baseline.periods[periodName];
      return [periodName, { ...current, deltaVsBaseline: periodDelta(current, reference) }];
    }));
  }
  return variants;
}

function pctReduction(base, candidate) {
  return base > 0 ? 1 - (candidate / base) : null;
}

function rankBy(variants, periodName, field) {
  return [...variants].sort((a, b) => b.periods[periodName][field] - a.periods[periodName][field]);
}

function classifySensitivity(variants, dataQuality) {
  const oosByEnding = rankBy(variants, 'outOfSample', 'endingBtc');
  const oosByCagr = rankBy(variants, 'outOfSample', 'btcCagr');
  const topEnding = oosByEnding[0];
  const topCagr = oosByCagr[0];
  const endingSpread = oosByEnding[0].periods.outOfSample.endingBtc - oosByEnding.at(-1).periods.outOfSample.endingBtc;
  const cagrSpread = oosByCagr[0].periods.outOfSample.btcCagr - oosByCagr.at(-1).periods.outOfSample.btcCagr;
  const materialEndingBtc = 0.02;
  const materialCagr = 0.02;
  const anyLiquidated = variants.some((variant) => Object.values(variant.periods).some((period) => period.liquidated));
  let label = 'inconclusive';
  if (!anyLiquidated && endingSpread <= materialEndingBtc && cagrSpread <= materialCagr) label = 'no_material_difference';
  else if (!anyLiquidated && topEnding.name === topCagr.name
    && (topEnding.periods.outOfSample.endingBtc - oosByEnding[1].periods.outOfSample.endingBtc >= materialEndingBtc
      || topCagr.periods.outOfSample.btcCagr - oosByCagr[1].periods.outOfSample.btcCagr >= materialCagr)) {
    if (topEnding.name === 'ema15_30') label = '15_30_preferred';
    else if (topEnding.name === 'ema20_60') label = '20_60_preferred';
  }
  const oosFundingPartial = variants.some((variant) => variant.periods.outOfSample.fundingCoverage.status !== 'complete');
  return {
    label,
    materiality: {
      endingBtcSpreadThreshold: materialEndingBtc,
      cagrSpreadThreshold: materialCagr,
      note: 'Predeclared before evaluating results; not an EMA tuning target.',
    },
    oosWinnerByEndingBtc: topEnding.name,
    oosWinnerByBtcCagr: topCagr.name,
    oosEndingBtcSpread: endingSpread,
    oosBtcCagrSpread: cagrSpread,
    anyLiquidated,
    oosFundingPartial,
    rule: 'Preferred requires the same candidate to lead OOS ending BTC and BTC CAGR with a material margin; if the spread is immaterial, classify no_material_difference; otherwise classify inconclusive. A winner among the unapproved EMA20/50 or EMA10/30 variants cannot be promoted to a preferred label.',
    labelsAllowed: ['15_30_preferred', '20_60_preferred', 'no_material_difference', 'inconclusive'],
    dataQualityCaveat: dataQuality.funding.oosStatus !== 'complete'
      ? 'Funding coverage is partial; relative EMA comparison is still reported, but absolute returns are not a complete all-events Funding result.'
      : null,
  };
}

function buildSensitivityAnalysis(variants) {
  const base = variants.find((variant) => variant.name === 'ema15_30');
  const slow = variants.find((variant) => variant.name === 'ema20_60');
  const oosBase = base.periods.outOfSample;
  const oosSlow = slow.periods.outOfSample;
  return {
    ema20_60Whipsaw: {
      oos: {
        baselineEmaBullSwitches: oosBase.emaBullSwitches,
        ema20_60EmaBullSwitches: oosSlow.emaBullSwitches,
        switchDelta: oosSlow.emaBullSwitches - oosBase.emaBullSwitches,
        switchReduction: pctReduction(oosBase.emaBullSwitches, oosSlow.emaBullSwitches),
        baselineWhipsawEpisodes: oosBase.emaWhipsawEpisodes,
        ema20_60WhipsawEpisodes: oosSlow.emaWhipsawEpisodes,
        whipsawEpisodeDelta: oosSlow.emaWhipsawEpisodes - oosBase.emaWhipsawEpisodes,
        whipsawReduction: pctReduction(oosBase.emaWhipsawEpisodes, oosSlow.emaWhipsawEpisodes),
        materiallyFewerWhipsaws: oosSlow.emaBullSwitches <= oosBase.emaBullSwitches * 0.8
          && oosSlow.emaWhipsawEpisodes <= oosBase.emaWhipsawEpisodes * 0.8,
      },
      definition: 'Whipsaw is an interior EMA bull/bear state lasting no more than 30 days; switch counts include every EMA state transition.',
    },
    slowerTrendTradeoff: {
      oos: {
        baselineMissedBigTrendDays: oosBase.missedBigTrendDays,
        ema20_60MissedBigTrendDays: oosSlow.missedBigTrendDays,
        missedBigTrendDayDelta: oosSlow.missedBigTrendDays - oosBase.missedBigTrendDays,
        baselineMissedBigTrendEpisodes: oosBase.missedBigTrendEpisodes,
        ema20_60MissedBigTrendEpisodes: oosSlow.missedBigTrendEpisodes,
        missedBigTrendEpisodeDelta: oosSlow.missedBigTrendEpisodes - oosBase.missedBigTrendEpisodes,
        slowerAppearsToMissMoreTrend: oosSlow.missedBigTrendDays > oosBase.missedBigTrendDays,
      },
      definition: 'A missed big trend is an ex-post diagnostic: next available 30D Index return >= +20% while the EMA fast is not above the EMA slow. It is not used by the signal.',
    },
    baselineReturnContext: {
      oosVsEma20_60: {
        endingBtcDelta: oosBase.endingBtc - oosSlow.endingBtc,
        btcCagrDelta: oosBase.btcCagr - oosSlow.btcCagr,
        averageExposureDelta: oosBase.averageExposure - oosSlow.averageExposure,
        turnoverUsdDelta: oosBase.turnoverUsd - oosSlow.turnoverUsd,
        tradeCountDelta: oosBase.tradeCount - oosSlow.tradeCount,
        feesBtcDelta: oosBase.feesBtc - oosSlow.feesBtc,
        slippageBtcDelta: oosBase.slippageBtc - oosSlow.slippageBtc,
        fundingPnlBtcDelta: oosBase.fundingPnlBtc - oosSlow.fundingPnlBtc,
        note: 'These are accounting differences, not additive causal attribution. Inverse PnL, integer sizing, costs and exposure compound together; no extra cost-free or exposure-matched EMA search was run.',
      },
    },
  };
}

function percent(value, digits = 2) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'n/a';
}

function number(value, digits = 6) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function renderMetricsTable(variants, periodName) {
  const lines = [
    `### ${periodName === 'inSample' ? '2020–2023' : periodName === 'outOfSample' ? '2024–2026 OOS' : 'Full sample'}`,
    '',
    '| EMA | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | avg/max exposure | turnover USD | fees BTC | funding PnL BTC | slippage cost BTC | trades | trendScore switches | Bear Lock episodes/days |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const variant of variants) {
    const result = variant.periods[periodName];
    lines.push(`| ${variant.label} | ${number(result.endingBtc)} | ${percent(result.btcCagr)} | ${percent(result.usdCagr)} | ${percent(result.btcMaxDrawdown)} | ${percent(result.usdMaxDrawdown)} | ${number(result.averageExposure, 3)} / ${number(result.maxExposure, 3)} | ${number(result.turnoverUsd, 0)} | ${number(result.feesBtc)} | ${number(result.fundingPnlBtc)} | ${number(result.slippageBtc)} | ${result.tradeCount} | ${result.trendScoreSwitches} | ${result.bearLockEpisodes} / ${result.bearLockDays} |`);
  }
  return lines.join('\n');
}

function renderReport(result) {
  const classification = result.classification.label;
  const verdict = {
    '15_30_preferred': '在预先声明的材料性门槛下，EMA15/EMA30 在 OOS 同时领先 ending BTC 与 BTC CAGR；当前 V3.1 参数更合适。',
    '20_60_preferred': '在预先声明的材料性门槛下，EMA20/EMA60 在 OOS 同时领先 ending BTC 与 BTC CAGR；较慢 EMA 更合适。',
    'no_material_difference': '四组 EMA 的 OOS 差异未达到预先声明的材料性门槛，不能据此宣称某一组更合适。',
    inconclusive: '结果没有形成足够清晰且同向的 OOS 优势，不能据此更换当前 EMA 参数。',
  }[classification];
  const freezeRows = [
    ['EMA fast/slow', '仅测试 15/30、20/60、20/50、10/30'],
    ['MA200 / slope', `${CONFIG.maLong}D / ${CONFIG.maSlopeDays}D`],
    ['Valuation', `trailing drawdown lookback ${CONFIG.valuationLookbackDays}D; cheap ${percent(CONFIG.cheapDrawdown)} / MA deviation ${percent(CONFIG.cheapMaDeviation)}; very cheap ${percent(CONFIG.veryCheapDrawdown)} / ${percent(CONFIG.veryCheapMaDeviation)}`],
    ['Volatility / margin', `RV${CONFIG.volLookbackDays}; target annual vol ${percent(CONFIG.targetAnnualVol)}; margin cap ${CONFIG.publicMarginCap}x`],
    ['Execution costs', `fee ${result.assumptions.feeBps} bps; slippage ${result.assumptions.slippageBps} bps; maintenance stress ${percent(result.assumptions.stressMaintenanceRate)}`],
  ].map(([key, value]) => `| ${key} | ${value} |`).join('\n');
  const comparison = result.sensitivityAnalysis.baselineReturnContext.oosVsEma20_60;
  const w = result.sensitivityAnalysis.ema20_60Whipsaw.oos;
  const t = result.sensitivityAnalysis.slowerTrendTradeoff.oos;
  return `# BTC V3.1 EMA 参数敏感性测试

> Research-only。没有修改 main、V3 生产策略或生产环境；参数敏感性不是参数优化。

## 结论

**${classification}**

${verdict}

- OOS window: **${result.dataWindow.outOfSample.startDate} 至 ${result.dataWindow.outOfSample.endDate}**。
- OOS winner by ending BTC: **${result.classification.oosWinnerByEndingBtc}**；by BTC CAGR: **${result.classification.oosWinnerByBtcCagr}**。
- OOS ending-BTC spread: **${number(result.classification.oosEndingBtcSpread)} BTC**；CAGR spread: **${percent(result.classification.oosBtcCagrSpread)}**。
- 直接比较当前 baseline 与 EMA20/60：15/30 的 OOS ending BTC 高 **${number(result.sensitivityAnalysis.baselineReturnContext.oosVsEma20_60.endingBtcDelta)} BTC**、BTC CAGR 高 **${percent(result.sensitivityAnalysis.baselineReturnContext.oosVsEma20_60.btcCagrDelta)}**；但 EMA20/60 的 whipsaw 明显更少。由于 EMA10/30 在 OOS 反而排名第一，严格分类仍为 **inconclusive**，不据此改生产参数。
- 判定规则：${result.classification.rule}

## 冻结边界

| 参数 | 处理 |
|---|---|
${freezeRows}

EMA15/EMA30 是当前 V3.1 baseline。除 EMA fast/slow 外，所有信号门槛、估值、RV30、margin cap、fee、slippage、Funding 处理和执行时点均保持一致；没有根据 OOS 结果继续调 EMA。

## 回测数据与执行模型

- 数据：Binance Vision 官方 COIN-M 月档；Index daily、BTCUSD_PERP execution daily、BTCUSD_PERP mark 4H、官方 fundingRate。Index partial months: **${result.dataQuality.index.partialMonths.join(', ') || 'none'}**；execution partial months: **${result.dataQuality.execution.partialMonths.join(', ') || 'none'}**；mark partial months: **${result.dataQuality.mark.partialMonths.join(', ') || 'none'}**。
- 执行：T-1 fully closed Index daily close 产生信号，T 日永续开盘立即调仓；逆向 COIN-M PnL、整数合约、5 bps fee、5 bps adverse slippage。
- Funding：只记官方可取得的真实记录；${result.dataQuality.funding.oosStatus === 'complete' ? 'OOS 覆盖完整。' : '存在缺口，缺失事件没有补成 0；因此绝对收益带有 partial-Funding 限制。'}
- 三段指标分别以 1 BTC、空头寸开始；OOS 的指标 warm-up 使用 2024-01-01 之前已关闭的历史 close，但不把 IS 资本或仓位带入 OOS。
- 未来函数：信号只使用当前执行日开盘前已关闭的 Index daily close；当前日 OHLC 仅用于执行、Funding mark 和维护保证金压力测试。
- 同一持仓的 mark-to-market 按价格事件顺序只结算一次；成交只改变仓位并记 fee/slippage，不重复结算同一段价格。

${renderMetricsTable(result.variants, 'full')}

${renderMetricsTable(result.variants, 'inSample')}

${renderMetricsTable(result.variants, 'outOfSample')}

## EMA20/60 是否减少 whipsaw

- OOS EMA 状态切换：15/30 **${w.baselineEmaBullSwitches}** 次，20/60 **${w.ema20_60EmaBullSwitches}** 次，变化 **${w.switchDelta}** 次（${percent(w.switchReduction)}）。
- OOS 短状态 whipsaw episode：15/30 **${w.baselineWhipsawEpisodes}**，20/60 **${w.ema20_60WhipsawEpisodes}**，变化 **${w.whipsawEpisodeDelta}**（${percent(w.whipsawReduction)}）。
- 预先定义的“明显减少”标准是两项都至少减少 20%；本次结果：**${w.materiallyFewerWhipsaws ? '达到' : '未达到'}**。

## 更慢是否错过大趋势

- 诊断定义：未来 30D Index close return 至少 +20%，而当日 EMA fast 不高于 EMA slow；这是事后诊断，不参与交易。
- OOS missed-big-trend days：15/30 **${t.baselineMissedBigTrendDays}**，20/60 **${t.ema20_60MissedBigTrendDays}**，变化 **${t.missedBigTrendDayDelta}**；episodes 变化 **${t.missedBigTrendEpisodeDelta}**。
- 结论：EMA20/60 **${t.slowerAppearsToMissMoreTrend ? '显示出更慢反应导致错过更多大趋势的迹象' : '没有显示出更多错过大趋势的迹象'}**。

## 15/30 的额外收益是否只是更高换手或 exposure

相对 EMA20/60 的 OOS accounting context：

| 项目 | 15/30 - 20/60 |
|---|---:|
| ending BTC | ${number(comparison.endingBtcDelta)} |
| BTC CAGR | ${percent(comparison.btcCagrDelta)} |
| average exposure | ${number(comparison.averageExposureDelta, 4)} |
| turnover USD | ${number(comparison.turnoverUsdDelta, 0)} |
| trade count | ${comparison.tradeCountDelta} |
| fee cost BTC | ${number(comparison.feesBtcDelta)} |
| slippage cost BTC | ${number(comparison.slippageBtcDelta)} |
| funding PnL BTC | ${number(comparison.fundingPnlBtcDelta)} |

这些是并行记账差异，不能机械相加为 ending-BTC 差异：逆向合约 PnL、整数合约、Funding、成本和仓位会复利耦合。若 15/30 的优势同时伴随更高 average exposure / turnover，只能说收益与更积极执行相伴，不能声称优势来自 EMA 本身的纯信号质量。

## 数据限制与交付

- Funding OOS status: **${result.dataQuality.funding.oosStatus}**；available ${result.dataQuality.funding.oosAvailableEvents} / expected ${result.dataQuality.funding.expectedEvents} events，coverage ${percent(result.dataQuality.funding.eventCoverageRatio)}，missing slots ${result.dataQuality.funding.missingSlotCount}。
- 官方月档存在的日线 partial gap 会保留可用行并单独列出，不会被静默补齐；execution gaps: ${result.dataQuality.execution.partialReasons.map((item) => `${item.month} ${item.reason} ${item.missingOpenTimes.join(', ')}`).join('; ') || 'none'}。这些 gaps 不改变执行模型，但会造成对应日期缺测。
- Funding archive gaps: ${result.dataQuality.funding.missingMonths.filter((month) => month >= result.dataWindow.outOfSample.startDate).join(', ') || 'none'}；已存在月档中的规律性缺口以 missing slot count 单独统计。
- 研究分支只新增敏感性测试脚本、测试和结果；未修改生产 lib/btc-v3-strategy.js。
- 结果 JSON：research/btc-v3-ema-sensitivity-result.json
- 本报告：research/btc-v3-ema-sensitivity-report.md
`;
}

async function main() {
  const market = await loadMarketData();
  const periods = periodDefinitions(market);
  const variants = EMA_VARIANTS.map((variant) => ({
    ...variant,
    periods: Object.fromEntries(periods.map((period) => [period.name, runVariant(variant, market, period)])),
  }));
  addBaselineComparisons(variants);
  const oosFunding = variants[0].periods.outOfSample.fundingCoverage;
  const dataQuality = {
    index: {
      source: market.series.index.label,
      interval: market.series.index.interval,
      rows: market.indexDaily.length,
      firstDate: dateOnly(market.indexDaily[0].openTime),
      lastDate: dateOnly(market.indexDaily.at(-1).openTime),
      partialMonths: market.series.index.partialMonths,
      partialReasons: market.series.index.partialReasons,
    },
    execution: {
      source: market.series.execution.label,
      interval: market.series.execution.interval,
      rows: market.executionDaily.length,
      firstDate: dateOnly(market.executionDaily[0].openTime),
      lastDate: dateOnly(market.executionDaily.at(-1).openTime),
      partialMonths: market.series.execution.partialMonths,
      partialReasons: market.series.execution.partialReasons,
    },
    mark: {
      source: market.series.mark.label,
      interval: market.series.mark.interval,
      rows: market.markCandles.length,
      firstDate: dateOnly(market.markCandles[0].openTime),
      lastDate: dateOnly(market.markCandles.at(-1).openTime),
      partialMonths: market.series.mark.partialMonths,
      partialReasons: market.series.mark.partialReasons,
    },
    funding: {
      source: market.fundingData.source,
      availableEvents: market.funding.length,
      firstDate: market.fundingData.firstFundingTime ? dateOnly(market.fundingData.firstFundingTime) : null,
      lastDate: market.fundingData.lastFundingTime ? dateOnly(market.fundingData.lastFundingTime) : null,
      availableMonths: market.fundingData.availableMonths,
      missingMonths: market.fundingData.missingMonths,
      oosStatus: oosFunding.status,
      oosAvailableEvents: oosFunding.availableEvents,
      expectedEvents: oosFunding.expectedEvents,
      eventCoverageRatio: oosFunding.eventCoverageRatio,
      missingSlotCount: oosFunding.missingSlotCount,
      missingSlots: oosFunding.missingSlots,
      noZeroImputation: true,
    },
  };
  const result = {
    generatedAt: new Date().toISOString(),
    strategyVersion: CONFIG.version,
    researchVersion: 'btc-v3-ema-sensitivity-v1',
    researchOnly: true,
    productionChanged: false,
    productionStrategyModified: false,
    mainModified: false,
    deployed: false,
    contract: market.contract,
    dataSource: market.dataSource,
    dataWindow: {
      requestedStartDate: dateOnly(market.startTime),
      requestedEndDate: dateOnly(market.endTime),
      executableStartDate: dateOnly(market.actualStartTime),
      executableEndDate: dateOnly(market.actualEndTime),
      full: { startDate: dateOnly(market.actualStartTime), endDate: dateOnly(market.actualEndTime) },
      inSample: { startDate: dateOnly(market.actualStartTime), endDate: dateOnly(Math.min(IN_SAMPLE_END, market.actualEndTime)) },
      outOfSample: { startDate: dateOnly(Math.max(OUT_OF_SAMPLE_START, market.actualStartTime)), endDate: dateOnly(market.actualEndTime) },
    },
    parameterFreeze: {
      testedVariants: EMA_VARIANTS,
      onlyEmaFastSlowVaried: true,
      frozen: {
        maLong: CONFIG.maLong,
        maSlopeDays: CONFIG.maSlopeDays,
        valuationLookbackDays: CONFIG.valuationLookbackDays,
        cheapDrawdown: CONFIG.cheapDrawdown,
        veryCheapDrawdown: CONFIG.veryCheapDrawdown,
        cheapMaDeviation: CONFIG.cheapMaDeviation,
        veryCheapMaDeviation: CONFIG.veryCheapMaDeviation,
        volLookbackDays: CONFIG.volLookbackDays,
        targetAnnualVol: CONFIG.targetAnnualVol,
        minVolCap: CONFIG.minVolCap,
        maxSignalExposure: CONFIG.maxSignalExposure,
        publicMarginCap: CONFIG.publicMarginCap,
        feeBps: FEE_BPS,
        slippageBps: SLIPPAGE_BPS,
        fundingSource: 'official available COIN-M fundingRate records; missing is partial, not zero-imputed',
        executionTiming: 'T-1 closed Index daily signal -> T daily perpetual open rebalance',
      },
    },
    assumptions: {
      feeBps: FEE_BPS,
      slippageBps: SLIPPAGE_BPS,
      stressMaintenanceRate: STRESS_MAINTENANCE_RATE,
      signalTiming: 'T-1 fully closed BTCUSD Index daily close -> T BTCUSD_PERP daily open',
      markSource: 'BTCUSD_PERP 4H mark candles; only the latest mark candle with closeTime <= fundingTime is used',
      pnlModel: 'inverse COIN-M BTC PnL; positive contracts are long, negative contracts are short',
      fundingModel: 'fundingPnlBtc = -(contracts * contractSize / markPrice) * fundingRate',
      maintenanceStress: 'same-day adverse daily low for long / high for short after the new position is established',
      missingFunding: 'no zero imputation; unknown Funding events remain an explicit coverage limitation',
      futureFunctionGuard: 'signals are calculated before appending the current Index daily close',
      duplicateMarkToMarketGuard: 'single sequential mark path; trade does not re-mark the position',
      periodAccounting: 'each Full/In-sample/OOS metric starts with 1 BTC and zero contracts; OOS indicator history is warmed from pre-2024 closed closes',
    },
    dataQuality,
    variants,
    sensitivityAnalysis: buildSensitivityAnalysis(variants),
    classification: classifySensitivity(variants, dataQuality),
    outputs: {
      result: 'research/btc-v3-ema-sensitivity-result.json',
      report: 'research/btc-v3-ema-sensitivity-report.md',
    },
  };
  const researchDir = path.join(__dirname, '..', 'research');
  const resultPath = path.join(researchDir, 'btc-v3-ema-sensitivity-result.json');
  const reportPath = path.join(researchDir, 'btc-v3-ema-sensitivity-report.md');
  fs.mkdirSync(researchDir, { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(reportPath, renderReport(result));
  console.log(JSON.stringify({
    resultPath,
    reportPath,
    classification: result.classification.label,
    oosWinnerByEndingBtc: result.classification.oosWinnerByEndingBtc,
    oosWinnerByBtcCagr: result.classification.oosWinnerByBtcCagr,
    dataWindow: result.dataWindow,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  DAY,
  HOUR,
  EMA_VARIANTS,
  computeSensitivitySignal,
  nearestClosedMark,
  executionPriceAtFunding,
  maxDrawdown,
  periodDefinitions,
  fundingCoverage,
  runVariant,
  classifySensitivity,
  renderReport,
  loadMarketData,
};
