'use strict';

const CONFIG = Object.freeze({
  rsiPeriod: 6,
  dailyRsiMinExclusive: 93,
  return7dMinExclusive: 20,
  rankMin: 101,
  rankPrimaryMax: 500,
  rankMax: 500,
  minListingAgeDays: 90,
  minQuoteVolumeUsd: 20_000_000,
  fundingStrongPercentile: 90,
  fundingWatchPercentile: 75,
  oi24hStrongPct: 20,
  oi7dStrongPct: 30,
  maxHoldDays: 3,
  hardStopPct: 30,
  manualSqueezeRiskVeto: true,
});

const EXCLUDED_BASES = new Set([
  'USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'PYUSD', 'USDE',
  'USD1', 'EURI', 'EUR', 'XAUT', 'PAXG', 'WBTC', 'WETH', 'BTCST', 'BTCDOM',
]);

const MANUAL_REVIEW_POLICY = Object.freeze({
  squeezeRiskFlag: 'SQUEEZE_RISK',
  squeezeRiskTrigger: 'Material CEX outflow plus fresh-wallet accumulation / supply withdrawal',
  squeezeRiskAction: 'Veto new shorts until exchange outflow stops or reverses and squeeze risk is re-evaluated',
});

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pctChange(current, previous) {
  const a = finiteNumber(current);
  const b = finiteNumber(previous);
  if (a === null || b === null || b === 0) return null;
  return ((a / b) - 1) * 100;
}

function calculateRsiSeries(closes, period = CONFIG.rsiPeriod) {
  if (!Array.isArray(closes) || closes.length < period + 1) {
    return Array.isArray(closes) ? closes.map(() => null) : [];
  }

  const values = closes.map((value) => finiteNumber(value));
  const out = new Array(values.length).fill(null);
  if (values.some((value) => value === null)) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    gains += Math.max(diff, 0);
    losses += Math.max(-diff, 0);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  function toRsi(gain, loss) {
    if (gain === 0 && loss === 0) return 50;
    if (loss === 0) return 100;
    const rs = gain / loss;
    return 100 - (100 / (1 + rs));
  }

  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function currentRsi(closes, period = CONFIG.rsiPeriod) {
  const series = calculateRsiSeries(closes, period);
  const value = series[series.length - 1];
  return Number.isFinite(value) ? value : null;
}

function percentileRank(values, current) {
  const x = finiteNumber(current);
  const clean = Array.isArray(values)
    ? values.map((value) => finiteNumber(value)).filter((value) => value !== null)
    : [];
  if (x === null || clean.length < 10) return null;
  const lessOrEqual = clean.filter((value) => value <= x).length;
  return (lessOrEqual / clean.length) * 100;
}

function normalizeBase(base) {
  return String(base || '').trim().toUpperCase();
}

function rankLookupKeys(base) {
  const normalized = normalizeBase(base);
  const keys = [normalized];
  if (/^1000000[A-Z0-9]+$/.test(normalized)) keys.push(normalized.slice(7));
  if (/^1000[A-Z0-9]+$/.test(normalized)) keys.push(normalized.slice(4));
  return [...new Set(keys.filter(Boolean))];
}

function hardFilterReasons(candidate) {
  const reasons = [];
  const base = normalizeBase(candidate.base);
  const rank = finiteNumber(candidate.rank);
  const listingAgeDays = finiteNumber(candidate.listingAgeDays);
  const volume = finiteNumber(candidate.quoteVolumeUsd);
  const dailyRsi = finiteNumber(candidate.dailyRsi);
  const return7d = finiteNumber(candidate.return7dPct);

  if (EXCLUDED_BASES.has(base)) reasons.push('excluded_asset');
  if (rank === null) reasons.push('rank_unavailable');
  else if (rank < CONFIG.rankMin || rank > CONFIG.rankMax) reasons.push('rank_outside_101_500');
  if (listingAgeDays === null || listingAgeDays < CONFIG.minListingAgeDays) reasons.push('listing_age_lt_90d');
  if (volume === null || volume < CONFIG.minQuoteVolumeUsd) reasons.push('volume_lt_20m');
  if (dailyRsi === null || dailyRsi <= CONFIG.dailyRsiMinExclusive) reasons.push('daily_rsi6_not_gt_93');
  if (return7d === null || return7d <= CONFIG.return7dMinExclusive) reasons.push('return_7d_not_gt_20');
  return reasons;
}

function trueRange(current, previousClose) {
  const high = finiteNumber(current?.high);
  const low = finiteNumber(current?.low);
  const prev = finiteNumber(previousClose);
  if (high === null || low === null) return null;
  if (prev === null) return high - low;
  return Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i += 1) {
    const tr = trueRange(candles[i], candles[i - 1]?.close);
    if (tr !== null) trs.push(tr);
  }
  if (trs.length < period) return null;
  let value = trs.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i < trs.length; i += 1) {
    value = ((value * (period - 1)) + trs[i]) / period;
  }
  return value;
}

function detectBearishDivergence(candles, rsiSeries) {
  if (!Array.isArray(candles) || candles.length < 6 || !Array.isArray(rsiSeries)) return false;
  const start = candles.length - 6;
  const previous = candles.slice(start, start + 3);
  const recent = candles.slice(start + 3);

  function peak(group, offset) {
    let best = null;
    group.forEach((candle, idx) => {
      const high = finiteNumber(candle.high);
      const rsi = finiteNumber(rsiSeries[offset + idx]);
      if (high === null || rsi === null) return;
      if (!best || high > best.high) best = { high, rsi };
    });
    return best;
  }

  const prevPeak = peak(previous, start);
  const recentPeak = peak(recent, start + 3);
  if (!prevPeak || !recentPeak) return false;
  return recentPeak.high > prevPeak.high * 1.002 && recentPeak.rsi < prevPeak.rsi - 2;
}

function analyzeReversal(oneHourCandles, fourHourCandles) {
  const one = Array.isArray(oneHourCandles) ? oneHourCandles : [];
  const four = Array.isArray(fourHourCandles) ? fourHourCandles : [];
  const oneRsi = calculateRsiSeries(one.map((c) => c.close));
  const fourRsi = calculateRsiSeries(four.map((c) => c.close));

  const last1 = one.at(-1);
  const last4 = four.at(-1);
  const prev4 = four.at(-2);
  const currentRsi1h = finiteNumber(oneRsi.at(-1));
  const currentRsi4h = finiteNumber(fourRsi.at(-1));
  const previousRsi4h = finiteNumber(fourRsi.at(-2));

  const prior1hRsi = oneRsi.slice(-13, -1).filter(Number.isFinite);
  const had1hOver90 = prior1hRsi.some((value) => value > 90);
  const rsi1hCrossBelow80 = currentRsi1h !== null && currentRsi1h < 80 && had1hOver90;

  const priorOneLows = one.slice(-4, -1).map((c) => finiteNumber(c.low)).filter((v) => v !== null);
  const structureBreak1h = last1 && priorOneLows.length === 3
    ? finiteNumber(last1.close) < Math.min(...priorOneLows)
    : false;

  const structureBreak4h = last4 && prev4
    ? finiteNumber(last4.close) < finiteNumber(prev4.low)
    : false;

  const recent4hRsi = fourRsi.slice(-7).filter(Number.isFinite);
  const peakRsi4h = recent4hRsi.length ? Math.max(...recent4hRsi) : null;
  const had4hOver85 = peakRsi4h !== null && peakRsi4h > 85;
  const rsi4hDeclining = currentRsi4h !== null && previousRsi4h !== null && currentRsi4h < previousRsi4h;
  const bearishDivergence = detectBearishDivergence(four, fourRsi);

  const atr4h = atr(four, 14);
  const recentHighs = four.slice(-6).map((c) => finiteNumber(c.high)).filter((v) => v !== null);
  const recentHigh = recentHighs.length ? Math.max(...recentHighs) : null;
  const referencePrice = finiteNumber(last4?.close);
  const invalidationPrice = recentHigh !== null && atr4h !== null ? recentHigh + (0.5 * atr4h) : recentHigh;
  const invalidationDistancePct = invalidationPrice !== null && referencePrice
    ? pctChange(invalidationPrice, referencePrice)
    : null;

  const signals = {
    bearishDivergence,
    structureBreak4h,
    rsi1hCrossBelow80,
    structureBreak1h,
  };

  return {
    rsi1h: currentRsi1h,
    rsi4h: currentRsi4h,
    peakRsi4h,
    had4hOver85,
    rsi4hDeclining,
    ...signals,
    reversalCount: Object.values(signals).filter(Boolean).length,
    atr4h,
    recentHigh,
    invalidationPrice,
    invalidationDistancePct,
  };
}

function scoreCandidate(candidate) {
  let score = 0;
  const rank = finiteNumber(candidate.rank);
  const listingAgeDays = finiteNumber(candidate.listingAgeDays);
  const quoteVolumeUsd = finiteNumber(candidate.quoteVolumeUsd);
  const dailyRsi = finiteNumber(candidate.dailyRsi);
  const return7d = finiteNumber(candidate.return7dPct);
  const fundingPercentile = finiteNumber(candidate.fundingPercentile);
  const oi24h = finiteNumber(candidate.oi24hPct);
  const oi7d = finiteNumber(candidate.oi7dPct);
  const reversal = candidate.reversal || {};
  const manualSqueezeRisk = candidate.manualSqueezeRisk === true;
  const manualVetoApplied = CONFIG.manualSqueezeRiskVeto && manualSqueezeRisk;

  const rankOk = rank !== null && rank >= CONFIG.rankMin && rank <= CONFIG.rankMax;
  const listingOk = listingAgeDays !== null && listingAgeDays >= CONFIG.minListingAgeDays;
  const liquidityOk = quoteVolumeUsd !== null && quoteVolumeUsd >= CONFIG.minQuoteVolumeUsd;
  const rsiOk = dailyRsi !== null && dailyRsi > CONFIG.dailyRsiMinExclusive;
  const returnOk = return7d !== null && return7d > CONFIG.return7dMinExclusive;
  const coreGatePassed = rankOk && listingOk && liquidityOk && rsiOk && returnOk;

  if (rankOk) score += 15;
  if (listingOk) score += 5;
  if (liquidityOk) score += 5;
  if (dailyRsi !== null) {
    if (dailyRsi > 96) score += 20;
    else if (dailyRsi > 94) score += 17;
    else if (rsiOk) score += 15;
  }
  if (return7d !== null) {
    if (return7d > 100) score += 15;
    else if (return7d > 50) score += 12;
    else if (returnOk) score += 10;
  }

  if (fundingPercentile !== null) {
    if (fundingPercentile >= 95) score += 30;
    else if (fundingPercentile >= CONFIG.fundingStrongPercentile) score += 25;
    else if (fundingPercentile >= CONFIG.fundingWatchPercentile) score += 10;
    else if (fundingPercentile >= 60) score += 5;
  }

  const oiStrong = (oi24h !== null && oi24h >= CONFIG.oi24hStrongPct)
    || (oi7d !== null && oi7d >= CONFIG.oi7dStrongPct);
  if (oiStrong) score += 5;
  else if ((oi24h !== null && oi24h > 0) || (oi7d !== null && oi7d > 0)) score += 2;

  const reversalCount = finiteNumber(reversal.reversalCount, 0);
  score += Math.min(10, reversalCount * 2.5);

  const criticalDataComplete = fundingPercentile !== null;
  let status = 'WATCH';
  if (!manualVetoApplied && coreGatePassed && fundingPercentile >= CONFIG.fundingStrongPercentile) {
    status = 'SHORT_SETUP';
  } else if (!manualVetoApplied && coreGatePassed && fundingPercentile >= CONFIG.fundingWatchPercentile) {
    status = 'STRONG_WATCH';
  }

  return {
    score,
    status,
    rankTier: 'TARGET_101_500',
    oiStrong,
    criticalDataComplete,
    coreGatePassed,
    manualSqueezeRisk,
    manualVetoApplied,
    maxHoldDays: CONFIG.maxHoldDays,
    hardStopPct: CONFIG.hardStopPct,
  };
}

module.exports = {
  CONFIG,
  EXCLUDED_BASES,
  MANUAL_REVIEW_POLICY,
  finiteNumber,
  pctChange,
  calculateRsiSeries,
  currentRsi,
  percentileRank,
  normalizeBase,
  rankLookupKeys,
  hardFilterReasons,
  analyzeReversal,
  scoreCandidate,
};
