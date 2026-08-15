'use strict';

const {
  EXCLUDED_BASES,
  currentRsi,
  percentileRank,
  pctChange,
  rankLookupKeys,
} = require('../lib/strategy');

const BINANCE_FUTURES = 'https://fapi.binance.com';
const BINANCE_PRODUCTS = 'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products';
const COINGECKO_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets';
const CMC_PUBLIC_LISTINGS = 'https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/listings/latest';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const TZ_OFFSET_HOURS = 8;
const LOOKBACK_DAYS = 180;
const MATURITY_DAYS = 3;
const NOTIONAL = 1000;
const FEE_RATE = 0.0005;
const STOP_PCT = 0.30;
const COOLDOWN_HOURS = 72;

const RUNTIME = Object.freeze({
  requestTimeoutMs: 15000,
  initialConcurrency: 18,
  detailConcurrency: 6,
  dailyLimit: 260,
  fourHourLimit: 1500,
  fundingLookbackDays: 90,
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
      headers: { Accept: 'application/json', 'User-Agent': 'binance-radar-tp-backtest/1.0' },
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      const message = payload?.status?.error_message || payload?.msg || payload?.message || `HTTP ${response.status}`;
      throw new UpstreamError(message, 502, response.status);
    }
    if (payload?.status?.error_code && Number(payload.status.error_code) !== 0) {
      throw new UpstreamError(payload.status.error_message || `CMC error ${payload.status.error_code}`, 502, response.status);
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new UpstreamError(`Timeout after ${timeoutMs / 1000}s`, 504);
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(error.message || 'Unable to reach upstream');
  } finally {
    clearTimeout(timer);
  }
}

function futuresGet(path, params = {}, timeoutMs) {
  return fetchJson(`${BINANCE_FUTURES}${path}`, params, timeoutMs);
}

function parseKlines(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
  })).filter((c) => Number.isFinite(c.close));
}

async function fetchKlinesPaged(symbol, interval, startTime, endTime) {
  const rows = [];
  let cursor = startTime;
  for (let page = 0; page < 8 && cursor < endTime; page += 1) {
    const batch = await futuresGet('/fapi/v1/klines', { symbol, interval, startTime: cursor, endTime, limit: 1500 });
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    const lastOpen = Number(batch.at(-1)?.[0]);
    if (!Number.isFinite(lastOpen) || lastOpen < cursor) break;
    cursor = lastOpen + 1;
    if (batch.length < 1500) break;
  }
  const dedup = new Map();
  for (const row of rows) dedup.set(Number(row[0]), row);
  return parseKlines([...dedup.values()].sort((a, b) => Number(a[0]) - Number(b[0])));
}

async function fetchFundingHistory(symbol, startTime, endTime) {
  const rows = [];
  let cursor = startTime;
  for (let page = 0; page < 5 && cursor < endTime; page += 1) {
    const batch = await futuresGet('/fapi/v1/fundingRate', { symbol, startTime: cursor, endTime, limit: 1000 });
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    const lastTime = Number(batch.at(-1)?.fundingTime);
    if (!Number.isFinite(lastTime) || lastTime < cursor) break;
    cursor = lastTime + 1;
    if (batch.length < 1000) break;
  }
  return rows;
}

function buildUniqueRankMap(rows, getter) {
  const counts = new Map();
  for (const item of Array.isArray(rows) ? rows : []) {
    const symbol = String(item?.symbol || '').toUpperCase();
    if (symbol) counts.set(symbol, (counts.get(symbol) || 0) + 1);
  }
  const map = new Map();
  for (const item of Array.isArray(rows) ? rows : []) {
    const symbol = String(item?.symbol || '').toUpperCase();
    const rank = Number(getter(item));
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
  return buildUniqueRankMap([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])], (x) => x?.market_cap_rank);
}

async function fetchCmcRanks() {
  const payload = await fetchJson(CMC_PUBLIC_LISTINGS, {
    start: 1, limit: 500, convert: 'USD', sort: 'market_cap', sort_dir: 'desc', cryptocurrency_type: 'all',
  });
  return buildUniqueRankMap(Array.isArray(payload?.data) ? payload.data : [], (x) => x?.cmc_rank);
}

function buildBinanceProxyRankMap(productList) {
  const caps = [];
  for (const item of Array.isArray(productList) ? productList : []) {
    if (item?.q !== 'USDT' || item?.cs == null) continue;
    const price = Number(item.c || 0);
    const supply = Number(item.cs || 0);
    if (price > 0 && supply > 0) caps.push({ base: String(item.b || '').toUpperCase(), cap: price * supply });
  }
  caps.sort((a, b) => b.cap - a.cap);
  const map = new Map();
  caps.forEach((x, i) => { if (x.base && !map.has(x.base)) map.set(x.base, i + 1); });
  return map;
}

function findRank(base, map) {
  for (const key of rankLookupKeys(base)) if (map?.has(key)) return Number(map.get(key));
  return null;
}

function rankState(base, cmcMap, cgMap, proxyMap) {
  const cmcRank = findRank(base, cmcMap);
  const cgRank = findRank(base, cgMap);
  const proxyRank = findRank(base, proxyMap);
  const ranks = [cmcRank, cgRank, proxyRank].filter(Number.isFinite);
  const anyTop100 = ranks.some((x) => x <= 100);
  const anyTarget = ranks.some((x) => x >= 101 && x <= 500);
  const anyAbove500 = ranks.some((x) => x > 500);
  const conflict = (anyTop100 && anyTarget) || (anyTarget && anyAbove500);
  return {
    cmcRank,
    cgRank,
    proxyRank,
    legacyEligible: Number.isFinite(cgRank) && cgRank >= 101 && cgRank <= 500,
    v6Eligible: Number.isFinite(cmcRank) && cmcRank >= 101 && cmcRank <= 500 && !anyTop100 && !conflict,
  };
}

function latestLocalMidnight(now = Date.now()) {
  const shifted = new Date(now + TZ_OFFSET_HOURS * HOUR);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TZ_OFFSET_HOURS * HOUR;
}

function evaluationTimes(now = Date.now()) {
  const end = latestLocalMidnight(now) - MATURITY_DAYS * DAY;
  return Array.from({ length: LOOKBACK_DAYS }, (_, i) => end - (LOOKBACK_DAYS - 1 - i) * DAY);
}

function isoLocal(ts) {
  return new Date(ts + TZ_OFFSET_HOURS * HOUR).toISOString().replace('T', ' ').slice(0, 16) + ' +08';
}

function findLatestBefore(rows, ts, timeKey = 'closeTime') {
  let best = null;
  for (const row of rows) {
    const t = Number(row?.[timeKey]);
    if (!Number.isFinite(t) || t > ts) continue;
    if (!best || t > Number(best[timeKey])) best = row;
  }
  return best;
}

function rollingVolume24hFrom4h(rows, ts) {
  const usable = rows.filter((c) => c.closeTime <= ts && c.closeTime > ts - DAY).slice(-6);
  if (usable.length < 6) return null;
  return usable.reduce((sum, c) => sum + Number(c.quoteVolume || 0), 0);
}

function liveDailyState(daily, fourHour, ts) {
  const currentUtcDayOpen = Math.floor(ts / DAY) * DAY;
  const prior = daily.filter((c) => c.openTime < currentUtcDayOpen && c.closeTime < ts).sort((a, b) => a.openTime - b.openTime);
  const live = findLatestBefore(fourHour, ts, 'closeTime');
  if (!live || prior.length < 14) return null;
  const closes = [...prior.map((c) => c.close), live.close];
  return {
    dailyRsi: currentRsi(closes, 6),
    return7dPct: closes.length >= 8 ? pctChange(closes.at(-1), closes.at(-8)) : null,
    livePrice: live.close,
  };
}

function fundingAt(rows, ts) {
  const start = ts - RUNTIME.fundingLookbackDays * DAY;
  const history = (Array.isArray(rows) ? rows : [])
    .filter((r) => Number(r?.fundingTime) >= start && Number(r?.fundingTime) <= ts)
    .sort((a, b) => Number(a.fundingTime) - Number(b.fundingTime));
  if (history.length < 10) return { rate: null, percentile: null, samples: history.length };
  const rates = history.map((r) => Number(r?.fundingRate)).filter(Number.isFinite);
  const rate = Number(history.at(-1)?.fundingRate);
  return { rate, percentile: percentileRank(rates, rate), samples: rates.length };
}

async function runPool(items, worker, concurrency) {
  const results = [];
  const errors = [];
  let cursor = 0;
  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        const value = await worker(items[index], index);
        if (value !== undefined && value !== null) results.push(value);
      } catch (error) {
        errors.push({ item: items[index]?.symbol || String(items[index]), message: error.message || 'unknown' });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, runner));
  return { results, errors };
}

function dedupeSignals(signals, policy) {
  const sorted = signals.filter((s) => s[policy]).sort((a, b) => a.evalTime - b.evalTime || a.symbol.localeCompare(b.symbol));
  const last = new Map();
  const out = [];
  for (const s of sorted) {
    const prev = last.get(s.symbol);
    if (prev != null && s.evalTime - prev < COOLDOWN_HOURS * HOUR) continue;
    last.set(s.symbol, s.evalTime);
    out.push(s);
  }
  return out;
}

function nextEntry(hourly, ts) {
  const row = hourly.find((c) => c.openTime >= ts);
  return row ? { price: row.open, time: row.openTime } : null;
}

function closeAtOrBefore(hourly, ts) {
  const row = findLatestBefore(hourly, ts, 'closeTime');
  return row ? { price: row.close, time: row.closeTime } : null;
}

function fundingPrice(hourly, ts, fallback) {
  return findLatestBefore(hourly, ts, 'closeTime')?.close || fallback;
}

function computeResult(entry, exits, hourly, fundingRows) {
  const initialQty = NOTIONAL / entry.price;
  const sorted = [...exits].sort((a, b) => a.time - b.time);
  const grossPnl = sorted.reduce((sum, x) => sum + x.qty * (entry.price - x.price), 0);
  const entryFee = NOTIONAL * FEE_RATE;
  const exitFees = sorted.reduce((sum, x) => sum + x.qty * x.price * FEE_RATE, 0);
  const finalExitTime = sorted.at(-1)?.time ?? entry.time;
  let fundingPnl = 0;
  for (const row of Array.isArray(fundingRows) ? fundingRows : []) {
    const t = Number(row?.fundingTime);
    const rate = Number(row?.fundingRate);
    if (!Number.isFinite(t) || !Number.isFinite(rate) || t <= entry.time || t > finalExitTime) continue;
    const exitedQty = sorted.filter((x) => x.time <= t).reduce((sum, x) => sum + x.qty, 0);
    const activeQty = Math.max(0, initialQty - exitedQty);
    if (activeQty <= 0) continue;
    fundingPnl += activeQty * fundingPrice(hourly, t, entry.price) * rate;
  }
  const fees = entryFee + exitFees;
  const netPnl = grossPnl - fees + fundingPnl;
  return {
    netPnl,
    grossPnl,
    fees,
    fundingPnl,
    returnPct: netPnl / NOTIONAL * 100,
    exitTime: finalExitTime,
    exitPriceWeighted: sorted.reduce((sum, x) => sum + x.price * x.qty, 0) / initialQty,
    exitReason: sorted.map((x) => x.reason).join('+'),
  };
}

function fullExitAtTime(hourly, entry, deadline, qty, reason = '72h') {
  const final = closeAtOrBefore(hourly, deadline);
  return final ? [{ qty, price: final.price, time: final.time, reason }] : null;
}

function simulateFull(hourly, fundingRows, signal, takeProfitPct = null) {
  const entry = nextEntry(hourly, signal.evalTime);
  if (!entry || entry.price <= 0) return null;
  const qty = NOTIONAL / entry.price;
  const stop = entry.price * (1 + STOP_PCT);
  const tp = Number.isFinite(takeProfitPct) ? entry.price * (1 - takeProfitPct) : null;
  const deadline = entry.time + 72 * HOUR;
  const candles = hourly.filter((c) => c.openTime >= entry.time && c.openTime < deadline);
  for (const c of candles) {
    if (Number(c.high) >= stop) {
      return computeResult(entry, [{ qty, price: stop, time: c.closeTime, reason: 'stop30' }], hourly, fundingRows);
    }
    if (tp !== null && Number(c.low) <= tp) {
      return computeResult(entry, [{ qty, price: tp, time: c.closeTime, reason: `tp${Math.round(takeProfitPct * 100)}` }], hourly, fundingRows);
    }
  }
  const exits = fullExitAtTime(hourly, entry, deadline, qty);
  return exits ? computeResult(entry, exits, hourly, fundingRows) : null;
}

function simulatePartial15Hold(hourly, fundingRows, signal, breakevenAfter = false) {
  const entry = nextEntry(hourly, signal.evalTime);
  if (!entry || entry.price <= 0) return null;
  const qty = NOTIONAL / entry.price;
  const half = qty / 2;
  const stop = entry.price * (1 + STOP_PCT);
  const tp = entry.price * 0.85;
  const deadline = entry.time + 72 * HOUR;
  const candles = hourly.filter((c) => c.openTime >= entry.time && c.openTime < deadline);
  let partial = null;
  let postStop = stop;
  let partialCandleTime = null;
  for (const c of candles) {
    if (!partial) {
      if (Number(c.high) >= stop) {
        return computeResult(entry, [{ qty, price: stop, time: c.closeTime, reason: 'stop30' }], hourly, fundingRows);
      }
      if (Number(c.low) <= tp) {
        partial = { qty: half, price: tp, time: c.closeTime, reason: 'tp15_half' };
        partialCandleTime = c.openTime;
        if (breakevenAfter) postStop = entry.price;
        continue;
      }
    } else if (c.openTime > partialCandleTime && Number(c.high) >= postStop) {
      return computeResult(entry, [partial, { qty: half, price: postStop, time: c.closeTime, reason: breakevenAfter ? 'be_stop' : 'stop30_rem' }], hourly, fundingRows);
    }
  }
  if (!partial) {
    const exits = fullExitAtTime(hourly, entry, deadline, qty);
    return exits ? computeResult(entry, exits, hourly, fundingRows) : null;
  }
  const final = closeAtOrBefore(hourly, deadline);
  if (!final) return null;
  return computeResult(entry, [partial, { qty: half, price: final.price, time: final.time, reason: '72h_rem' }], hourly, fundingRows);
}

function simulateTrailFull(hourly, fundingRows, signal, triggerPct, trailPct) {
  const entry = nextEntry(hourly, signal.evalTime);
  if (!entry || entry.price <= 0) return null;
  const qty = NOTIONAL / entry.price;
  const stop = entry.price * (1 + STOP_PCT);
  const trigger = entry.price * (1 - triggerPct);
  const deadline = entry.time + 72 * HOUR;
  const candles = hourly.filter((c) => c.openTime >= entry.time && c.openTime < deadline);
  let active = false;
  let trailStop = null;
  for (const c of candles) {
    if (!active) {
      if (Number(c.high) >= stop) return computeResult(entry, [{ qty, price: stop, time: c.closeTime, reason: 'stop30' }], hourly, fundingRows);
      if (Number(c.low) <= trigger) {
        active = true;
        trailStop = trigger * (1 + trailPct);
        if (Number(c.high) >= trailStop) {
          return computeResult(entry, [{ qty, price: trailStop, time: c.closeTime, reason: `trail${Math.round(trailPct * 100)}` }], hourly, fundingRows);
        }
      }
    } else {
      if (Number(c.high) >= trailStop) {
        return computeResult(entry, [{ qty, price: trailStop, time: c.closeTime, reason: `trail${Math.round(trailPct * 100)}` }], hourly, fundingRows);
      }
      const candidate = Number(c.low) * (1 + trailPct);
      if (Number.isFinite(candidate) && candidate < trailStop) trailStop = candidate;
    }
  }
  const exits = fullExitAtTime(hourly, entry, deadline, qty);
  return exits ? computeResult(entry, exits, hourly, fundingRows) : null;
}

function simulatePartial15Trail(hourly, fundingRows, signal, trailPct) {
  const entry = nextEntry(hourly, signal.evalTime);
  if (!entry || entry.price <= 0) return null;
  const qty = NOTIONAL / entry.price;
  const half = qty / 2;
  const stop = entry.price * (1 + STOP_PCT);
  const tp = entry.price * 0.85;
  const deadline = entry.time + 72 * HOUR;
  const candles = hourly.filter((c) => c.openTime >= entry.time && c.openTime < deadline);
  let partial = null;
  let trailStop = null;
  let partialCandleTime = null;
  for (const c of candles) {
    if (!partial) {
      if (Number(c.high) >= stop) return computeResult(entry, [{ qty, price: stop, time: c.closeTime, reason: 'stop30' }], hourly, fundingRows);
      if (Number(c.low) <= tp) {
        partial = { qty: half, price: tp, time: c.closeTime, reason: 'tp15_half' };
        partialCandleTime = c.openTime;
        trailStop = tp * (1 + trailPct);
        continue;
      }
    } else if (c.openTime > partialCandleTime) {
      if (Number(c.high) >= trailStop) {
        return computeResult(entry, [partial, { qty: half, price: trailStop, time: c.closeTime, reason: `trail${Math.round(trailPct * 100)}_rem` }], hourly, fundingRows);
      }
      const candidate = Number(c.low) * (1 + trailPct);
      if (Number.isFinite(candidate) && candidate < trailStop) trailStop = candidate;
    }
  }
  if (!partial) {
    const exits = fullExitAtTime(hourly, entry, deadline, qty);
    return exits ? computeResult(entry, exits, hourly, fundingRows) : null;
  }
  const final = closeAtOrBefore(hourly, deadline);
  if (!final) return null;
  return computeResult(entry, [partial, { qty: half, price: final.price, time: final.time, reason: '72h_rem' }], hourly, fundingRows);
}

function summarize(trades, key) {
  const done = trades.map((t) => t.results[key]).filter(Boolean);
  const net = done.reduce((sum, x) => sum + x.netPnl, 0);
  const wins = done.filter((x) => x.netPnl > 0).length;
  const grossProfit = done.filter((x) => x.netPnl > 0).reduce((sum, x) => sum + x.netPnl, 0);
  const grossLoss = Math.abs(done.filter((x) => x.netPnl < 0).reduce((sum, x) => sum + x.netPnl, 0));
  let curve = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const x of done) {
    curve += x.netPnl;
    peak = Math.max(peak, curve);
    maxDrawdown = Math.min(maxDrawdown, curve - peak);
  }
  return {
    trades: done.length,
    wins,
    winRatePct: done.length ? wins / done.length * 100 : null,
    netPnlU: net,
    avgPnlU: done.length ? net / done.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : null),
    maxDrawdownU: maxDrawdown,
    worstTradeU: done.length ? Math.min(...done.map((x) => x.netPnl)) : null,
    bestTradeU: done.length ? Math.max(...done.map((x) => x.netPnl)) : null,
    feesU: done.reduce((sum, x) => sum + x.fees, 0),
    fundingU: done.reduce((sum, x) => sum + x.fundingPnl, 0),
  };
}

const VARIANTS = [
  ['baseline_72h', '72h + stop30'],
  ['tp10', 'TP10% + stop30'],
  ['tp15', 'TP15% + stop30'],
  ['tp20', 'TP20% + stop30'],
  ['tp25', 'TP25% + stop30'],
  ['partial15_hold', 'TP15% half + remainder 72h'],
  ['partial15_be', 'TP15% half + remainder breakeven stop'],
  ['trail10_5', 'profit 10% activates 5% trail'],
  ['trail10_8', 'profit 10% activates 8% trail'],
  ['trail10_10', 'profit 10% activates 10% trail'],
  ['partial15_trail5', 'TP15% half + remainder 5% trail'],
  ['partial15_trail8', 'TP15% half + remainder 8% trail'],
  ['partial15_trail10', 'TP15% half + remainder 10% trail'],
];

async function backtest() {
  const startedAt = Date.now();
  const now = Date.now();
  const evalTimes = evaluationTimes(now);
  const evalStart = evalTimes[0];
  const evalEnd = evalTimes.at(-1);

  const [exchangeInfo, cmcMap, cgMap, productResponse] = await Promise.all([
    futuresGet('/fapi/v1/exchangeInfo'),
    fetchCmcRanks(),
    fetchCoinGeckoRanks(),
    fetchJson(BINANCE_PRODUCTS, { includeEtf: 'true' }).catch(() => ({ data: [] })),
  ]);
  const proxyMap = buildBinanceProxyRankMap(productResponse?.data);
  const active = (Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : []).filter((s) => (
    s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.underlyingType === 'COIN'
  ));
  const universe = [];
  for (const info of active) {
    const base = String(info.baseAsset || '').toUpperCase();
    if (EXCLUDED_BASES.has(base)) continue;
    const ranks = rankState(base, cmcMap, cgMap, proxyMap);
    if (!ranks.legacyEligible && !ranks.v6Eligible) continue;
    universe.push({ symbol: info.symbol, base, onboardDate: Number(info.onboardDate || 0), ...ranks });
  }

  const initial = await runPool(universe, async (item) => {
    const [dailyRaw, fourRaw] = await Promise.all([
      futuresGet('/fapi/v1/klines', {
        symbol: item.symbol, interval: '1d', startTime: evalStart - 35 * DAY, endTime: now, limit: RUNTIME.dailyLimit,
      }),
      futuresGet('/fapi/v1/klines', {
        symbol: item.symbol, interval: '4h', startTime: evalStart - 10 * DAY, endTime: now, limit: RUNTIME.fourHourLimit,
      }),
    ]);
    const daily = parseKlines(dailyRaw);
    const four = parseKlines(fourRaw);
    const heat = [];
    for (const evalTime of evalTimes) {
      const listingAgeDays = item.onboardDate ? (evalTime - item.onboardDate) / DAY : null;
      if (!Number.isFinite(listingAgeDays) || listingAgeDays < 90) continue;
      const volume24h = rollingVolume24hFrom4h(four, evalTime);
      if (!Number.isFinite(volume24h) || volume24h < 20_000_000) continue;
      const live = liveDailyState(daily, four, evalTime);
      if (!live || !Number.isFinite(live.dailyRsi) || live.dailyRsi <= 93) continue;
      if (!Number.isFinite(live.return7dPct) || live.return7dPct <= 20) continue;
      heat.push({
        symbol: item.symbol,
        evalTime,
        evalLocal: isoLocal(evalTime),
        dailyRsi: live.dailyRsi,
        return7dPct: live.return7dPct,
        volume24h,
        cmcRank: item.cmcRank,
        cgRank: item.cgRank,
        proxyRank: item.proxyRank,
        legacyEligible: item.legacyEligible,
        v6Eligible: item.v6Eligible,
      });
    }
    return heat.length ? { item, heat } : null;
  }, RUNTIME.initialConcurrency);

  const detailed = await runPool(initial.results, async (bundle) => {
    const fundingRows = await fetchFundingHistory(bundle.item.symbol, evalStart - 90 * DAY, now);
    const signals = [];
    for (const row of bundle.heat) {
      const funding = fundingAt(fundingRows, row.evalTime);
      if (!Number.isFinite(funding.percentile) || funding.percentile < 90) continue;
      signals.push({ ...row, fundingPercentile: funding.percentile, fundingRate: funding.rate, fundingSamples: funding.samples });
    }
    return signals.length ? { symbol: bundle.item.symbol, fundingRows, signals } : null;
  }, RUNTIME.detailConcurrency);

  const signalBundles = detailed.results.filter(Boolean);
  const allSignals = signalBundles.flatMap((x) => x.signals);
  const policies = {
    legacy: dedupeSignals(allSignals, 'legacyEligible'),
    v6: dedupeSignals(allSignals, 'v6Eligible'),
  };

  const bundleBySymbol = new Map(signalBundles.map((x) => [x.symbol, x]));
  const symbolsNeeded = [...new Set([...policies.legacy, ...policies.v6].map((s) => s.symbol))];
  const hourlyStage = await runPool(symbolsNeeded, async (symbol) => {
    const signals = [...policies.legacy, ...policies.v6].filter((s) => s.symbol === symbol);
    const minTs = Math.min(...signals.map((s) => s.evalTime));
    const maxTs = Math.max(...signals.map((s) => s.evalTime)) + 73 * HOUR;
    const hourly = await fetchKlinesPaged(symbol, '1h', minTs - HOUR, maxTs);
    return { symbol, hourly };
  }, RUNTIME.detailConcurrency);
  const hourlyBySymbol = new Map(hourlyStage.results.map((x) => [x.symbol, x.hourly]));

  function runPolicy(list) {
    const trades = [];
    for (const signal of list) {
      const hourly = hourlyBySymbol.get(signal.symbol) || [];
      const fundingRows = bundleBySymbol.get(signal.symbol)?.fundingRows || [];
      const results = {
        baseline_72h: simulateFull(hourly, fundingRows, signal, null),
        tp10: simulateFull(hourly, fundingRows, signal, 0.10),
        tp15: simulateFull(hourly, fundingRows, signal, 0.15),
        tp20: simulateFull(hourly, fundingRows, signal, 0.20),
        tp25: simulateFull(hourly, fundingRows, signal, 0.25),
        partial15_hold: simulatePartial15Hold(hourly, fundingRows, signal, false),
        partial15_be: simulatePartial15Hold(hourly, fundingRows, signal, true),
        trail10_5: simulateTrailFull(hourly, fundingRows, signal, 0.10, 0.05),
        trail10_8: simulateTrailFull(hourly, fundingRows, signal, 0.10, 0.08),
        trail10_10: simulateTrailFull(hourly, fundingRows, signal, 0.10, 0.10),
        partial15_trail5: simulatePartial15Trail(hourly, fundingRows, signal, 0.05),
        partial15_trail8: simulatePartial15Trail(hourly, fundingRows, signal, 0.08),
        partial15_trail10: simulatePartial15Trail(hourly, fundingRows, signal, 0.10),
      };
      trades.push({ signal, results });
    }
    return {
      signalCount: list.length,
      variants: Object.fromEntries(VARIANTS.map(([key, label]) => [key, { label, ...summarize(trades, key) }])),
      trades: trades.map((t) => ({
        symbol: t.signal.symbol,
        evalLocal: t.signal.evalLocal,
        cmcRank: t.signal.cmcRank,
        cgRank: t.signal.cgRank,
        rsi6: t.signal.dailyRsi,
        return7dPct: t.signal.return7dPct,
        fundingPercentile: t.signal.fundingPercentile,
        baselinePnlU: t.results.baseline_72h?.netPnl ?? null,
      })),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    window: {
      days: LOOKBACK_DAYS,
      from: isoLocal(evalStart),
      to: isoLocal(evalEnd),
      decisionTime: '00:00 UTC+8 daily',
      maturityBufferDays: MATURITY_DAYS,
    },
    entryRule: {
      rsi6: '>93 live daily',
      return7d: '>20%',
      funding: '>= trailing 90D P90',
      listed: '>=90d',
      historicalVolume24h: '>=20m USDT',
      sameSymbolCooldown: '72h',
      entry: 'next 1h open after decision point',
    },
    exitAssumptions: {
      hardStop: '+30% underlying price from entry for every variant until a tighter exit is activated',
      maxHold: '72h',
      fee: '0.05% taker per fill side; exit fees use exit notional',
      funding: 'historical settled funding approximated with contemporaneous hourly price and remaining position quantity',
      intrabarAmbiguity: 'conservative: stop is assumed before TP when both are touched in the same 1h candle',
      trailing: 'triggered after stated profit threshold; trail is measured as rebound from favorable low; 5/8/10% sensitivity tested',
    },
    limitations: [
      'Current market-cap ranks are used as a proxy for the full 180-day window, not point-in-time historical ranks.',
      'Only contracts that are currently active on Binance are included, so delisted-contract survivorship bias remains.',
      'Historical catalyst/news veto is omitted.',
      'Hourly OHLC cannot resolve exact intrabar event ordering; ambiguous bars use conservative ordering.',
    ],
    diagnostics: {
      activePairs: active.length,
      unionRankUniverse: universe.length,
      heatSymbols: initial.results.length,
      rawFundingQualifiedSignals: allSignals.length,
      legacySignalsAfterCooldown: policies.legacy.length,
      v6SignalsAfterCooldown: policies.v6.length,
      initialErrors: initial.errors,
      detailErrors: detailed.errors,
      hourlyErrors: hourlyStage.errors,
    },
    policies: {
      legacy_current_cg_rank: runPolicy(policies.legacy),
      v6_current_rank_consensus: runPolicy(policies.v6),
    },
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const payload = await backtest();
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(error.status || 500).json({
      error: 'TP backtest failed',
      message: error.message || 'Unknown error',
      upstreamStatus: error.upstreamStatus || null,
      generatedAt: new Date().toISOString(),
    });
  }
};
