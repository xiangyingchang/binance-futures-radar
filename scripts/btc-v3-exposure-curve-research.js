'use strict';

const {
  CONFIG,
  computeSignal,
  inversePnlBtc,
  fundingPnlBtc,
  targetContracts,
} = require('../lib/btc-v3-strategy');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 86400000;
const HOUR = 3600000;
const EIGHT_HOURS = 8 * HOUR;
const VISION_BASE = 'https://data.binance.vision/data/futures/cm/monthly';
const VISION_START_TIME = Date.UTC(2020, 7, 1);
const IN_SAMPLE_END = Date.UTC(2023, 11, 31, 23, 59, 59, 999);
const OUT_OF_SAMPLE_START = Date.UTC(2024, 0, 1);
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'btc-v3-exposure-curve-v2-cache');

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

const EXECUTION_ASSUMPTIONS = Object.freeze({
  makerFeeBps: numberOr(process.env.BTC_V3_MAKER_FEE_BPS, 2),
  takerFeeBps: numberOr(process.env.BTC_V3_TAKER_FEE_BPS, 5),
  makerSlippageBps: numberOr(process.env.BTC_V3_MAKER_SLIPPAGE_BPS, 5),
  takerSlippageBps: numberOr(process.env.BTC_V3_TAKER_SLIPPAGE_BPS, 5),
  marginCap: numberOr(process.env.BTC_V3_MARGIN_CAP, CONFIG.publicMarginCap),
  preferredIntradayInterval: '1h',
  fallbackIntradayInterval: '4h',
  pathModel: 'OHLC path: open -> low -> high -> close on bullish bars; open -> high -> low -> close on bearish bars',
});

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

function latestCompleteVisionMonthEnd(now = Date.now()) {
  const current = new Date(now);
  return Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0, 23, 59, 59, 999);
}

function requestedEndTime() {
  const override = process.env.BTC_V3_EXPOSURE_END;
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) {
    const timestamp = Date.parse(`${override}T23:59:59.999Z`);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return latestCompleteVisionMonthEnd();
}

function visionArchiveUrl(kind, symbol, interval, year, month) {
  const monthText = String(month).padStart(2, '0');
  if (kind === 'fundingRate') {
    return `${VISION_BASE}/fundingRate/${symbol}/${symbol}-fundingRate-${year}-${monthText}.zip`;
  }
  return `${VISION_BASE}/${kind}/${symbol}/${interval}/${symbol}-${interval}-${year}-${monthText}.zip`;
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-v3-vision-v2-'));
  const archivePath = path.join(tempDir, 'archive.zip');
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/zip',
        'User-Agent': 'binance-futures-radar-v3-exposure-curve-v2/1.0',
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
      .every((value) => Number.isFinite(value)) && row.open > 0 && row.close > 0 && row.high > 0 && row.low > 0)
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

function aggregateDailyCandles(candles) {
  const grouped = new Map();
  for (const candle of candles) {
    const openTime = dayStart(candle.openTime);
    if (!grouped.has(openTime)) {
      grouped.set(openTime, {
        openTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        closeTime: candle.closeTime,
        intervalMs: DAY,
      });
    } else {
      const current = grouped.get(openTime);
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.closeTime = candle.closeTime;
    }
  }
  return [...grouped.values()].sort((a, b) => a.openTime - b.openTime);
}

function validateMonthlyCandles(rows, year, month, intervalMs, { allowPartialStart, allowPartialEnd }) {
  if (!rows.length) return { ok: false, reason: 'empty_archive', maxGapMs: null };
  let maxGapMs = 0;
  for (let i = 1; i < rows.length; i += 1) {
    maxGapMs = Math.max(maxGapMs, rows[i].openTime - rows[i - 1].openTime);
  }
  if (maxGapMs > intervalMs * 1.5) {
    return { ok: false, reason: `internal_gap_${maxGapMs}ms`, maxGapMs };
  }
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month, 0, 23, 59, 59, 999);
  const expectedLastOpen = monthEnd - intervalMs + 1;
  if (!allowPartialStart && rows[0].openTime > monthStart) {
    return { ok: false, reason: 'leading_gap', maxGapMs };
  }
  if (!allowPartialEnd && rows.at(-1).openTime < expectedLastOpen) {
    return { ok: false, reason: 'trailing_gap', maxGapMs };
  }
  return { ok: true, reason: null, maxGapMs };
}

async function loadVisionSeries({ kind, symbol, preferredInterval, fallbackInterval, startTime, endTime, label, allowPartialGaps = false }) {
  const months = monthKeys(startTime, endTime);
  const allRows = [];
  const diagnostics = [];
  const batchSize = 5;
  for (let offset = 0; offset < months.length; offset += batchSize) {
    const batch = await Promise.all(months.slice(offset, offset + batchSize).map(async ({ year, month }, batchIndex) => {
      const globalIndex = offset + batchIndex;
      const preferredUrl = visionArchiveUrl(kind, symbol, preferredInterval, year, month);
      const preferredCsv = await fetchVisionCsv(preferredUrl);
      const preferredRows = parseKlineCsv(preferredCsv, preferredInterval === '1h' ? HOUR : preferredInterval === '4h' ? 4 * HOUR : DAY);
      const monthEnd = Date.UTC(year, month, 0, 23, 59, 59, 999);
      const preferredValidation = validateMonthlyCandles(preferredRows, year, month, preferredRows[0]?.intervalMs || DAY, {
        allowPartialStart: globalIndex === 0,
        allowPartialEnd: globalIndex === months.length - 1 && endTime < monthEnd,
      });
      if (preferredValidation.ok) {
        return { year, month, rows: preferredRows, interval: preferredInterval, fallbackReason: null, validation: preferredValidation, url: preferredUrl };
      }
      if (!fallbackInterval) throw new Error(`${label} ${year}-${String(month).padStart(2, '0')} failed ${preferredInterval} completeness: ${preferredValidation.reason}`);
      const fallbackUrl = visionArchiveUrl(kind, symbol, fallbackInterval, year, month);
      const fallbackCsv = await fetchVisionCsv(fallbackUrl);
      const fallbackRows = parseKlineCsv(fallbackCsv, fallbackInterval === '4h' ? 4 * HOUR : DAY);
      const fallbackValidation = validateMonthlyCandles(fallbackRows, year, month, fallbackRows[0]?.intervalMs || 4 * HOUR, {
        allowPartialStart: globalIndex === 0,
        allowPartialEnd: globalIndex === months.length - 1 && endTime < monthEnd,
      });
      if (!fallbackValidation.ok) {
        if (allowPartialGaps && preferredRows.length) {
          return { year, month, rows: preferredRows, interval: preferredInterval, fallbackReason: `partial_${preferredValidation.reason};fallback_${fallbackValidation.reason}`, validation: preferredValidation, url: preferredUrl };
        }
        throw new Error(`${label} ${year}-${String(month).padStart(2, '0')} failed fallback ${fallbackInterval} completeness: ${fallbackValidation.reason}`);
      }
      return { year, month, rows: fallbackRows, interval: fallbackInterval, fallbackReason: preferredValidation.reason || 'preferred_archive_unavailable', validation: fallbackValidation, url: fallbackUrl };
    }));
    for (const part of batch) {
      allRows.push(...part.rows);
      diagnostics.push({
        month: `${part.year}-${String(part.month).padStart(2, '0')}`,
        interval: part.interval,
        rows: part.rows.length,
        fallbackReason: part.fallbackReason,
        maxGapMs: part.validation.maxGapMs,
        url: part.url,
      });
    }
  }
  const candles = dedupeByTime(allRows);
  const intervals = [...new Set(diagnostics.map((item) => item.interval))];
  return {
    label,
    candles,
    preferredInterval,
    fallbackInterval: fallbackInterval || null,
    intervalUsed: intervals.length === 1 ? intervals[0] : intervals.join('+'),
    fallbackMonths: diagnostics.filter((item) => item.fallbackReason && item.interval !== preferredInterval).map((item) => item.month),
    partialMonths: diagnostics.filter((item) => item.fallbackReason?.startsWith('partial_')).map((item) => item.month),
    diagnostics,
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
      const url = visionArchiveUrl('fundingRate', CONFIG.coinMSymbol, null, year, month);
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
  const funding = dedupeByTime(availableRows, 'fundingTime');
  return {
    rows: funding,
    source: 'Binance Vision COIN-M monthly fundingRate archives',
    availableMonths,
    missingMonths,
    firstFundingTime: funding[0]?.fundingTime || null,
    lastFundingTime: funding.at(-1)?.fundingTime || null,
    archivePattern: `https://data.binance.vision/data/futures/cm/monthly/fundingRate/${CONFIG.coinMSymbol}/${CONFIG.coinMSymbol}-fundingRate-YYYY-MM.zip`,
  };
}

function fundingEventsByExecutionOpen(funding, executionBars) {
  const opens = new Set(executionBars.map((bar) => bar.openTime));
  const byOpen = new Map();
  const unaligned = [];
  for (const event of funding) {
    const roundedHour = Math.round(event.fundingTime / HOUR) * HOUR;
    if (Math.abs(roundedHour - event.fundingTime) <= 60000 && opens.has(roundedHour)) {
      if (!byOpen.has(roundedHour)) byOpen.set(roundedHour, []);
      byOpen.get(roundedHour).push(event);
      continue;
    }
    if (opens.has(event.fundingTime)) {
      if (!byOpen.has(event.fundingTime)) byOpen.set(event.fundingTime, []);
      byOpen.get(event.fundingTime).push(event);
      continue;
    }
    let previous = null;
    let next = null;
    for (const bar of executionBars) {
      if (bar.openTime <= event.fundingTime) previous = bar;
      else {
        next = bar;
        break;
      }
    }
    const assigned = next || previous;
    if (!assigned) continue;
    if (!byOpen.has(assigned.openTime)) byOpen.set(assigned.openTime, []);
    byOpen.get(assigned.openTime).push(event);
    unaligned.push({
      fundingTime: event.fundingTime,
      assignedBarOpen: assigned.openTime,
      alignment: next ? 'next_available_execution_bar_open' : 'last_execution_bar_open',
    });
  }
  return { byOpen, unaligned };
}

async function loadMarketData() {
  const source = process.env.BTC_V3_EXPOSURE_DATA_SOURCE || 'vision';
  if (source !== 'vision') throw new Error('V2 requires BTC_V3_EXPOSURE_DATA_SOURCE=vision so the runner does not depend on restricted Binance REST endpoints.');
  const startTime = VISION_START_TIME;
  const endTime = requestedEndTime();
  if (endTime < OUT_OF_SAMPLE_START) throw new Error(`Data end ${dateOnly(endTime)} is before the required 2024 out-of-sample period.`);
  const [indexSeries, executionSeries, markSeries, fundingData] = await Promise.all([
    loadVisionSeries({ kind: 'indexPriceKlines', symbol: CONFIG.coinMPair, preferredInterval: '1h', fallbackInterval: EXECUTION_ASSUMPTIONS.fallbackIntradayInterval, startTime, endTime, label: 'BTCUSD index intraday source for daily signal', allowPartialGaps: true }),
    loadVisionSeries({ kind: 'klines', symbol: CONFIG.coinMSymbol, preferredInterval: EXECUTION_ASSUMPTIONS.preferredIntradayInterval, fallbackInterval: EXECUTION_ASSUMPTIONS.fallbackIntradayInterval, startTime, endTime, label: 'BTCUSD_PERP execution', allowPartialGaps: true }),
    loadVisionSeries({ kind: 'markPriceKlines', symbol: CONFIG.coinMSymbol, preferredInterval: EXECUTION_ASSUMPTIONS.preferredIntradayInterval, fallbackInterval: EXECUTION_ASSUMPTIONS.fallbackIntradayInterval, startTime, endTime, label: 'BTCUSD_PERP mark/funding reference', allowPartialGaps: true }),
    loadFunding(startTime, endTime),
  ]);
  const executionBars = executionSeries.candles.filter((bar) => bar.closeTime <= endTime);
  const markBars = markSeries.candles.filter((bar) => bar.closeTime <= endTime);
  const indexDaily = aggregateDailyCandles(indexSeries.candles.filter((bar) => bar.closeTime <= endTime));
  if (!executionBars.length || !markBars.length || !indexDaily.length) throw new Error('Required historical series is empty.');
  const fundingAlignment = fundingEventsByExecutionOpen(fundingData.rows, executionBars);
  const actualStartTime = executionBars[0].openTime;
  const actualEndTime = executionBars.at(-1).closeTime;
  return {
    contract: { ...VISION_CONTRACT, onboardDate: actualStartTime },
    executionBars,
    markBars,
    indexDaily,
    funding: fundingData.rows,
    fundingByExecutionOpen: fundingAlignment.byOpen,
    fundingUnaligned: fundingAlignment.unaligned,
    fundingData,
    dataSource: 'Binance Vision official COIN-M monthly archives',
    startTime,
    endTime,
    actualStartTime,
    actualEndTime,
    series: { index: indexSeries, execution: executionSeries, mark: markSeries },
  };
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

function scenarioDefinitions() {
  const ladderLevels = [-0.03, -0.06, -0.10, -0.15];
  const thresholdGroups = [
    { key: 'g1', label: '[-3%, -6%, -10%]', drops: [-0.03, -0.06, -0.10] },
    { key: 'g2', label: '[-5%, -10%, -15%]', drops: [-0.05, -0.10, -0.15] },
    { key: 'g3', label: '[-7%, -12%, -20%]', drops: [-0.07, -0.12, -0.20] },
  ];
  const bonuses = { mild: [0.05, 0.10, 0.20], aggressive: [0.10, 0.25, 0.40] };
  const curveDef = (name, group, strength) => ({
    name,
    type: 'curve',
    thresholdGroup: group.key,
    thresholdLabel: group.label,
    strength,
    levels: group.drops.map((drop, index) => ({ drop, bonus: bonuses[strength][index] })),
  });
  const required = [
    { name: 'baseline_immediate', type: 'baseline' },
    { name: 'ladder_80_20', type: 'ladder', immediateFraction: 0.80, levels: ladderLevels },
    { name: 'ladder_60_40', type: 'ladder', immediateFraction: 0.60, levels: ladderLevels },
    curveDef('curve_mild', thresholdGroups[1], 'mild'),
    curveDef('curve_aggressive', thresholdGroups[1], 'aggressive'),
  ];
  const matrix = thresholdGroups.flatMap((group) => [
    curveDef(`curve_${group.key}_mild`, group, 'mild'),
    curveDef(`curve_${group.key}_aggressive`, group, 'aggressive'),
  ]);
  const all = [...required, ...matrix];
  const unique = new Map(all.map((definition) => [definition.name, definition]));
  return { required, matrix, all: [...unique.values()], thresholdGroups, bonuses };
}

function latestMarkPrice(markBars, timestamp) {
  let low = 0;
  let high = markBars.length - 1;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const bar = markBars[middle];
    if (bar.openTime <= timestamp) {
      best = bar;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (!best) return null;
  const next = markBars[low];
  const interval = best.intervalMs || HOUR;
  if (next && next.openTime - best.openTime > interval * 1.5 && timestamp < next.openTime) return null;
  if (!next && timestamp - best.openTime > interval * 1.5) return null;
  return best.open || null;
}

function executionPriceAtFunding(executionBars, timestamp) {
  let low = 0;
  let high = executionBars.length - 1;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const bar = executionBars[middle];
    if (bar.openTime <= timestamp) {
      best = bar;
      low = middle + 1;
    } else high = middle - 1;
  }
  const next = executionBars[low];
  if (best && best.openTime === timestamp) return best.open;
  if (best && timestamp <= best.closeTime) return best.open;
  if (best && (!next || timestamp < next.openTime)) return best.close;
  return next?.open || best?.close || null;
}

function markTo(state, toPrice) {
  if (!Number.isFinite(toPrice) || toPrice <= 0) throw new Error(`Invalid mark price ${toPrice}`);
  if (state.lastMarkPrice !== null && state.contracts !== 0) {
    const pnl = inversePnlBtc(state.contracts, state.contractSize, state.lastMarkPrice, toPrice);
    if (!Number.isFinite(pnl)) throw new Error('Non-finite mark-to-market PnL.');
    state.equityBtc += pnl;
    if (state.captureTrace) {
      for (const lot of state.lots) {
        lot.markToMarketPnlBtc += pnl * (lot.contracts / state.contracts);
      }
    }
  }
  state.lastMarkPrice = toPrice;
}

function contractTarget(state, exposure, price) {
  const sizing = targetContracts({ targetExposure: exposure, equityBtc: state.equityBtc, price, contractSizeUsd: state.contractSize, currentContracts: state.contracts });
  if (!sizing) throw new Error(`Unable to size target exposure ${exposure} at ${price}`);
  return sizing.signedContracts;
}

function splitPositionLot(state, lot, quantity) {
  const lotQuantity = Math.abs(lot.contracts);
  const closedQuantity = Math.min(lotQuantity, Math.abs(quantity));
  const fraction = lotQuantity ? closedQuantity / lotQuantity : 0;
  const signedQuantity = Math.sign(lot.contracts) * closedQuantity;
  const segment = {
    ...lot,
    segmentId: `${lot.lotId}:segment:${state.lotSegmentSequence++}`,
    contracts: signedQuantity,
    initialContracts: lot.initialContracts * fraction,
    markToMarketPnlBtc: lot.markToMarketPnlBtc * fraction,
    fundingPnlBtc: lot.fundingPnlBtc * fraction,
    feeBtc: lot.feeBtc * fraction,
    slippageBtc: lot.slippageBtc * fraction,
    closed: true,
  };
  lot.contracts -= signedQuantity;
  lot.initialContracts -= segment.initialContracts;
  lot.markToMarketPnlBtc -= segment.markToMarketPnlBtc;
  lot.fundingPnlBtc -= segment.fundingPnlBtc;
  lot.feeBtc -= segment.feeBtc;
  lot.slippageBtc -= segment.slippageBtc;
  return segment;
}

function consumePositionLots(state, closingDelta) {
  const closedLots = [];
  if (!state.captureTrace || !state.contracts || !closingDelta) return closedLots;
  const requiredSide = -Math.sign(closingDelta);
  let remaining = Math.min(Math.abs(closingDelta), Math.abs(state.contracts));
  for (const lot of [...state.lots]) {
    if (remaining <= 0) break;
    if (Math.sign(lot.contracts) !== requiredSide || lot.contracts === 0) continue;
    const segment = splitPositionLot(state, lot, remaining);
    state.closedLots.push(segment);
    closedLots.push(segment);
    remaining -= Math.abs(segment.contracts);
    if (Math.abs(lot.contracts) < 1e-12) state.lots = state.lots.filter((item) => item !== lot);
  }
  return closedLots;
}

function addPositionLot(state, delta, intendedPrice, effectivePrice, maker, dayContext, fillKind, fee, slippagePnl, identifiers = {}) {
  if (!state.captureTrace || !delta) return null;
  const tradeId = identifiers.tradeId || `${state.scenarioName}:trade:${state.tradeSequence++}`;
  const lotId = maker ? (identifiers.lotId || `${state.scenarioName}:maker-fill:${state.makerFillSequence++}`) : tradeId;
  state.lots.push({
    lotId,
    segmentId: `${lotId}:segment:open`,
    source: maker ? 'maker_fill' : 'non_maker_trade',
    maker,
    contracts: delta,
    initialContracts: delta,
    entryPrice: intendedPrice,
    effectivePrice,
    dayOpen: dayContext.openTime,
    dayOpenPrice: dayContext.openPrice,
    fillKind,
    markToMarketPnlBtc: 0,
    fundingPnlBtc: 0,
    feeBtc: fee,
    slippageBtc: Math.max(0, -slippagePnl),
    closed: false,
  });
  return { tradeId, lotId };
}

function applyTrade(state, newContracts, intendedPrice, maker, dayContext, costs, fillKind) {
  const delta = newContracts - state.contracts;
  if (delta === 0) return null;
  const feeBps = maker ? costs.makerFeeBps : costs.takerFeeBps;
  const slippageBps = maker ? costs.makerSlippageBps : costs.takerSlippageBps;
  const effectivePrice = intendedPrice * (delta > 0 ? 1 + slippageBps / 10000 : 1 - slippageBps / 10000);
  const slippagePnl = inversePnlBtc(delta, state.contractSize, effectivePrice, intendedPrice);
  if (!(slippagePnl <= 1e-12)) throw new Error(`Adverse slippage improved PnL: ${slippagePnl}`);
  const fee = Math.abs(delta) * state.contractSize / effectivePrice * (feeBps / 10000);
  state.equityBtc += slippagePnl;
  state.equityBtc -= fee;
  state.totalSlippageCostBtc += Math.max(0, -slippagePnl);
  state.totalFeesBtc += fee;
  if (maker) {
    state.makerFeesBtc += fee;
    state.makerTradeCount += 1;
  } else {
    state.takerFeesBtc += fee;
    state.takerTradeCount += 1;
  }
  state.turnoverUsd += Math.abs(delta) * state.contractSize;
  const previousContracts = state.contracts;
  const closeQuantity = previousContracts && Math.sign(previousContracts) !== Math.sign(delta)
    ? Math.min(Math.abs(previousContracts), Math.abs(delta))
    : 0;
  const closedLots = consumePositionLots(state, delta);
  const closedLotMarkToMarketPnlBtc = closedLots.reduce((total, lot) => total + lot.markToMarketPnlBtc, 0);
  const closedLotFundingPnlBtc = closedLots.reduce((total, lot) => total + lot.fundingPnlBtc, 0);
  state.contracts = newContracts;
  const openDelta = Math.sign(delta) * (Math.abs(delta) - closeQuantity);
  const traceTradeId = state.captureTrace ? `${state.scenarioName}:trade:${state.tradeSequence++}` : null;
  const traceFillId = state.captureTrace && maker ? `${state.scenarioName}:maker-fill:${state.makerFillSequence++}` : null;
  const lot = addPositionLot(state, openDelta, intendedPrice, effectivePrice, maker, dayContext, fillKind, fee, slippagePnl, {
    tradeId: traceTradeId,
    lotId: traceFillId,
  });
  state.tradeCount += 1;
  state.tradeEvents.push({
    dayOpen: dayContext.openTime,
    dayOpenPrice: dayContext.openPrice,
    delta,
    intendedPrice,
    effectivePrice,
    maker,
    fillKind,
  });
  return {
    delta,
    fee,
    slippagePnl,
    effectivePrice,
    lotId: lot?.lotId || traceFillId || null,
    tradeId: traceTradeId || lot?.tradeId || null,
    lotOpened: Boolean(lot),
    closedLotMarkToMarketPnlBtc,
    closedLotFundingPnlBtc,
  };
}

function processFunding(state, event, market, costs) {
  if (!state.contracts) {
    state.fundingEventCount += 1;
    return;
  }
  let mark = latestMarkPrice(market.markBars, event.fundingTime);
  if (!(mark > 0)) {
    mark = executionPriceAtFunding(market.executionBars, event.fundingTime);
    state.fundingMarkFallbackCount += 1;
  }
  if (!(mark > 0)) throw new Error(`No point-in-time mark price for funding at ${iso(event.fundingTime)}`);
  markTo(state, mark);
  if (costs.includeFunding === false) return;
  const pnl = fundingPnlBtc(state.contracts, state.contractSize, mark, event.fundingRate);
  if (!Number.isFinite(pnl)) throw new Error(`Non-finite funding PnL at ${iso(event.fundingTime)}`);
  state.equityBtc += pnl;
  if (state.captureTrace) {
    for (const lot of state.lots) {
      lot.fundingPnlBtc += pnl * (lot.contracts / state.contracts);
    }
  }
  state.fundingPnlBtc += pnl;
  state.fundingEventCount += 1;
}

function ohlcPath(bar) {
  const bullish = bar.close >= bar.open;
  const prices = bullish ? [bar.low, bar.high, bar.close] : [bar.high, bar.low, bar.close];
  return prices.map((price, index) => ({
    price,
    timestamp: index === prices.length - 1
      ? bar.closeTime
      : bar.openTime + Math.round(((index + 1) / prices.length) * (bar.closeTime - bar.openTime + 1)),
  }));
}

function crossedOrders(orders, fromPrice, toPrice) {
  const descending = toPrice < fromPrice;
  return orders.filter((order) => order.active && (
    descending
      ? order.limitPrice <= fromPrice && order.limitPrice >= toPrice
      : order.limitPrice >= fromPrice && order.limitPrice <= toPrice
  )).sort((a, b) => descending ? b.limitPrice - a.limitPrice : a.limitPrice - b.limitPrice);
}

function processBarPath(bar, state, orders, dayContext, costs, market, fillPriceMode, runOptions = {}) {
  let fromPrice = bar.open;
  let fromTimestamp = bar.openTime;
  for (const point of ohlcPath(bar)) {
    const toPrice = point.price;
    const toTimestamp = point.timestamp;
    for (const order of crossedOrders(orders, fromPrice, toPrice)) {
      const ratio = toPrice === fromPrice ? 0 : (order.limitPrice - fromPrice) / (toPrice - fromPrice);
      const fillTimestamp = fromTimestamp + Math.max(0, Math.min(1, ratio)) * (toTimestamp - fromTimestamp);
      const clusterId = typeof runOptions.crashClusterForTimestamp === 'function'
        ? runOptions.crashClusterForTimestamp(fillTimestamp)
        : null;
      if (runOptions.excludeCrashClusterIds && clusterId !== null && runOptions.excludeCrashClusterIds.has(clusterId)) {
        order.active = false;
        order.excludedClusterId = clusterId;
        state.excludedOrderCount += 1;
        continue;
      }
      const intendedPrice = fillPriceMode === 'open' ? dayContext.openPrice : order.limitPrice;
      markTo(state, intendedPrice);
      const desired = order.kind === 'curve'
        ? contractTarget(state, Math.min(EXECUTION_ASSUMPTIONS.marginCap, order.targetExposure + order.bonus), intendedPrice)
        : state.contracts + order.contracts;
      const before = state.contracts;
      if (desired > before) {
        const trade = applyTrade(state, desired, intendedPrice, true, dayContext, costs, order.kind);
        state.ladderFilledContracts += desired - before;
        if (state.captureTrace && trade?.lotId) {
          const equityAfter = state.equityBtc;
          const exposureAfter = 1 + ((state.contracts * state.contractSize) / trade.effectivePrice) / equityAfter;
          state.makerFillEvents.push({
            fillId: trade.lotId,
            tradeId: trade.tradeId,
            orderId: order.id,
            fillTimestamp,
            dayOpen: dayContext.openTime,
            dayOpenPrice: dayContext.openPrice,
            baselineTargetExposure: dayContext.targetExposure,
            baselineTargetContracts: dayContext.targetContracts,
            thresholdDrop: order.drop ?? null,
            bonusExposure: order.bonus ?? null,
            limitPrice: order.limitPrice,
            intendedPrice,
            effectivePrice: trade.effectivePrice,
            contracts: trade.delta,
            contractsAfter: state.contracts,
            exposureAfter,
            feeBtc: trade.fee,
            slippageBtc: Math.max(0, -trade.slippagePnl),
            closedLotMarkToMarketPnlBtc: trade.closedLotMarkToMarketPnlBtc,
            closedLotFundingPnlBtc: trade.closedLotFundingPnlBtc,
            lotOpened: trade.lotOpened,
            positionEffect: trade.lotOpened ? 'open_or_increase' : 'reduce_or_close',
            clusterId,
            fillKind: order.kind,
          });
        }
      }
      order.active = false;
      state.ladderFillCount += 1;
      order.fillTimestamp = fillTimestamp;
    }
    markTo(state, toPrice);
    fromPrice = toPrice;
    fromTimestamp = toTimestamp;
  }
}

function reconcileAtDayOpen(definition, state, targetExposure, dayContext, costs) {
  const target = Math.min(EXECUTION_ASSUMPTIONS.marginCap, Math.max(0, targetExposure));
  const targetContracts = contractTarget(state, target, dayContext.openPrice);
  const orders = [];
  if (definition.type === 'baseline') {
    markTo(state, dayContext.openPrice);
    applyTrade(state, targetContracts, dayContext.openPrice, false, dayContext, costs, 'baseline_immediate');
    return { targetExposure: target, targetContracts, orders };
  }
  if (targetContracts <= state.contracts) {
    markTo(state, dayContext.openPrice);
    applyTrade(state, targetContracts, dayContext.openPrice, false, dayContext, costs, 'risk_reduction');
  } else if (definition.type === 'curve') {
    markTo(state, dayContext.openPrice);
    applyTrade(state, targetContracts, dayContext.openPrice, false, dayContext, costs, 'curve_base');
  } else {
    let remaining = targetContracts - state.contracts;
    markTo(state, dayContext.openPrice);
    if (state.contracts < 0) {
      const cover = Math.min(remaining, -state.contracts);
      applyTrade(state, state.contracts + cover, dayContext.openPrice, false, dayContext, costs, 'ladder_cover');
      remaining = targetContracts - state.contracts;
    }
    const immediate = Math.min(remaining, Math.max(0, Math.round(remaining * definition.immediateFraction)));
    applyTrade(state, state.contracts + immediate, dayContext.openPrice, false, dayContext, costs, 'ladder_immediate');
    remaining = targetContracts - state.contracts;
    if (remaining > 0) {
      const weights = definition.levels.map(() => 1 / definition.levels.length);
      let allocated = 0;
      definition.levels.forEach((drop, index) => {
        const contracts = index === definition.levels.length - 1 ? remaining - allocated : Math.round(remaining * weights[index]);
        allocated += contracts;
        if (contracts <= 0) return;
        orders.push({
          id: `${definition.name}-${dayContext.openTime}-${index}`,
          kind: 'ladder',
          drop,
          limitPrice: dayContext.openPrice * (1 + drop),
          contracts,
          active: true,
        });
        state.ladderOrderCount += 1;
        state.ladderSubmittedContracts += contracts;
      });
    }
  }
  if (definition.type === 'curve' && targetContracts >= state.contracts) {
    for (const [index, level] of definition.levels.entries()) {
      orders.push({
        id: `${definition.name}-${dayContext.openTime}-${index}`,
        kind: 'curve',
        drop: level.drop,
        limitPrice: dayContext.openPrice * (1 + level.drop),
        targetExposure: target,
        bonus: level.bonus,
        active: true,
      });
      state.ladderOrderCount += 1;
    }
  }
  return { targetExposure: target, targetContracts, orders };
}

function fundingCoverage(market, period) {
  const inPeriod = market.funding.filter((event) => event.fundingTime >= period.startTime && event.fundingTime <= period.endTime);
  const firstAvailable = market.fundingData.firstFundingTime;
  const availableFrom = firstAvailable === null ? null : Math.max(period.startTime, firstAvailable);
  const expectedStart = availableFrom === null ? null : Math.ceil(availableFrom / EIGHT_HOURS) * EIGHT_HOURS;
  const expectedEnd = availableFrom === null ? null : Math.floor(period.endTime / EIGHT_HOURS) * EIGHT_HOURS;
  const expectedEvents = expectedStart !== null && expectedEnd >= expectedStart ? Math.floor((expectedEnd - expectedStart) / EIGHT_HOURS) + 1 : 0;
  const ratio = expectedEvents ? inPeriod.filter((event) => event.fundingTime >= expectedStart).length / expectedEvents : 0;
  let status = 'unavailable';
  if (expectedEvents && availableFrom <= period.startTime && ratio >= 0.995) status = 'complete';
  else if (inPeriod.length) status = 'partial';
  return {
    status,
    periodStart: dateOnly(period.startTime),
    periodEnd: dateOnly(period.endTime),
    availableFrom: firstAvailable === null ? null : dateOnly(firstAvailable),
    availableTo: market.fundingData.lastFundingTime === null ? null : dateOnly(market.fundingData.lastFundingTime),
    availableEvents: inPeriod.length,
    expectedEvents,
    eventCoverageRatio: ratio,
    missingMonthsBeforeArchive: market.fundingData.missingMonths.filter((month) => month < '2022-07'),
  };
}

function runScenario(definition, market, period, options = {}) {
  const costs = {
    ...EXECUTION_ASSUMPTIONS,
    includeFunding: options.includeFunding !== false,
    makerFeeBps: numberOr(options.makerFeeBps, EXECUTION_ASSUMPTIONS.makerFeeBps),
    takerFeeBps: numberOr(options.takerFeeBps, EXECUTION_ASSUMPTIONS.takerFeeBps),
    makerSlippageBps: numberOr(options.makerSlippageBps, EXECUTION_ASSUMPTIONS.makerSlippageBps),
    takerSlippageBps: numberOr(options.takerSlippageBps, EXECUTION_ASSUMPTIONS.takerSlippageBps),
  };
  const bars = market.executionBars.filter((bar) => bar.openTime >= period.startTime && bar.openTime <= period.endTime);
  if (!bars.length) throw new Error(`No execution bars for ${definition.name} ${period.name}`);
  const state = {
    captureTrace: options.captureTrace === true,
    scenarioName: definition.name,
    equityBtc: 1,
    contracts: 0,
    contractSize: market.contract.contractSize,
    lastMarkPrice: null,
    totalFeesBtc: 0,
    makerFeesBtc: 0,
    takerFeesBtc: 0,
    totalSlippageCostBtc: 0,
    fundingPnlBtc: 0,
    fundingEventCount: 0,
    fundingMarkFallbackCount: 0,
    turnoverUsd: 0,
    tradeCount: 0,
    makerTradeCount: 0,
    takerTradeCount: 0,
    ladderOrderCount: 0,
    ladderFillCount: 0,
    ladderSubmittedContracts: 0,
    ladderFilledContracts: 0,
    missedRallyCount: 0,
    tradeEvents: [],
    makerFillEvents: [],
    lots: [],
    closedLots: [],
    lotSegmentSequence: 0,
    tradeSequence: 0,
    makerFillSequence: 0,
    excludedOrderCount: 0,
    trace: [],
    btcNav: [],
    usdNav: [],
    exposureIntegral: 0,
    exposureDurationMs: 0,
    maxExposure: -Infinity,
    dailyRows: [],
    liquidated: false,
  };
  const closes = [];
  let indexCursor = 0;
  let currentDay = null;
  let dayContext = null;
  let orders = [];
  let firstBar = null;
  let lastBar = null;

  function appendIndexClosesBefore(timestamp) {
    while (indexCursor < market.indexDaily.length && market.indexDaily[indexCursor].openTime < timestamp) {
      const item = market.indexDaily[indexCursor];
      if (item.closeTime < timestamp) closes.push(item.close);
      indexCursor += 1;
    }
  }

  function finishDay() {
    if (!dayContext) return;
    const remaining = orders.filter((order) => order.active).length;
    if (remaining > 0 && dayContext.highPrice > dayContext.openPrice) state.missedRallyCount += 1;
    state.dailyRows.push({
      date: dateOnly(dayContext.openTime),
      open: dayContext.openPrice,
      high: dayContext.highPrice,
      close: dayContext.closePrice,
      targetExposure: dayContext.targetExposure,
      targetContracts: dayContext.targetContracts,
      endingContracts: state.contracts,
      remainingOrders: remaining,
    });
  }

  for (const bar of bars) {
    const barDay = dayStart(bar.openTime);
    const newDay = currentDay === null || barDay !== currentDay;
    if (newDay) {
      finishDay();
      currentDay = barDay;
      orders = [];
      appendIndexClosesBefore(barDay);
      dayContext = { openTime: barDay, openPrice: bar.open, highPrice: bar.high, closePrice: bar.close, targetExposure: 1, targetContracts: 0 };
    } else {
      dayContext.highPrice = Math.max(dayContext.highPrice, bar.high);
      dayContext.closePrice = bar.close;
    }
    if (!firstBar) firstBar = bar;
    lastBar = bar;
    for (const event of market.fundingByExecutionOpen.get(bar.openTime) || []) processFunding(state, event, market, costs);
    markTo(state, bar.open);
    if (newDay) {
      const signal = options.fixedTargetExposure == null ? computeSignal(closes) : { ready: true, finalTarget: Number(options.fixedTargetExposure) };
      const targetExposure = signal.ready ? signal.finalTarget : 1;
      const reconciliation = reconcileAtDayOpen(definition, state, targetExposure, dayContext, costs);
      dayContext.targetExposure = reconciliation.targetExposure;
      dayContext.targetContracts = reconciliation.targetContracts;
      orders = reconciliation.orders;
    }
    processBarPath(bar, state, orders, dayContext, costs, market, options.fillPriceMode || 'limit', options);
    if (!(state.equityBtc > 0)) {
      state.liquidated = true;
      break;
    }
    const usdNav = state.equityBtc * bar.close;
    const exposure = 1 + ((state.contracts * state.contractSize) / bar.close) / state.equityBtc;
    state.btcNav.push(state.equityBtc);
    state.usdNav.push(usdNav);
    state.maxExposure = Math.max(state.maxExposure, exposure);
    state.exposureIntegral += exposure * bar.intervalMs;
    state.exposureDurationMs += bar.intervalMs;
    if (state.captureTrace) {
      state.trace.push({
        timestamp: bar.closeTime,
        date: dateOnly(bar.openTime),
        open: bar.open,
        close: bar.close,
        equityBtc: state.equityBtc,
        usdNav,
        contracts: state.contracts,
        exposure,
      });
    }
  }
  finishDay();

  const periodDays = Math.max(1 / 24, (lastBar.closeTime - firstBar.openTime + 1) / DAY);
  const dayCloseByDay = new Map(state.dailyRows.map((row) => [Date.parse(`${row.date}T00:00:00Z`), row.close]));
  let betterBuyPriceProxyBtc = 0;
  let intradayMeanReversionProxyBtc = 0;
  for (const event of state.tradeEvents) {
    if (!event.maker) continue;
    const dayClose = dayCloseByDay.get(event.dayOpen);
    if (!(dayClose > 0)) continue;
    betterBuyPriceProxyBtc += inversePnlBtc(event.delta, state.contractSize, event.effectivePrice, event.dayOpenPrice);
    intradayMeanReversionProxyBtc += inversePnlBtc(event.delta, state.contractSize, event.effectivePrice, dayClose);
  }
  const endingBtc = state.equityBtc;
  const endingUsd = endingBtc * lastBar.close;
  const startUsd = firstBar.open;
  return {
    name: definition.name,
    type: definition.type,
    thresholdGroup: definition.thresholdGroup || null,
    thresholdLabel: definition.thresholdLabel || null,
    strength: definition.strength || null,
    period: period.name,
    startDate: dateOnly(firstBar.openTime),
    endDate: dateOnly(lastBar.closeTime),
    days: periodDays,
    startingBtc: 1,
    endingBtc,
    endingUsd,
    btcCagr: annualizedReturn(1, endingBtc, periodDays),
    usdCagr: annualizedReturn(startUsd, endingUsd, periodDays),
    btcMaxDrawdown: maxDrawdown(state.btcNav),
    usdMaxDrawdown: maxDrawdown(state.usdNav),
    averageExposure: state.exposureDurationMs ? state.exposureIntegral / state.exposureDurationMs : null,
    maxExposure: Number.isFinite(state.maxExposure) ? state.maxExposure : null,
    turnoverUsd: state.turnoverUsd,
    feesBtc: state.totalFeesBtc,
    makerFeesBtc: state.makerFeesBtc,
    takerFeesBtc: state.takerFeesBtc,
    fundingPnlBtc: state.fundingPnlBtc,
    fundingMarkFallbackCount: state.fundingMarkFallbackCount,
    slippageBtc: state.totalSlippageCostBtc,
    tradeCount: state.tradeCount,
    makerTradeCount: state.makerTradeCount,
    takerTradeCount: state.takerTradeCount,
    ladderFillRate: state.ladderOrderCount ? state.ladderFillCount / state.ladderOrderCount : null,
    ladderContractFillRate: state.ladderSubmittedContracts ? state.ladderFilledContracts / state.ladderSubmittedContracts : null,
    ladderOrders: state.ladderOrderCount,
    ladderFills: state.ladderFillCount,
    missedRallyCount: state.missedRallyCount,
    liquidated: state.liquidated,
    fundingCoverage: fundingCoverage(market, period),
    attributionProxies: {
      betterBuyPriceBtc: betterBuyPriceProxyBtc,
      intradayMeanReversionBtc: intradayMeanReversionProxyBtc,
      note: 'These are fill-level counterfactual proxies, not additive Shapley contributions; sizing and compounding make the total nonlinear.',
    },
    ...(state.captureTrace ? {
      makerFillEvents: state.makerFillEvents,
      lotRecords: [...state.closedLots, ...state.lots],
      trace: state.trace,
      excludedOrderCount: state.excludedOrderCount,
    } : {}),
  };
}

function periodDefinitions(market) {
  return [
    { name: 'full', startTime: market.actualStartTime, endTime: market.actualEndTime },
    { name: 'inSample', startTime: market.actualStartTime, endTime: Math.min(IN_SAMPLE_END, market.actualEndTime) },
    { name: 'outOfSample', startTime: Math.max(OUT_OF_SAMPLE_START, market.actualStartTime), endTime: market.actualEndTime },
  ];
}

function addBaselineDeltas(scenarioResults) {
  const baseline = scenarioResults.find((scenario) => scenario.name === 'baseline_immediate');
  if (!baseline) throw new Error('Baseline scenario missing.');
  for (const scenario of scenarioResults) {
    for (const periodName of Object.keys(scenario.periods)) {
      const current = scenario.periods[periodName];
      const reference = baseline.periods[periodName];
      current.deltaVsBaseline = {
        endingBtc: current.endingBtc - reference.endingBtc,
        btcCagr: current.btcCagr - reference.btcCagr,
        usdCagr: current.usdCagr - reference.usdCagr,
        btcMaxDrawdown: current.btcMaxDrawdown - reference.btcMaxDrawdown,
        usdMaxDrawdown: current.usdMaxDrawdown - reference.usdMaxDrawdown,
        averageExposure: current.averageExposure - reference.averageExposure,
        turnoverUsd: current.turnoverUsd - reference.turnoverUsd,
        feesBtc: current.feesBtc - reference.feesBtc,
        fundingPnlBtc: current.fundingPnlBtc - reference.fundingPnlBtc,
        slippageBtc: current.slippageBtc - reference.slippageBtc,
      };
      current.attributionVsBaseline = {
        higherAverageExposure: { averageExposureDelta: current.averageExposure - reference.averageExposure, maxExposureDelta: current.maxExposure - reference.maxExposure, monetaryContribution: null },
        betterBuyPrice: { proxyBtc: current.attributionProxies.betterBuyPriceBtc - reference.attributionProxies.betterBuyPriceBtc },
        intradayMeanReversion: { proxyBtc: current.attributionProxies.intradayMeanReversionBtc - reference.attributionProxies.intradayMeanReversionBtc },
        fundingFeeDifference: {
          fundingPnlDeltaBtc: current.fundingPnlBtc - reference.fundingPnlBtc,
          feeCostDeltaBtc: -(current.feesBtc - reference.feesBtc),
          slippageCostDeltaBtc: -(current.slippageBtc - reference.slippageBtc),
        },
        note: 'Components are non-additive because inverse-contract PnL, dynamic sizing, funding, fees, and exposure compound together.',
      };
    }
  }
  return scenarioResults;
}

function robustnessJudgment(scenarioResults, matrixDefinitions) {
  const byName = new Map(scenarioResults.map((scenario) => [scenario.name, scenario]));
  const rows = matrixDefinitions.map((definition) => {
    const scenario = byName.get(definition.name);
    const oos = scenario.periods.outOfSample;
    const is = scenario.periods.inSample;
    const positiveOos = oos.deltaVsBaseline.endingBtc > 0 && oos.deltaVsBaseline.btcCagr > 0;
    return {
      name: definition.name,
      thresholdGroup: definition.thresholdGroup,
      thresholdLabel: definition.thresholdLabel,
      strength: definition.strength,
      inSample: { endingBtcDelta: is.deltaVsBaseline.endingBtc, btcCagrDelta: is.deltaVsBaseline.btcCagr, positive: is.deltaVsBaseline.endingBtc > 0 && is.deltaVsBaseline.btcCagr > 0 },
      outOfSample: { endingBtcDelta: oos.deltaVsBaseline.endingBtc, btcCagrDelta: oos.deltaVsBaseline.btcCagr, positive: positiveOos },
    };
  });
  const positiveRows = rows.filter((row) => row.outOfSample.positive);
  const groups = [...new Set(rows.map((row) => row.thresholdGroup))];
  const groupsWithAnyPositive = groups.filter((group) => rows.some((row) => row.thresholdGroup === group && row.outOfSample.positive));
  const groupsWithBothPositive = groups.filter((group) => rows.filter((row) => row.thresholdGroup === group).every((row) => row.outOfSample.positive));
  let classification = 'not_robust_yet';
  if (positiveRows.length === rows.length && groupsWithBothPositive.length === groups.length) classification = 'robust';
  else if (positiveRows.length <= 1 || groupsWithAnyPositive.length <= 1) classification = 'suspected_overfit';
  const fundingCoverageStatus = byName.get('baseline_immediate').periods.outOfSample.fundingCoverage.status;
  return {
    rows,
    positiveOosCount: positiveRows.length,
    matrixCount: rows.length,
    groupsWithAnyPositive,
    groupsWithBothPositive,
    classification,
    fundingCoverageStatus,
    dataLimited: fundingCoverageStatus !== 'complete',
    qualification: classification === 'robust' && fundingCoverageStatus !== 'complete'
      ? 'robust_on_available_funding_partial'
      : classification,
    rule: 'robust requires every threshold group and both mild/aggressive variants to beat baseline on OOS in both ending BTC and BTC CAGR; one-group success is suspected overfit.',
    exposureCurveSurvives: classification === 'robust',
  };
}

function percent(value, digits = 2) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'n/a';
}

function number(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function renderMetricsTable(scenarios, periodName) {
  const lines = [
    '| scenario | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | avg/max exposure | turnover USD | fees BTC (maker/taker) | funding PnL BTC | slippage BTC | trades | fill rate | missed rallies |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scenario of scenarios) {
    const result = scenario.periods[periodName];
    lines.push(`| ${scenario.name} | ${number(result.endingBtc, 6)} | ${percent(result.btcCagr)} | ${percent(result.usdCagr)} | ${percent(result.btcMaxDrawdown)} | ${percent(result.usdMaxDrawdown)} | ${number(result.averageExposure, 3)} / ${number(result.maxExposure, 3)} | ${number(result.turnoverUsd, 0)} | ${number(result.feesBtc, 6)} (${number(result.makerFeesBtc, 6)} / ${number(result.takerFeesBtc, 6)}) | ${number(result.fundingPnlBtc, 6)} | ${number(result.slippageBtc, 6)} | ${result.tradeCount} | ${percent(result.ladderFillRate)} | ${result.missedRallyCount} |`);
  }
  return lines.join('\n');
}

function renderReport(result) {
  const required = result.scenarios;
  const matrix = result.robustnessMatrix;
  const verdict = matrix.exposureCurveSurvives
    ? matrix.dataLimited
      ? '在官方可取得的真实 funding records 上，Exposure Curve 经得住第二阶段的阈值稳健性检验：所有阈值组的 mild/aggressive 变体都在样本外同时超过 baseline；但 funding coverage 不完整，因此这不是全数据、生产级的最终确认。'
      : 'Exposure Curve 经得住第二阶段验证：所有阈值组的 mild/aggressive 变体都在样本外同时超过 baseline。'
    : matrix.classification === 'suspected_overfit'
      ? 'Exposure Curve 没有经得住第二阶段验证：优势集中在单一阈值组或单一变体，标记为疑似过拟合。'
      : 'Exposure Curve 尚未经得住第二阶段验证：样本外结果不是跨阈值组的稳定优势。';
  const attributionRows = required.map((scenario) => {
    const item = scenario.periods.outOfSample;
    const a = item.attributionVsBaseline;
    return `| ${scenario.name} | ${number(item.deltaVsBaseline.endingBtc, 6)} | ${number(a.higherAverageExposure.averageExposureDelta, 4)} | ${number(a.betterBuyPrice.proxyBtc, 6)} | ${number(a.intradayMeanReversion.proxyBtc, 6)} | ${number(a.fundingFeeDifference.fundingPnlDeltaBtc, 6)} | ${number(a.fundingFeeDifference.feeCostDeltaBtc, 6)} | ${number(a.fundingFeeDifference.slippageCostDeltaBtc, 6)} |`;
  });
  const matrixRows = matrix.rows.map((row) => `| ${row.thresholdLabel} | ${row.strength} | ${number(row.inSample.endingBtcDelta, 6)} | ${number(row.outOfSample.endingBtcDelta, 6)} | ${percent(row.outOfSample.btcCagrDelta)} | ${row.outOfSample.positive ? 'yes' : 'no'} |`).join('\n');
  const fallbackExecution = result.dataQuality.execution.fallbackMonths.length ? result.dataQuality.execution.fallbackMonths.join(', ') : 'none';
  const fallbackMark = result.dataQuality.mark.fallbackMonths.length ? result.dataQuality.mark.fallbackMonths.join(', ') : 'none';
  return `# BTC V3 Exposure Curve V2 第二阶段回测

> Research-only. 本报告不修改 main、不修改 V3 生产策略、不部署生产环境。

## 结论

${verdict}

- Robustness classification: **${matrix.classification}**
- Data qualification: **${matrix.qualification}**；baseline OOS funding coverage = **${matrix.fundingCoverageStatus}**。
- OOS positive matrix variants: **${matrix.positiveOosCount}/${matrix.matrixCount}**
- 判断规则：${matrix.rule}
- 参数在 2023-12-31 冻结；2024-01-01 起只做样本外评价，未根据 OOS 结果调参。

## 为什么第一阶段结果不能直接采信

第一阶段把 funding 明确标记为 omitted，并用 Daily OHLC 近似挂单成交路径；更严重的是，挂单成交前后先按分段价格结算、随后又对同一持仓从日开盘结算到日收盘，造成日内 PnL 可能重复 mark-to-market。本版改为单一事件序列：每次 mark 只从上一个 mark 到当前价格一次，成交只改变仓位并结算手续费/滑点，不再次结算同一段价格。

## 数据与执行假设

- 数据：Binance Vision 官方 COIN-M 月档（[公开数据仓库](https://github.com/binance/binance-public-data)、[数据入口](https://data.binance.vision/)）。
- Signal：BTCUSD Index 的 fully closed daily candles，T-1 close 决定 T 日第一根执行 bar 的仓位；本次 index partial months: **${result.dataQuality.index.partialMonths.join(', ') || 'none'}**。
- Execution：BTCUSD_PERP Kline，优先 1H；本次 execution interval used = **${result.dataQuality.execution.intervalUsed}**。Fallback months: **${fallbackExecution}**；partial months: **${result.dataQuality.execution.partialMonths.join(', ') || 'none'}**。
- Funding mark：BTCUSD_PERP mark price，优先 1H；本次 mark interval used = **${result.dataQuality.mark.intervalUsed}**。Fallback months: **${fallbackMark}**；partial months: **${result.dataQuality.mark.partialMonths.join(', ') || 'none'}**。mark 缺口只在 funding event 上回退到最近可用的 execution OHLC 点，并在结果里计数。
- Funding：使用官方 fundingRate 月档的真实 last_funding_rate；官方档案从 2022-07 才开始。2020-08 至 2022-06 不补 0，结果标记 partial。样本外 funding coverage: **${result.scenarios[0].periods.outOfSample.fundingCoverage.status}**, ${percent(result.scenarios[0].periods.outOfSample.fundingCoverage.eventCoverageRatio)} events coverage。
- Maker fee: ${result.assumptions.makerFeeBps} bps；taker fee: ${result.assumptions.takerFeeBps} bps；maker/taker slippage: ${result.assumptions.makerSlippageBps}/${result.assumptions.takerSlippageBps} bps。费率是保守研究假设，不代表某个账户的 VIP 实际费率。
- COIN-M contract size: ${result.contract.contractSize} USD；initial capital: 1 BTC；margin cap: ${result.assumptions.marginCap}x。
- Intraday path: ${result.assumptions.pathModel}。1H 数据不足时才按月回退 4H，并在 JSON/report 中保留月份。

## 主场景指标：样本内 2020–2023

${renderMetricsTable(required, 'inSample')}

## 主场景指标：样本外 2024–2026

${renderMetricsTable(required, 'outOfSample')}

## 主场景指标：全可执行窗口

${renderMetricsTable(required, 'full')}

## 参数稳健性矩阵：OOS 冻结参数

| thresholds | strength | IS ending BTC delta | OOS ending BTC delta | OOS BTC CAGR delta | beats baseline |
|---|---|---:|---:|---:|---|
${matrixRows}

## 相对 baseline 的增量收益来自哪里（OOS）

| scenario | ending BTC delta | avg exposure delta | better buy price proxy BTC | intraday mean-reversion proxy BTC | funding PnL delta BTC | fee-cost benefit BTC | slippage-cost benefit BTC |
|---|---:|---:|---:|---:|---:|---:|---:|
${attributionRows.join('\n')}

解释：

- higher average exposure 只报告 exposure 差异，不虚构一个可加总的美元贡献。
- better buy price proxy 把 maker fill 与同一日开盘价比较。
- intraday mean-reversion proxy 把 maker fill 与该日收盘价比较。
- funding/fee/slippage 是实际记账项相对 baseline 的差异。
- 这些组件不要求加总等于 ending BTC delta；逆向合约、动态 sizing、funding 和成本会复利耦合。

## 研究边界

- IS funding 在官方档案覆盖开始前不完整，因此 IS 的 funding PnL 不能解释为 2020–2023 全覆盖的真实 funding 结果。
- OOS 2024–2026 的 funding 需要以本次 JSON 中的 coverage 状态为准；缺失事件不会被静默当作 0。
- 这是研究回测，不是成交可执行性证明；1H OHLC 仍不能解决同一根 bar 内真实 tick 顺序，所以路径规则被固定并公开。
- 旧的 research/btc-v3-exposure-curve-result.json 保留为第一阶段历史结果；本文件只对应 V2 修正版。
`;
}

async function main() {
  const market = await loadMarketData();
  const definitions = scenarioDefinitions();
  const periods = periodDefinitions(market);
  const scenarioResults = definitions.all.map((definition) => {
    const periodResults = {};
    for (const period of periods) periodResults[period.name] = runScenario(definition, market, period);
    return {
      name: definition.name,
      type: definition.type,
      thresholdGroup: definition.thresholdGroup || null,
      thresholdLabel: definition.thresholdLabel || null,
      strength: definition.strength || null,
      levels: definition.levels || null,
      periods: periodResults,
    };
  });
  addBaselineDeltas(scenarioResults);
  const byName = new Map(scenarioResults.map((scenario) => [scenario.name, scenario]));
  const requiredResults = definitions.required.map((definition) => byName.get(definition.name));
  const robustness = robustnessJudgment(scenarioResults, definitions.matrix);
  const result = {
    generatedAt: new Date().toISOString(),
    strategyVersion: CONFIG.version,
    researchVersion: 'btc-v3-exposure-curve-v2',
    researchOnly: true,
    productionChanged: false,
    mainModified: false,
    productionStrategyModified: false,
    deployed: false,
    contract: market.contract,
    dataSource: market.dataSource,
    dataWindow: {
      requestedStartDate: dateOnly(market.startTime),
      requestedEndDate: dateOnly(market.endTime),
      executableStartDate: dateOnly(market.actualStartTime),
      executableEndDate: dateOnly(market.actualEndTime),
      inSample: { startDate: dateOnly(market.actualStartTime), endDate: dateOnly(IN_SAMPLE_END) },
      outOfSample: { startDate: dateOnly(OUT_OF_SAMPLE_START), endDate: dateOnly(market.actualEndTime) },
    },
    assumptions: {
      signalTiming: 'T-1 fully closed daily index close -> T first execution bar open',
      orderLifecycle: 'cancel-and-replace each UTC day; unfilled maker orders expire at day end',
      riskReduction: 'risk reduction and short covering are immediate taker trades',
      pathModel: EXECUTION_ASSUMPTIONS.pathModel,
      makerFeeBps: EXECUTION_ASSUMPTIONS.makerFeeBps,
      takerFeeBps: EXECUTION_ASSUMPTIONS.takerFeeBps,
      makerSlippageBps: EXECUTION_ASSUMPTIONS.makerSlippageBps,
      takerSlippageBps: EXECUTION_ASSUMPTIONS.takerSlippageBps,
      marginCap: EXECUTION_ASSUMPTIONS.marginCap,
      funding: 'official Binance Vision fundingRate records; unavailable history remains missing/partial, never imputed as zero',
      oosParameterFreeze: 'All scenario thresholds/bonuses are defined before running OOS; no OOS selection or retuning.',
    },
    dataQuality: {
      index: { intervalUsed: `${market.series.index.intervalUsed}->daily_close`, preferredInterval: market.series.index.preferredInterval, fallbackInterval: market.series.index.fallbackInterval, fallbackMonths: market.series.index.fallbackMonths, partialMonths: market.series.index.partialMonths, rows: market.indexDaily.length, firstDate: dateOnly(market.indexDaily[0].openTime), lastDate: dateOnly(market.indexDaily.at(-1).openTime) },
      execution: { intervalUsed: market.series.execution.intervalUsed, preferredInterval: market.series.execution.preferredInterval, fallbackInterval: market.series.execution.fallbackInterval, fallbackMonths: market.series.execution.fallbackMonths, partialMonths: market.series.execution.partialMonths, rows: market.executionBars.length, firstDate: dateOnly(market.executionBars[0].openTime), lastDate: dateOnly(market.executionBars.at(-1).openTime) },
      mark: { intervalUsed: market.series.mark.intervalUsed, preferredInterval: market.series.mark.preferredInterval, fallbackInterval: market.series.mark.fallbackInterval, fallbackMonths: market.series.mark.fallbackMonths, partialMonths: market.series.mark.partialMonths, rows: market.markBars.length, firstDate: dateOnly(market.markBars[0].openTime), lastDate: dateOnly(market.markBars.at(-1).openTime) },
      funding: { source: market.fundingData.source, rows: market.funding.length, firstDate: market.fundingData.firstFundingTime ? dateOnly(market.fundingData.firstFundingTime) : null, lastDate: market.fundingData.lastFundingTime ? dateOnly(market.fundingData.lastFundingTime) : null, availableMonths: market.fundingData.availableMonths, missingMonths: market.fundingData.missingMonths, unalignedToExecutionBars: market.fundingUnaligned },
    },
    scenarios: requiredResults,
    robustnessMatrix: robustness,
  };
  const resultPath = path.join(__dirname, '..', 'research', 'btc-v3-exposure-curve-v2-result.json');
  const reportPath = path.join(__dirname, '..', 'research', 'btc-v3-exposure-curve-v2-report.md');
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(reportPath, renderReport(result));
  console.log(JSON.stringify({ resultPath, reportPath, classification: result.robustnessMatrix.classification, positiveOosCount: result.robustnessMatrix.positiveOosCount, dataWindow: result.dataWindow }, null, 2));
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
  OUT_OF_SAMPLE_START,
  scenarioDefinitions,
  loadMarketData,
  periodDefinitions,
  dayStart,
  dateOnly,
  maxDrawdown,
  annualizedReturn,
  inversePnlBtc,
  ohlcPath,
  fundingEventsByExecutionOpen,
  runScenario,
  renderReport,
};
