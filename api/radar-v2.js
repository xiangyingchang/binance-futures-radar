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
const BINANCE_PRODUCTS = 'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products';
const COINGECKO_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets';

const RUNTIME = Object.freeze({
  requestTimeoutMs: 12000,
  coinGeckoTimeoutMs: 8000,
  dailyKlineLimit: 60,
  intradayKlineLimit: 80,
  initialConcurrency: 16,
  detailConcurrency: 5,
  depthLimit: 100,
  fundingLookbackDays: 90,
  oiLookbackHours: 169,
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
      headers: {
        Accept: 'application/json',
        'User-Agent': 'binance-futures-radar/3.0',
      },
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      // Keep HTTP status when upstream sends a non-JSON body.
    }

    if (!response.ok) {
      const message = payload?.msg || payload?.message || `HTTP ${response.status}`;
      throw new UpstreamError(message, 502, response.status);
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new UpstreamError(`Request timed out after ${timeoutMs / 1000}s`, 504);
    }
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
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
  })).filter((c) => Number.isFinite(c.close));
}

function closedCandles(candles, now = Date.now()) {
  return candles.filter((candle) => candle.closeTime < now);
}

function fundingApr(rate, intervalHours) {
  const r = Number(rate);
  const interval = Number(intervalHours) > 0 ? Number(intervalHours) : 8;
  if (!Number.isFinite(r)) return null;
  return r * (24 / interval) * 365 * 100;
}

function buildBinanceRankMap(productList) {
  const marketCaps = [];
  for (const item of Array.isArray(productList) ? productList : []) {
    if (item?.q !== 'USDT' || item?.cs == null) continue;
    const price = Number(item.c || 0);
    const supply = Number(item.cs || 0);
    if (price > 0 && supply > 0) {
      marketCaps.push({ base: String(item.b || '').toUpperCase(), marketCap: price * supply });
    }
  }
  marketCaps.sort((a, b) => b.marketCap - a.marketCap);
  const map = new Map();
  marketCaps.forEach((item, index) => {
    if (item.base && !map.has(item.base)) map.set(item.base, index + 1);
  });
  return map;
}

function buildCoinGeckoRankMap(rows) {
  const symbolCounts = new Map();
  for (const coin of Array.isArray(rows) ? rows : []) {
    const symbol = String(coin?.symbol || '').toUpperCase();
    if (!symbol) continue;
    symbolCounts.set(symbol, (symbolCounts.get(symbol) || 0) + 1);
  }

  const map = new Map();
  for (const coin of Array.isArray(rows) ? rows : []) {
    const symbol = String(coin?.symbol || '').toUpperCase();
    const rank = Number(coin?.market_cap_rank);
    if (!symbol || !Number.isFinite(rank) || symbolCounts.get(symbol) !== 1) continue;
    map.set(symbol, rank);
  }
  return map;
}

async function fetchCoinGeckoRanks() {
  const shared = {
    vs_currency: 'usd',
    order: 'market_cap_desc',
    per_page: 250,
    sparkline: 'false',
  };
  const [page1, page2] = await Promise.all([
    fetchJson(COINGECKO_MARKETS, { ...shared, page: 1 }, RUNTIME.coinGeckoTimeoutMs),
    fetchJson(COINGECKO_MARKETS, { ...shared, page: 2 }, RUNTIME.coinGeckoTimeoutMs),
  ]);
  return buildCoinGeckoRankMap([
    ...(Array.isArray(page1) ? page1 : []),
    ...(Array.isArray(page2) ? page2 : []),
  ]);
}

function resolveRank(base, coinGeckoMap, binanceMap) {
  for (const key of rankLookupKeys(base)) {
    if (coinGeckoMap?.has(key)) return { rank: coinGeckoMap.get(key), rankSource: 'coingecko' };
  }
  for (const key of rankLookupKeys(base)) {
    if (binanceMap?.has(key)) return { rank: binanceMap.get(key), rankSource: 'binance_marketcap_proxy' };
  }
  return { rank: null, rankSource: 'unavailable' };
}

function analyzeDepth(data) {
  if (!Array.isArray(data?.bids) || !Array.isArray(data?.asks)) {
    return { depthRatio: null, bidPower: null, askPower: null };
  }
  const bidPower = data.bids.reduce((sum, [price, qty]) => sum + Number(price) * Number(qty), 0);
  const askPower = data.asks.reduce((sum, [price, qty]) => sum + Number(price) * Number(qty), 0);
  return {
    depthRatio: askPower > 0 ? bidPower / askPower : null,
    bidPower,
    askPower,
  };
}

async function runPool(items, worker, concurrency) {
  const results = [];
  const errors = [];
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        const result = await worker(items[index], index);
        if (result !== undefined && result !== null) results.push(result);
      } catch (error) {
        errors.push({ item: items[index]?.symbol || String(items[index]), message: error.message || 'unknown error' });
      }
    }
  }

  const count = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: count }, runner));
  return { results, errors };
}

function computeOiChanges(rows) {
  const data = Array.isArray(rows) ? rows : [];
  if (data.length < 2) return { oi24hPct: null, oi7dPct: null, oiSamples: data.length };
  const current = Number(data.at(-1)?.sumOpenInterest);
  if (!Number.isFinite(current) || current <= 0) {
    return { oi24hPct: null, oi7dPct: null, oiSamples: data.length };
  }

  const currentTs = Number(data.at(-1)?.timestamp || 0);
  const nearestBefore = (hours) => {
    const target = currentTs - (hours * 60 * 60 * 1000);
    let best = null;
    for (const row of data) {
      const ts = Number(row?.timestamp || 0);
      const value = Number(row?.sumOpenInterest);
      if (!Number.isFinite(ts) || !Number.isFinite(value) || value <= 0 || ts > target) continue;
      if (!best || ts > best.ts) best = { ts, value };
    }
    return best?.value ?? null;
  };

  const prior24h = nearestBefore(24);
  const prior7d = nearestBefore(24 * 7);
  return {
    oi24hPct: prior24h ? pctChange(current, prior24h) : null,
    oi7dPct: prior7d ? pctChange(current, prior7d) : null,
    oiSamples: data.length,
  };
}

function statusOrder(status) {
  if (status === 'SHORT_SETUP') return 3;
  if (status === 'STRONG_WATCH') return 2;
  return 1;
}

async function enrichCandidate(candidate, context) {
  const { premiumMap, fundingIntervalMap } = context;
  const now = Date.now();
  const dataErrors = [];

  const safe = async (name, fn, fallback) => {
    try {
      return await fn();
    } catch (error) {
      dataErrors.push(`${name}: ${error.message || 'failed'}`);
      return fallback;
    }
  };

  const [fundingHistory, oiHistory, k1hRaw, k4hRaw, depthData] = await Promise.all([
    safe('funding_history', () => futuresGet('/fapi/v1/fundingRate', {
      symbol: candidate.symbol,
      startTime: now - (RUNTIME.fundingLookbackDays * 24 * 60 * 60 * 1000),
      endTime: now,
      limit: 1000,
    }), []),
    safe('oi_history', () => futuresGet('/futures/data/openInterestHist', {
      symbol: candidate.symbol,
      period: '1h',
      limit: RUNTIME.oiLookbackHours,
    }), []),
    safe('1h_klines', () => futuresGet('/fapi/v1/klines', {
      symbol: candidate.symbol,
      interval: '1h',
      limit: RUNTIME.intradayKlineLimit,
    }), []),
    safe('4h_klines', () => futuresGet('/fapi/v1/klines', {
      symbol: candidate.symbol,
      interval: '4h',
      limit: RUNTIME.intradayKlineLimit,
    }), []),
    safe('depth', () => futuresGet('/fapi/v1/depth', {
      symbol: candidate.symbol,
      limit: RUNTIME.depthLimit,
    }), null),
  ]);

  const interval = fundingIntervalMap[candidate.symbol] || 8;
  const currentFunding = Number(premiumMap[candidate.symbol]?.lastFundingRate || 0);
  const historicalRates = (Array.isArray(fundingHistory) ? fundingHistory : [])
    .map((row) => Number(row?.fundingRate))
    .filter(Number.isFinite);
  const fundingPercentile = percentileRank(historicalRates, currentFunding);
  const oi = computeOiChanges(oiHistory);
  const reversal = analyzeReversal(
    closedCandles(parseKlines(k1hRaw), now),
    closedCandles(parseKlines(k4hRaw), now),
  );
  const score = scoreCandidate({
    ...candidate,
    fundingPercentile,
    ...oi,
    reversal,
  });

  const riskFlags = [];
  if (Number.isFinite(reversal.invalidationDistancePct) && reversal.invalidationDistancePct > 25) {
    riskFlags.push('wide_invalidation_gt_25pct');
  }
  if (candidate.rankSource !== 'coingecko') riskFlags.push('rank_uses_proxy_source');
  if (dataErrors.length) riskFlags.push('incomplete_market_data');

  return {
    ...candidate,
    currentFundingRate: currentFunding,
    fundingIntervalHours: interval,
    fundingApr: fundingApr(currentFunding, interval),
    fundingPercentile,
    fundingHistorySamples: historicalRates.length,
    ...oi,
    reversal,
    ...analyzeDepth(depthData),
    ...score,
    riskFlags,
    dataErrors,
    catalystReviewRequired: true,
    autoTrade: false,
    decisionGate: score.status === 'SHORT_SETUP'
      ? 'CATALYST_REVIEW_REQUIRED'
      : 'WAIT_FOR_BETTER_SETUP',
  };
}

async function scanMarket() {
  const startedAt = Date.now();
  const now = Date.now();
  const warnings = [];

  const [exchangeInfo, tickerList, premiumList] = await Promise.all([
    futuresGet('/fapi/v1/exchangeInfo'),
    futuresGet('/fapi/v1/ticker/24hr'),
    futuresGet('/fapi/v1/premiumIndex'),
  ]);

  if (!Array.isArray(exchangeInfo?.symbols) || !Array.isArray(tickerList) || !Array.isArray(premiumList)) {
    throw new UpstreamError('Malformed Binance metadata response');
  }

  const [fundingInfoList, productResponse, coinGeckoMap] = await Promise.all([
    futuresGet('/fapi/v1/fundingInfo').catch((error) => {
      warnings.push(`fundingInfo unavailable: ${error.message}`);
      return [];
    }),
    fetchJson(BINANCE_PRODUCTS, { includeEtf: 'true' }).catch((error) => {
      warnings.push(`Binance market-cap proxy unavailable: ${error.message}`);
      return { data: [] };
    }),
    fetchCoinGeckoRanks().catch((error) => {
      warnings.push(`CoinGecko rank unavailable; using Binance proxy when possible: ${error.message}`);
      return new Map();
    }),
  ]);

  const binanceRankMap = buildBinanceRankMap(productResponse?.data);
  const tickerMap = Object.fromEntries(tickerList.map((item) => [item.symbol, item]));
  const premiumMap = Object.fromEntries(premiumList.map((item) => [item.symbol, item]));
  const fundingIntervalMap = Object.fromEntries(
    (Array.isArray(fundingInfoList) ? fundingInfoList : [])
      .map((item) => [item.symbol, Number(item.fundingIntervalHours || 8)])
  );

  const active = exchangeInfo.symbols.filter((s) => (
    s.quoteAsset === 'USDT'
    && s.status === 'TRADING'
    && s.contractType === 'PERPETUAL'
    && s.underlyingType === 'COIN'
  ));
  if (!active.length) {
    throw new UpstreamError('Binance returned zero active USDT perpetual crypto symbols');
  }

  const universe = [];
  const universeRejectCounts = {};
  const bump = (reason) => {
    universeRejectCounts[reason] = (universeRejectCounts[reason] || 0) + 1;
  };

  for (const info of active) {
    const base = String(info.baseAsset || '').toUpperCase();
    const ticker = tickerMap[info.symbol];
    const { rank, rankSource } = resolveRank(base, coinGeckoMap, binanceRankMap);
    const onboardDate = Number(info.onboardDate || 0);
    const listingAgeDays = onboardDate > 0
      ? (now - onboardDate) / (24 * 60 * 60 * 1000)
      : null;
    const quoteVolumeUsd = Number(ticker?.quoteVolume || 0);

    let reason = null;
    if (EXCLUDED_BASES.has(base)) reason = 'excluded_asset';
    else if (!Number.isFinite(rank)) reason = 'rank_unavailable';
    else if (rank < STRATEGY.rankMin || rank > STRATEGY.rankMax) reason = 'rank_outside_101_500';
    else if (!Number.isFinite(listingAgeDays) || listingAgeDays < STRATEGY.minListingAgeDays) reason = 'listing_age_lt_90d';
    else if (!Number.isFinite(quoteVolumeUsd) || quoteVolumeUsd < STRATEGY.minQuoteVolumeUsd) reason = 'volume_lt_20m';

    if (reason) {
      bump(reason);
      continue;
    }

    universe.push({
      symbol: info.symbol,
      base,
      rank,
      rankSource,
      listingAgeDays,
      quoteVolumeUsd,
      change24hPct: Number(ticker?.priceChangePercent || 0),
      lastPrice: Number(ticker?.lastPrice || 0),
    });
  }

  const dailyStage = await runPool(universe, async (item) => {
    const raw = await futuresGet('/fapi/v1/klines', {
      symbol: item.symbol,
      interval: '1d',
      limit: RUNTIME.dailyKlineLimit,
    });
    const candles = parseKlines(raw);
    if (candles.length < 22) return null;
    const closes = candles.map((c) => c.close);
    const dailyRsi = currentRsi(closes, STRATEGY.rsiPeriod);
    const return7dPct = closes.length >= 8 ? pctChange(closes.at(-1), closes.at(-8)) : null;
    const candidate = { ...item, dailyRsi, return7dPct };
    const reasons = hardFilterReasons(candidate);
    if (reasons.length) return { rejected: true, reasons, candidate };
    return { rejected: false, candidate };
  }, RUNTIME.initialConcurrency);

  const dailyRejectCounts = {};
  const baseCandidates = [];
  for (const row of dailyStage.results) {
    if (row.rejected) {
      for (const reason of row.reasons) {
        dailyRejectCounts[reason] = (dailyRejectCounts[reason] || 0) + 1;
      }
    } else {
      baseCandidates.push(row.candidate);
    }
  }

  const detailedStage = await runPool(baseCandidates, (candidate) => enrichCandidate(candidate, {
    premiumMap,
    fundingIntervalMap,
  }), RUNTIME.detailConcurrency);

  const candidates = detailedStage.results.sort((a, b) => (
    statusOrder(b.status) - statusOrder(a.status)
    || b.score - a.score
    || b.dailyRsi - a.dailyRsi
  ));

  const shortSetups = candidates.filter((item) => item.status === 'SHORT_SETUP').length;
  const strongWatch = candidates.filter((item) => item.status === 'STRONG_WATCH').length;
  const watch = candidates.filter((item) => item.status === 'WATCH').length;

  return {
    source: 'binance-futures-radar-vercel',
    strategyVersion: 'exhaustion-short-radar-v2',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary: {
      totalPairs: active.length,
      rankedLiquidUniverse: universe.length,
      baseCandidates: baseCandidates.length,
      matches: candidates.length,
      shortSetups,
      strongWatch,
      watch,
      dailyStageErrors: dailyStage.errors.length,
      detailStageErrors: detailedStage.errors.length,
      coinGeckoRankSymbols: coinGeckoMap.size,
      binanceProxyRankSymbols: binanceRankMap.size,
      rankAvailable: coinGeckoMap.size > 0 || binanceRankMap.size > 0,
    },
    strategy: {
      universe: 'Binance USDT perpetual crypto contracts',
      rank: '101-300 primary; 301-500 secondary',
      listingAge: '>=90 days',
      quoteVolume24h: '>=20m USDT',
      dailyRsi14: '>90 (live daily candle)',
      return7d: '>50%',
      crowding: 'Funding percentile + OI growth',
      reversal: '1h/4h closed-candle exhaustion signals',
      shortSetupGate: 'score>=85 + funding>=P90 + strong OI + >=2 reversal signals',
      catalystReview: 'required before any trade',
      autoTrade: false,
    },
    diagnostics: {
      warnings,
      universeRejectCounts,
      dailyRejectCounts,
      dailyErrors: dailyStage.errors.slice(0, 10),
      detailErrors: detailedStage.errors.slice(0, 10),
    },
    matches: candidates,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = await scanMarket();
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
    return res.status(200).json(payload);
  } catch (error) {
    const upstream = error instanceof UpstreamError ? error.upstreamStatus : null;
    return res.status(error.status || 500).json({
      error: 'Radar scan failed',
      message: error.message || 'Unknown error',
      upstreamStatus: upstream,
      generatedAt: new Date().toISOString(),
    });
  }
};
