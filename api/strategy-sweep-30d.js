'use strict';

const {
  CONFIG: STRATEGY,
  EXCLUDED_BASES,
  currentRsi,
  percentileRank,
  pctChange,
  rankLookupKeys,
  analyzeReversal,
} = require('../lib/strategy');

const BINANCE_FUTURES = 'https://fapi.binance.com';
const COINGECKO_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const TZ_OFFSET_HOURS = 8;
const LOOKBACK_DAYS = 30;
const NOTIONAL = 1000;
const FEE_RATE = 0.0005;

const RUNTIME = Object.freeze({
  requestTimeoutMs: 15000,
  initialConcurrency: 14,
  detailConcurrency: 5,
  dailyLimit: 90,
  hourlyLimit: 1000,
  fourHourLimit: 300,
  oiLimit: 500,
  fundingLookbackDays: 120,
});

class UpstreamError extends Error {
  constructor(message, status = 502, upstreamStatus = null) {
    super(message);
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

async function fetchJson(url, params = {}, timeoutMs = RUNTIME.requestTimeoutMs) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      headers: { Accept: 'application/json', 'User-Agent': 'binance-radar-strategy-sweep/1.0' },
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) throw new UpstreamError(payload?.msg || payload?.message || `HTTP ${response.status}`, 502, response.status);
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new UpstreamError(`Timeout after ${timeoutMs / 1000}s`, 504);
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(error.message || 'Unable to reach upstream');
  } finally {
    clearTimeout(timer);
  }
}

function futuresGet(path, params = {}) { return fetchJson(`${BINANCE_FUTURES}${path}`, params); }
function parseKlines(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
    volume: Number(row[5]), closeTime: Number(row[6]), quoteVolume: Number(row[7]),
  })).filter((c) => Number.isFinite(c.close));
}
function buildCoinGeckoRankMap(rows) {
  const counts = new Map();
  for (const coin of Array.isArray(rows) ? rows : []) {
    const symbol = String(coin?.symbol || '').toUpperCase();
    if (symbol) counts.set(symbol, (counts.get(symbol) || 0) + 1);
  }
  const map = new Map();
  for (const coin of Array.isArray(rows) ? rows : []) {
    const symbol = String(coin?.symbol || '').toUpperCase();
    const rank = Number(coin?.market_cap_rank);
    if (symbol && Number.isFinite(rank) && counts.get(symbol) === 1) map.set(symbol, rank);
  }
  return map;
}
async function fetchCoinGeckoRanks() {
  const shared = { vs_currency: 'usd', order: 'market_cap_desc', per_page: 250, sparkline: 'false' };
  const [a, b] = await Promise.all([
    fetchJson(COINGECKO_MARKETS, { ...shared, page: 1 }),
    fetchJson(COINGECKO_MARKETS, { ...shared, page: 2 }),
  ]);
  return buildCoinGeckoRankMap([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
}
function resolveRank(base, rankMap) {
  for (const key of rankLookupKeys(base)) if (rankMap.has(key)) return rankMap.get(key);
  return null;
}
function latestLocalMidnight(now = Date.now()) {
  const shifted = new Date(now + TZ_OFFSET_HOURS * HOUR);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TZ_OFFSET_HOURS * HOUR;
}
function evaluationTimes(now = Date.now()) {
  const end = latestLocalMidnight(now);
  return Array.from({ length: LOOKBACK_DAYS }, (_, i) => end - (LOOKBACK_DAYS - 1 - i) * DAY);
}
function isoLocal(ts) { return new Date(ts + TZ_OFFSET_HOURS * HOUR).toISOString().replace('T', ' ').slice(0, 16) + ' +08'; }
function findLatestBefore(rows, ts, timeKey = 'closeTime') {
  let best = null;
  for (const row of rows) {
    const t = Number(row?.[timeKey]);
    if (!Number.isFinite(t) || t > ts) continue;
    if (!best || t > Number(best[timeKey])) best = row;
  }
  return best;
}
function rollingQuoteVolume24h(hourly, ts) {
  const start = ts - DAY;
  let sum = 0, count = 0;
  for (const c of hourly) if (c.closeTime <= ts && c.closeTime > start) { sum += Number(c.quoteVolume || 0); count += 1; }
  return count >= 20 ? sum : null;
}
function liveDailyState(daily, hourly, ts, rsiPeriod) {
  const currentUtcDayOpen = Math.floor(ts / DAY) * DAY;
  const prior = daily.filter((c) => c.openTime < currentUtcDayOpen && c.closeTime < ts).sort((a, b) => a.openTime - b.openTime);
  const liveHour = findLatestBefore(hourly, ts, 'closeTime');
  if (!liveHour || prior.length < rsiPeriod + 7) return null;
  const closes = [...prior.map((c) => c.close), liveHour.close];
  return {
    dailyRsi: currentRsi(closes, rsiPeriod),
    return7dPct: closes.length >= 8 ? pctChange(closes.at(-1), closes.at(-8)) : null,
    livePrice: liveHour.close,
  };
}
async function runPool(items, worker, concurrency) {
  const results = [], errors = [];
  let cursor = 0;
  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        const value = await worker(items[index], index);
        if (value !== undefined && value !== null) results.push(value);
      } catch (error) { errors.push({ item: items[index]?.symbol || String(items[index]), message: error.message || 'unknown' }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, runner));
  return { results, errors };
}
async function fetchFundingHistory(symbol, startTime, endTime) {
  const rows = [];
  let cursor = startTime;
  for (let page = 0; page < 5 && cursor < endTime; page += 1) {
    const batch = await futuresGet('/fapi/v1/fundingRate', { symbol, startTime: cursor, endTime, limit: 1000 });
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    const lastTime = Number(batch.at(-1)?.fundingTime);
    if (!Number.isFinite(lastTime) || lastTime < cursor) break;
    cursor = lastTime + 1;
  }
  return rows;
}
function fundingAt(rows, ts) {
  const start = ts - 90 * DAY;
  const history = rows.filter((r) => Number(r?.fundingTime) >= start && Number(r?.fundingTime) <= ts)
    .sort((a, b) => Number(a.fundingTime) - Number(b.fundingTime));
  if (history.length < 10) return { currentRate: null, percentile: null, samples: history.length };
  const currentRate = Number(history.at(-1)?.fundingRate);
  const rates = history.map((r) => Number(r?.fundingRate)).filter(Number.isFinite);
  return { currentRate, percentile: percentileRank(rates, currentRate), samples: rates.length };
}
function oiChangesAt(rows, ts) {
  const usable = (Array.isArray(rows) ? rows : []).map((r) => ({ timestamp: Number(r?.timestamp), value: Number(r?.sumOpenInterest) }))
    .filter((r) => Number.isFinite(r.timestamp) && Number.isFinite(r.value) && r.value > 0 && r.timestamp <= ts)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!usable.length) return { oi24hPct: null, oi7dPct: null };
  const current = usable.at(-1);
  const nearest = (target) => {
    let best = null;
    for (const r of usable) if (r.timestamp <= target && (!best || r.timestamp > best.timestamp)) best = r;
    return best;
  };
  const p24 = nearest(current.timestamp - DAY), p7 = nearest(current.timestamp - 7 * DAY);
  return { oi24hPct: p24 ? pctChange(current.value, p24.value) : null, oi7dPct: p7 ? pctChange(current.value, p7.value) : null };
}
function closedSlice(candles, ts, limit = 80) { return candles.filter((c) => c.closeTime <= ts).slice(-limit); }
function nextEntry(hourly, ts) {
  const row = hourly.find((c) => c.openTime >= ts);
  return row ? { price: row.open, time: row.openTime } : null;
}
function closeAtOrBefore(hourly, ts) {
  const row = findLatestBefore(hourly, ts, 'closeTime');
  return row ? { price: row.close, time: row.closeTime } : null;
}
function fundingPnlForShort(rows, entryTime, exitTime, notional) {
  let pnl = 0;
  for (const row of rows) {
    const t = Number(row?.fundingTime), rate = Number(row?.fundingRate);
    if (Number.isFinite(t) && Number.isFinite(rate) && t > entryTime && t <= exitTime) pnl += notional * rate;
  }
  return pnl;
}
function simulateTrade(hourly, fundingRows, signal, horizonHours, useStop = false) {
  const entry = nextEntry(hourly, signal.evalTime);
  if (!entry || !Number.isFinite(entry.price) || entry.price <= 0) return null;
  const targetTime = entry.time + horizonHours * HOUR;
  let exit = closeAtOrBefore(hourly, targetTime), exitReason = `${horizonHours}h`;
  if (!exit) return null;
  if (useStop && Number.isFinite(signal.invalidationPrice) && signal.invalidationPrice > entry.price) {
    for (const c of hourly) {
      if (c.openTime < entry.time || c.openTime >= exit.time) continue;
      if (Number(c.high) >= signal.invalidationPrice) {
        exit = { price: signal.invalidationPrice, time: c.openTime };
        exitReason = 'stop';
        break;
      }
    }
  }
  const grossPnl = NOTIONAL * ((entry.price - exit.price) / entry.price);
  const fees = NOTIONAL * FEE_RATE * 2;
  const fundingPnl = fundingPnlForShort(fundingRows, entry.time, exit.time, NOTIONAL);
  return {
    netPnl: grossPnl - fees + fundingPnl,
    grossPnl,
    fundingPnl,
    fees,
    returnPct: (grossPnl - fees + fundingPnl) / NOTIONAL * 100,
    entryTime: entry.time,
    exitTime: exit.time,
    exitReason,
  };
}
function profitFactor(done) {
  const grossProfit = done.filter((x) => x.netPnl > 0).reduce((s, x) => s + x.netPnl, 0);
  const grossLoss = Math.abs(done.filter((x) => x.netPnl < 0).reduce((s, x) => s + x.netPnl, 0));
  if (grossLoss === 0) return grossProfit > 0 ? 99 : null;
  return grossProfit / grossLoss;
}
function summarizeSignals(signals, pnlKey) {
  const done = signals.map((s) => s[pnlKey]).filter(Boolean);
  const netPnl = done.reduce((s, x) => s + x.netPnl, 0);
  const wins = done.filter((x) => x.netPnl > 0).length;
  let curve = 0, peak = 0, maxDrawdownU = 0;
  for (const x of done) {
    curve += x.netPnl;
    peak = Math.max(peak, curve);
    maxDrawdownU = Math.min(maxDrawdownU, curve - peak);
  }
  return {
    trades: done.length,
    winRatePct: done.length ? wins / done.length * 100 : null,
    netPnl,
    avgPnlU: done.length ? netPnl / done.length : null,
    profitFactor: profitFactor(done),
    maxDrawdownU,
    worstTradeU: done.length ? Math.min(...done.map((x) => x.netPnl)) : null,
    bestTradeU: done.length ? Math.max(...done.map((x) => x.netPnl)) : null,
  };
}
function dedupeSignals(signals, cooldownHours = 72) {
  const sorted = [...signals].sort((a, b) => a.evalTime - b.evalTime || a.symbol.localeCompare(b.symbol));
  const last = new Map(), out = [];
  for (const signal of sorted) {
    const prev = last.get(signal.symbol);
    if (prev != null && signal.evalTime - prev < cooldownHours * HOUR) continue;
    last.set(signal.symbol, signal.evalTime);
    out.push(signal);
  }
  return out;
}
function oiPass(signal, mode) {
  if (mode === 'none') return true;
  const a = Number(signal.oi24hPct), b = Number(signal.oi7dPct);
  if (mode === 'positive') return (Number.isFinite(a) && a > 0) || (Number.isFinite(b) && b > 0);
  if (mode === 'moderate') return (Number.isFinite(a) && a >= 10) || (Number.isFinite(b) && b >= 15);
  if (mode === 'strong') return (Number.isFinite(a) && a >= 20) || (Number.isFinite(b) && b >= 30);
  return false;
}
function fundingPass(signal, minPercentile) {
  if (minPercentile === 0) return true;
  const x = Number(signal.fundingPercentile);
  return Number.isFinite(x) && x >= minPercentile;
}
function parameterGrid() {
  const specs = [];
  const rsiByPeriod = {
    14: [82, 85, 88, 90, 92],
    6: [90, 93, 95, 97],
  };
  for (const period of [14, 6]) for (const rsiMin of rsiByPeriod[period]) {
    for (const return7dMin of [20, 30, 40, 50]) {
      for (const fundingMin of [0, 60, 75, 90]) {
        for (const oiMode of ['none', 'positive', 'moderate', 'strong']) {
          for (const reversalMin of [0, 1, 2]) {
            for (const rankMax of [300, 500]) {
              specs.push({ period, rsiMin, return7dMin, fundingMin, oiMode, reversalMin, rankMax });
            }
          }
        }
      }
    }
  }
  return specs;
}
function comboKey(x) {
  return `rsi${x.period}>${x.rsiMin}|7d>${x.return7dMin}|fund>=P${x.fundingMin}|oi=${x.oiMode}|rev>=${x.reversalMin}|rank<=${x.rankMax}`;
}
function qualityScore(summary) {
  if (!summary || summary.trades < 5 || !Number.isFinite(summary.profitFactor)) return -Infinity;
  const pf = Math.min(summary.profitFactor, 4);
  const win = Number(summary.winRatePct || 0) / 100;
  const avg = Number(summary.avgPnlU || 0) / 20;
  const ddPenalty = Math.abs(Number(summary.maxDrawdownU || 0)) / 200;
  return pf * 2 + win + avg - ddPenalty;
}

async function sweep() {
  const startedAt = Date.now(), now = Date.now();
  const evalTimes = evaluationTimes(now), evalStart = evalTimes[0], evalEnd = evalTimes.at(-1);
  const [exchangeInfo, rankMap] = await Promise.all([futuresGet('/fapi/v1/exchangeInfo'), fetchCoinGeckoRanks()]);
  const active = (Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : []).filter((s) => (
    s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.underlyingType === 'COIN'
  ));
  const universe = [];
  for (const info of active) {
    const base = String(info.baseAsset || '').toUpperCase();
    if (EXCLUDED_BASES.has(base)) continue;
    const rank = resolveRank(base, rankMap);
    if (!Number.isFinite(rank) || rank < 101 || rank > 500) continue;
    universe.push({ symbol: info.symbol, base, rank, onboardDate: Number(info.onboardDate || 0) });
  }

  const initial = await runPool(universe, async (item) => {
    const [dailyRaw, hourlyRaw] = await Promise.all([
      futuresGet('/fapi/v1/klines', { symbol: item.symbol, interval: '1d', startTime: evalStart - 50 * DAY, endTime: now, limit: RUNTIME.dailyLimit }),
      futuresGet('/fapi/v1/klines', { symbol: item.symbol, interval: '1h', startTime: evalStart - 2 * DAY, endTime: now, limit: RUNTIME.hourlyLimit }),
    ]);
    const daily = parseKlines(dailyRaw), hourly = parseKlines(hourlyRaw), broadRows = [];
    for (const evalTime of evalTimes) {
      const listingAgeDays = item.onboardDate ? (evalTime - item.onboardDate) / DAY : null;
      const quoteVolumeUsd = rollingQuoteVolume24h(hourly, evalTime);
      if (!Number.isFinite(listingAgeDays) || listingAgeDays < 90) continue;
      if (!Number.isFinite(quoteVolumeUsd) || quoteVolumeUsd < 20_000_000) continue;
      for (const period of [14, 6]) {
        const live = liveDailyState(daily, hourly, evalTime, period);
        if (!live) continue;
        const broadHeat = period === 14
          ? live.dailyRsi > 80 && live.return7dPct > 15
          : live.dailyRsi > 88 && live.return7dPct > 15;
        if (!broadHeat) continue;
        broadRows.push({
          symbol: item.symbol, rank: item.rank, evalTime, evalLocal: isoLocal(evalTime), period,
          listingAgeDays, quoteVolumeUsd, dailyRsi: live.dailyRsi, return7dPct: live.return7dPct,
        });
      }
    }
    if (!broadRows.length) return null;
    return { item, hourly, broadRows };
  }, RUNTIME.initialConcurrency);

  const detailed = await runPool(initial.results, async (bundle) => {
    const { item, hourly, broadRows } = bundle;
    const fundingStart = evalStart - RUNTIME.fundingLookbackDays * DAY;
    const [fourRaw, fundingRows, oiRows] = await Promise.all([
      futuresGet('/fapi/v1/klines', { symbol: item.symbol, interval: '4h', startTime: evalStart - 35 * DAY, endTime: now, limit: RUNTIME.fourHourLimit }),
      fetchFundingHistory(item.symbol, fundingStart, now),
      futuresGet('/futures/data/openInterestHist', { symbol: item.symbol, period: '1d', limit: RUNTIME.oiLimit }).catch(() => []),
    ]);
    const four = parseKlines(fourRaw), signals = [];
    for (const row of broadRows) {
      const funding = fundingAt(fundingRows, row.evalTime), oi = oiChangesAt(oiRows, row.evalTime);
      const reversal = analyzeReversal(closedSlice(hourly, row.evalTime, 80), closedSlice(four, row.evalTime, 80));
      const signal = {
        ...row,
        fundingPercentile: funding.percentile,
        fundingRate: funding.currentRate,
        oi24hPct: oi.oi24hPct,
        oi7dPct: oi.oi7dPct,
        reversalCount: reversal.reversalCount,
        invalidationPrice: reversal.invalidationPrice,
      };
      signal.pnl1d = simulateTrade(hourly, fundingRows, signal, 24, false);
      signal.pnl3d = simulateTrade(hourly, fundingRows, signal, 72, false);
      signal.pnl5d = simulateTrade(hourly, fundingRows, signal, 120, false);
      signal.pnl3dStop = simulateTrade(hourly, fundingRows, signal, 72, true);
      signals.push(signal);
    }
    return signals;
  }, RUNTIME.detailConcurrency);

  const allSignals = detailed.results.flat();
  const combos = [];
  for (const spec of parameterGrid()) {
    let selected = allSignals.filter((s) => (
      s.period === spec.period
      && s.rank <= spec.rankMax
      && s.dailyRsi > spec.rsiMin
      && s.return7dPct > spec.return7dMin
      && fundingPass(s, spec.fundingMin)
      && oiPass(s, spec.oiMode)
      && Number(s.reversalCount || 0) >= spec.reversalMin
    ));
    selected = dedupeSignals(selected, 72);
    const oneDay = summarizeSignals(selected, 'pnl1d');
    const threeDay = summarizeSignals(selected, 'pnl3d');
    const fiveDay = summarizeSignals(selected, 'pnl5d');
    const threeDayStop = summarizeSignals(selected, 'pnl3dStop');
    combos.push({
      ...spec,
      key: comboKey(spec),
      oneDay,
      threeDay,
      fiveDay,
      threeDayStop,
      quality: qualityScore(threeDayStop),
      sampleSignals: selected.slice(0, 20).map((s) => ({
        symbol: s.symbol, rank: s.rank, evalLocal: s.evalLocal, dailyRsi: s.dailyRsi, return7dPct: s.return7dPct,
        fundingPercentile: s.fundingPercentile, oi24hPct: s.oi24hPct, oi7dPct: s.oi7dPct,
        reversalCount: s.reversalCount, pnl3dU: s.pnl3d?.netPnl ?? null, pnl3dStopU: s.pnl3dStop?.netPnl ?? null,
      })),
    });
  }

  const eligible = combos.filter((x) => Number.isFinite(x.quality)).sort((a, b) => b.quality - a.quality);
  const robust = eligible.filter((x) => (
    x.threeDayStop.trades >= 5
    && x.threeDayStop.netPnl > 0
    && x.threeDayStop.profitFactor >= 1.3
    && x.threeDayStop.winRatePct >= 50
    && x.threeDay.netPnl > 0
  ));

  const stageDefinitions = [
    { name: 'A_heat_only', period: 14, rsiMin: 90, return7dMin: 50, fundingMin: 0, oiMode: 'none', reversalMin: 0, rankMax: 500 },
    { name: 'B_plus_funding75', period: 14, rsiMin: 90, return7dMin: 50, fundingMin: 75, oiMode: 'none', reversalMin: 0, rankMax: 500 },
    { name: 'C_plus_moderate_oi', period: 14, rsiMin: 90, return7dMin: 50, fundingMin: 75, oiMode: 'moderate', reversalMin: 0, rankMax: 500 },
    { name: 'D_plus_one_reversal', period: 14, rsiMin: 90, return7dMin: 50, fundingMin: 75, oiMode: 'moderate', reversalMin: 1, rankMax: 500 },
    { name: 'E_current_strict', period: 14, rsiMin: 90, return7dMin: 50, fundingMin: 90, oiMode: 'strong', reversalMin: 2, rankMax: 500 },
  ];
  const stages = stageDefinitions.map((spec) => {
    const match = combos.find((x) => x.period === spec.period && x.rsiMin === spec.rsiMin && x.return7dMin === spec.return7dMin
      && x.fundingMin === spec.fundingMin && x.oiMode === spec.oiMode && x.reversalMin === spec.reversalMin && x.rankMax === spec.rankMax);
    return { name: spec.name, ...spec, oneDay: match?.oneDay, threeDay: match?.threeDay, fiveDay: match?.fiveDay, threeDayStop: match?.threeDayStop };
  });

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    window: { from: isoLocal(evalStart), to: isoLocal(evalEnd), decisionTimezone: 'UTC+8', decisionTime: '00:00 daily', days: LOOKBACK_DAYS },
    assumptions: {
      notionalPerSignalU: NOTIONAL,
      signalCooldown: 'Same symbol cannot open a new signal for 72h in ranked results.',
      rank: 'Current CoinGecko rank proxy, not historical point-in-time rank.',
      universe: 'Currently active Binance USDT perpetuals only.',
      liquidity: 'Historical rolling 24h quote volume >=20m USDT.',
      entry: 'Next 1h open after 00:00 UTC+8.',
      fees: '0.05% taker each side.',
      funding: 'Included.',
      catalystFilter: 'Omitted.',
      optimizationWarning: '30-day parameter sweep is exploratory and can overfit. Any winner must be validated on a longer/out-of-sample window before production use.',
    },
    diagnostics: {
      activePairs: active.length,
      rank101to500Universe: universe.length,
      broadCandidateSymbols: initial.results.length,
      broadSignals: allSignals.length,
      initialErrors: initial.errors,
      detailErrors: detailed.errors,
      gridSize: combos.length,
      eligibleWithAtLeast5Trades: eligible.length,
      robustCount: robust.length,
    },
    stages,
    topRobust: robust.slice(0, 20),
    topByQuality: eligible.slice(0, 20),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const payload = await sweep();
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(error.status || 500).json({ error: 'Strategy sweep failed', message: error.message || 'Unknown error', upstreamStatus: error.upstreamStatus || null, generatedAt: new Date().toISOString() });
  }
};