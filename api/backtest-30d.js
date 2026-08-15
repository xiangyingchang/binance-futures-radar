'use strict';
const {
  CONFIG: STRATEGY,
  EXCLUDED_BASES,
  currentRsi,
  percentileRank,
  pctChange,
  rankLookupKeys,
  hardFilterReasons,
  analyzeReversal,
  scoreCandidate,
} = require('../lib/strategy');
const BINANCE_FUTURES = 'https://fapi.binance.com';
const COINGECKO_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const TZ_OFFSET_HOURS = 8;
const LOOKBACK_DAYS = 30;
const ASSUMED_TAKER_FEE_RATE = 0.0005;
const RUNTIME = Object.freeze({
  requestTimeoutMs: 15000,
  initialConcurrency: 14,
  detailConcurrency: 5,
  dailyLimit: 80,
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
      headers: { Accept: 'application/json', 'User-Agent': 'binance-futures-radar-backtest/1.0' },
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
  const dailyRsi = currentRsi(closes, rsiPeriod);
  const return7dPct = closes.length >= 8 ? pctChange(closes.at(-1), closes.at(-8)) : null;
  return { dailyRsi, return7dPct, livePrice: liveHour.close };
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
  const past90Start = ts - 90 * DAY;
  const history = rows.filter((r) => Number(r?.fundingTime) >= past90Start && Number(r?.fundingTime) <= ts).sort((a, b) => Number(a.fundingTime) - Number(b.fundingTime));
  if (history.length < 10) return { currentRate: null, percentile: null, samples: history.length };
  const currentRate = Number(history.at(-1)?.fundingRate);
  const rates = history.map((r) => Number(r?.fundingRate)).filter(Number.isFinite);
  return { currentRate, percentile: percentileRank(rates, currentRate), samples: rates.length };
}
function oiChangesAt(rows, ts) {
  const usable = (Array.isArray(rows) ? rows : []).map((r) => ({ timestamp: Number(r?.timestamp), value: Number(r?.sumOpenInterest) }))
    .filter((r) => Number.isFinite(r.timestamp) && Number.isFinite(r.value) && r.value > 0 && r.timestamp <= ts).sort((a, b) => a.timestamp - b.timestamp);
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
function fundingPnlForShort(fundingRows, entryTime, exitTime, notional) {
  let pnl = 0;
  for (const row of fundingRows) {
    const t = Number(row?.fundingTime), rate = Number(row?.fundingRate);
    if (Number.isFinite(t) && Number.isFinite(rate) && t > entryTime && t <= exitTime) pnl += notional * rate;
  }
  return pnl;
}
function simulateTrade(hourly, fundingRows, signal, notional, horizonHours, useStop = false) {
  const entry = nextEntry(hourly, signal.evalTime);
  if (!entry || !Number.isFinite(entry.price) || entry.price <= 0) return null;
  const targetTime = entry.time + horizonHours * HOUR;
  let exit = closeAtOrBefore(hourly, targetTime), exitReason = `${horizonHours}h`;
  if (!exit) return null;
  if (useStop && Number.isFinite(signal.invalidationPrice) && signal.invalidationPrice > entry.price) {
    for (const c of hourly) {
      if (c.openTime < entry.time || c.openTime >= exit.time) continue;
      if (Number(c.high) >= signal.invalidationPrice) { exit = { price: signal.invalidationPrice, time: c.openTime }; exitReason = 'stop'; break; }
    }
  }
  const grossPnl = notional * ((entry.price - exit.price) / entry.price);
  const fees = notional * ASSUMED_TAKER_FEE_RATE * 2;
  const fundingPnl = fundingPnlForShort(fundingRows, entry.time, exit.time, notional);
  const netPnl = grossPnl - fees + fundingPnl;
  return { entryTime: entry.time, entryPrice: entry.price, exitTime: exit.time, exitPrice: exit.price, exitReason, grossPnl, fees, fundingPnl, netPnl, returnPct: netPnl / notional * 100 };
}
function summarize(trades, key) {
  const done = trades.map((t) => t[key]).filter(Boolean);
  const net = done.reduce((s, x) => s + x.netPnl, 0), gross = done.reduce((s, x) => s + x.grossPnl, 0);
  const wins = done.filter((x) => x.netPnl > 0).length, losses = done.filter((x) => x.netPnl <= 0).length;
  let curve = 0, peak = 0, maxDrawdown = 0;
  for (const x of done) { curve += x.netPnl; peak = Math.max(peak, curve); maxDrawdown = Math.min(maxDrawdown, curve - peak); }
  return {
    trades: done.length, wins, losses, winRatePct: done.length ? wins / done.length * 100 : null, grossPnl: gross, netPnl: net,
    avgNetPnl: done.length ? net / done.length : null, maxDrawdownU: maxDrawdown,
    bestTradeU: done.length ? Math.max(...done.map((x) => x.netPnl)) : null,
    worstTradeU: done.length ? Math.min(...done.map((x) => x.netPnl)) : null,
  };
}
async function backtest() {
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
    if (!Number.isFinite(rank) || rank < STRATEGY.rankMin || rank > STRATEGY.rankMax) continue;
    universe.push({ symbol: info.symbol, base, rank, onboardDate: Number(info.onboardDate || 0) });
  }
  const initial = await runPool(universe, async (item) => {
    const [dailyRaw, hourlyRaw] = await Promise.all([
      futuresGet('/fapi/v1/klines', { symbol: item.symbol, interval: '1d', startTime: evalStart - 40 * DAY, endTime: now, limit: RUNTIME.dailyLimit }),
      futuresGet('/fapi/v1/klines', { symbol: item.symbol, interval: '1h', startTime: evalStart - 2 * DAY, endTime: now, limit: RUNTIME.hourlyLimit }),
    ]);
    const daily = parseKlines(dailyRaw), hourly = parseKlines(hourlyRaw), baseRows = [];
    for (const evalTime of evalTimes) {
      const listingAgeDays = item.onboardDate ? (evalTime - item.onboardDate) / DAY : null;
      const quoteVolumeUsd = rollingQuoteVolume24h(hourly, evalTime);
      for (const rsiPeriod of [14, 6]) {
        const live = liveDailyState(daily, hourly, evalTime, rsiPeriod);
        if (!live) continue;
        const candidate = { ...item, listingAgeDays, quoteVolumeUsd, dailyRsi: live.dailyRsi, return7dPct: live.return7dPct };
        if (!hardFilterReasons(candidate).length) baseRows.push({ evalTime, rsiPeriod, candidate });
      }
    }
    if (!baseRows.length) return null;
    return { item, hourly, baseRows };
  }, RUNTIME.initialConcurrency);
  const detailed = await runPool(initial.results, async (bundle) => {
    const { item, hourly, baseRows } = bundle;
    const fundingStart = evalStart - RUNTIME.fundingLookbackDays * DAY;
    const [fourRaw, fundingRows, oiRows] = await Promise.all([
      futuresGet('/fapi/v1/klines', { symbol: item.symbol, interval: '4h', startTime: evalStart - 35 * DAY, endTime: now, limit: RUNTIME.fourHourLimit }),
      fetchFundingHistory(item.symbol, fundingStart, now),
      futuresGet('/futures/data/openInterestHist', { symbol: item.symbol, period: '1d', limit: RUNTIME.oiLimit }).catch(() => []),
    ]);
    const four = parseKlines(fourRaw), signals = [];
    for (const row of baseRows) {
      const funding = fundingAt(fundingRows, row.evalTime), oi = oiChangesAt(oiRows, row.evalTime);
      const reversal = analyzeReversal(closedSlice(hourly, row.evalTime, 80), closedSlice(four, row.evalTime, 80));
      const score = scoreCandidate({ ...row.candidate, fundingPercentile: funding.percentile, oi24hPct: oi.oi24hPct, oi7dPct: oi.oi7dPct, reversal });
      if (score.status !== 'SHORT_SETUP') continue;
      signals.push({
        symbol: item.symbol, rank: item.rank, evalTime: row.evalTime, evalLocal: isoLocal(row.evalTime), rsiPeriod: row.rsiPeriod,
        dailyRsi: row.candidate.dailyRsi, return7dPct: row.candidate.return7dPct, quoteVolumeUsd: row.candidate.quoteVolumeUsd,
        fundingPercentile: funding.percentile, fundingRate: funding.currentRate, oi24hPct: oi.oi24hPct, oi7dPct: oi.oi7dPct,
        reversalCount: reversal.reversalCount, invalidationPrice: reversal.invalidationPrice, score: score.score,
      });
    }
    return { hourly, fundingRows, signals };
  }, RUNTIME.detailConcurrency);
  const variants = { rsi14: [], rsi6: [] };
  for (const bundle of detailed.results) for (const signal of bundle.signals) {
    const key = signal.rsiPeriod === 14 ? 'rsi14' : 'rsi6';
    variants[key].push({
      ...signal,
      pnl1d: simulateTrade(bundle.hourly, bundle.fundingRows, signal, 1000, 24, false),
      pnl3d: simulateTrade(bundle.hourly, bundle.fundingRows, signal, 1000, 72, false),
      pnl5d: simulateTrade(bundle.hourly, bundle.fundingRows, signal, 1000, 120, false),
      pnl3dWithStop: simulateTrade(bundle.hourly, bundle.fundingRows, signal, 1000, 72, true),
    });
  }
  for (const list of Object.values(variants)) list.sort((a, b) => a.evalTime - b.evalTime || a.symbol.localeCompare(b.symbol));
  return {
    generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
    window: { decisionTimezone: 'UTC+8', decisionTime: '00:00 daily', from: isoLocal(evalStart), to: isoLocal(evalEnd), decisionPoints: evalTimes.length },
    assumptions: {
      notionalPerSignalU: 1000, leverage: '1x notional assumption',
      rank: 'Current CoinGecko rank used as a 30-day proxy; not point-in-time historical rank.',
      universe: 'Currently active Binance USDT perpetual contracts only; delisted-in-window contracts are not included.',
      liquidity: 'Historical rolling 24h quote volume >=20m USDT.', catalystFilter: 'Not backtested; historical news/catalyst manual veto is omitted.',
      entry: 'Next 1h candle open immediately after the 00:00 UTC+8 decision point.', fee: 'Assumed 0.05% taker each side (1.0U round trip per 1000U notional).',
      funding: 'Historical settled funding included approximately at constant 1000U notional.',
      oi: 'Binance OI endpoint only exposes the latest month; early-window 7d OI can be unavailable, so those signals require 24h OI to qualify.',
      primaryExit: '3-day hold with production-style invalidation stop (recent 4h high + 0.5 ATR).',
    },
    diagnostics: { activePairs: active.length, rank101to500Universe: universe.length, symbolsPassingBaseHeatAtLeastOnce: initial.results.length, initialErrors: initial.errors, detailErrors: detailed.errors },
    variants: {
      rsi14: { signals: variants.rsi14.length, oneDay: summarize(variants.rsi14, 'pnl1d'), threeDay: summarize(variants.rsi14, 'pnl3d'), fiveDay: summarize(variants.rsi14, 'pnl5d'), threeDayWithStop: summarize(variants.rsi14, 'pnl3dWithStop'), trades: variants.rsi14 },
      rsi6: { signals: variants.rsi6.length, oneDay: summarize(variants.rsi6, 'pnl1d'), threeDay: summarize(variants.rsi6, 'pnl3d'), fiveDay: summarize(variants.rsi6, 'pnl5d'), threeDayWithStop: summarize(variants.rsi6, 'pnl3dWithStop'), trades: variants.rsi6 },
    },
  };
}
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const payload = await backtest();
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(error.status || 500).json({ error: 'Backtest failed', message: error.message || 'Unknown error', upstreamStatus: error.upstreamStatus || null, generatedAt: new Date().toISOString() });
  }
};
