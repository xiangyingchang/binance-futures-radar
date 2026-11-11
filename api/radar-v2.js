'use strict';

const {
  CONFIG: STRATEGY,
  EXCLUDED_BASES,
  currentRsi,
  percentileRank,
  computeFundingArmState,
  pctChange,
  rankLookupKeys,
  hardFilterReasons,
  analyzeReversal,
  scoreCandidate,
} = require('../lib/strategy');

const BINANCE_FUTURES = 'https://fapi.binance.com';
const BINANCE_PRODUCTS = 'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products';
const COINGECKO_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets';
const CMC_PUBLIC_LISTINGS = 'https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/listings/latest';

const RUNTIME = Object.freeze({
  requestTimeoutMs: 12000,
  coinGeckoTimeoutMs: 8000,
  cmcTimeoutMs: 9000,
  dailyKlineLimit: 60,
  intradayKlineLimit: 80,
  initialConcurrency: 16,
  detailConcurrency: 5,
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
      headers: { Accept: 'application/json', 'User-Agent': 'binance-futures-radar/6.0' },
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
    if (error.name === 'AbortError') throw new UpstreamError(`Request timed out after ${timeoutMs / 1000}s`, 504);
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
    if (price > 0 && supply > 0) marketCaps.push({ base: String(item.b || '').toUpperCase(), marketCap: price * supply });
  }
  marketCaps.sort((a, b) => b.marketCap - a.marketCap);
  const map = new Map();
  marketCaps.forEach((item, index) => {
    if (item.base && !map.has(item.base)) map.set(item.base, index + 1);
  });
  return map;
}

function buildUniqueSymbolRankMap(rows, rankGetter) {
  const counts = new Map();
  for (const coin of Array.isArray(rows) ? rows : []) {
    const symbol = String(coin?.symbol || '').toUpperCase();
    if (symbol) counts.set(symbol, (counts.get(symbol) || 0) + 1);
  }
  const map = new Map();
  for (const coin of Array.isArray(rows) ? rows : []) {
    const symbol = String(coin?.symbol || '').toUpperCase();
    const rank = Number(rankGetter(coin));
    if (symbol && Number.isFinite(rank) && counts.get(symbol) === 1) map.set(symbol, rank);
  }
  return map;
}

function buildCoinGeckoRankMap(rows) {
  return buildUniqueSymbolRankMap(rows, (coin) => coin?.market_cap_rank);
}

function buildCmcRankMap(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return buildUniqueSymbolRankMap(rows, (coin) => coin?.cmc_rank);
}

async function fetchCoinGeckoRanks() {
  const shared = { vs_currency: 'usd', order: 'market_cap_desc', per_page: 250, sparkline: 'false' };
  const [page1, page2] = await Promise.all([
    fetchJson(COINGECKO_MARKETS, { ...shared, page: 1 }, RUNTIME.coinGeckoTimeoutMs),
    fetchJson(COINGECKO_MARKETS, { ...shared, page: 2 }, RUNTIME.coinGeckoTimeoutMs),
  ]);
  return buildCoinGeckoRankMap([...(Array.isArray(page1) ? page1 : []), ...(Array.isArray(page2) ? page2 : [])]);
}

async function fetchCmcRanks() {
  const payload = await fetchJson(CMC_PUBLIC_LISTINGS, {
    start: 1,
    limit: 500,
    convert: 'USD',
    sort: 'market_cap',
    sort_dir: 'desc',
    cryptocurrency_type: 'all',
  }, RUNTIME.cmcTimeoutMs);
  return buildCmcRankMap(payload);
}

function findRank(base, map) {
  for (const key of rankLookupKeys(base)) {
    if (map?.has(key)) return Number(map.get(key));
  }
  return null;
}

function resolveRankConsensus(base, cmcMap, coinGeckoMap, binanceMap) {
  const cmcRank = findRank(base, cmcMap);
  const coinGeckoRank = findRank(base, coinGeckoMap);
  const binanceProxyRank = findRank(base, binanceMap);
  const sources = [
    ['coinmarketcap', cmcRank],
    ['coingecko', coinGeckoRank],
    ['binance_marketcap_proxy', binanceProxyRank],
  ].filter(([, rank]) => Number.isFinite(rank));

  const primary = Number.isFinite(cmcRank)
    ? { rank: cmcRank, rankSource: 'coinmarketcap' }
    : Number.isFinite(coinGeckoRank)
      ? { rank: coinGeckoRank, rankSource: 'coingecko' }
      : Number.isFinite(binanceProxyRank)
        ? { rank: binanceProxyRank, rankSource: 'binance_marketcap_proxy' }
        : { rank: null, rankSource: 'unavailable' };

  const top100Sources = sources.filter(([, rank]) => rank <= 100).map(([source]) => source);
  const targetSources = sources.filter(([, rank]) => rank >= STRATEGY.rankMin && rank <= STRATEGY.rankMax).map(([source]) => source);
  const above500Sources = sources.filter(([, rank]) => rank > STRATEGY.rankMax).map(([source]) => source);
  const rankConflict = (top100Sources.length > 0 && targetSources.length > 0)
    || (targetSources.length > 0 && above500Sources.length > 0);
  const cmcInTarget = Number.isFinite(cmcRank) && cmcRank >= STRATEGY.rankMin && cmcRank <= STRATEGY.rankMax;
  const rankVerifiedForShort = cmcInTarget && top100Sources.length === 0 && !rankConflict;

  return {
    ...primary,
    cmcRank,
    coinGeckoRank,
    binanceProxyRank,
    rankSources: Object.fromEntries(sources),
    top100Sources,
    above500Sources,
    rankConflict,
    rankVerifiedForShort,
  };
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

async function fetchFundingHistory(symbol, now) {
  const startTime = now - (RUNTIME.fundingLookbackDays * 24 * 60 * 60 * 1000);
  const rows = [];
  let cursor = startTime;
  for (let page = 0; page < 4 && cursor < now; page += 1) {
    const batch = await futuresGet('/fapi/v1/fundingRate', { symbol, startTime: cursor, endTime: now, limit: 1000 });
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    const lastTime = Number(batch.at(-1)?.fundingTime);
    if (!Number.isFinite(lastTime) || lastTime < cursor) break;
    cursor = lastTime + 1;
  }
  return rows;
}

function computeOiChanges(rows) {
  const data = Array.isArray(rows) ? rows : [];
  if (data.length < 2) return { oi24hPct: null, oi7dPct: null, oiSamples: data.length };
  const current = Number(data.at(-1)?.sumOpenInterest);
  const currentTs = Number(data.at(-1)?.timestamp || 0);
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(currentTs)) {
    return { oi24hPct: null, oi7dPct: null, oiSamples: data.length };
  }
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
    try { return await fn(); }
    catch (error) {
      dataErrors.push(`${name}: ${error.message || 'failed'}`);
      return fallback;
    }
  };

  const [fundingHistory, oiHistory, k1hRaw, k4hRaw] = await Promise.all([
    safe('funding_history', () => fetchFundingHistory(candidate.symbol, now), []),
    safe('oi_history', () => futuresGet('/futures/data/openInterestHist', {
      symbol: candidate.symbol, period: '1h', limit: RUNTIME.oiLookbackHours,
    }), []),
    safe('1h_klines', () => futuresGet('/fapi/v1/klines', {
      symbol: candidate.symbol, interval: '1h', limit: RUNTIME.intradayKlineLimit,
    }), []),
    safe('4h_klines', () => futuresGet('/fapi/v1/klines', {
      symbol: candidate.symbol, interval: '4h', limit: RUNTIME.intradayKlineLimit,
    }), []),
  ]);

  const interval = fundingIntervalMap[candidate.symbol] || 8;
  const currentFunding = Number(premiumMap[candidate.symbol]?.lastFundingRate || 0);
  const historicalRates = (Array.isArray(fundingHistory) ? fundingHistory : [])
    .map((row) => Number(row?.fundingRate))
    .filter(Number.isFinite);
  const fundingPercentile = percentileRank(historicalRates, currentFunding);
  const fundingArm = computeFundingArmState(fundingHistory, currentFunding, now);
  const oi = computeOiChanges(oiHistory);
  const reversal = analyzeReversal(
    closedCandles(parseKlines(k1hRaw), now),
    closedCandles(parseKlines(k4hRaw), now),
  );
  const scored = scoreCandidate({ ...candidate, fundingPercentile, ...oi, reversal });
  const finalStatus = scored.status === 'SHORT_SETUP' && !candidate.rankVerifiedForShort
    ? 'STRONG_WATCH'
    : scored.status;

  const riskFlags = [];
  if (!Number.isFinite(candidate.cmcRank)) riskFlags.push('cmc_rank_unavailable');
  if (candidate.rankConflict) riskFlags.push('rank_source_conflict');
  if (!candidate.rankVerifiedForShort) riskFlags.push('rank_not_verified_for_short');
  if (candidate.dailyRsiConfirmed === false) riskFlags.push('live_daily_rsi_not_closed_confirmed');
  if (dataErrors.length) riskFlags.push('incomplete_reference_data');

  return {
    ...candidate,
    currentFundingRate: currentFunding,
    fundingIntervalHours: interval,
    fundingApr: fundingApr(currentFunding, interval),
    fundingPercentile,
    fundingHistorySamples: historicalRates.length,
    ...fundingArm,
    executionResearchOnly: true,
    ...oi,
    reversal,
    ...scored,
    status: finalStatus,
    riskFlags,
    dataErrors,
    catalystReviewRequired: true,
    autoTrade: false,
    decisionGate: finalStatus === 'SHORT_SETUP'
      ? 'MANUAL_CATALYST_AND_SIZE_REVIEW_REQUIRED'
      : !candidate.rankVerifiedForShort
        ? 'RANK_SOURCE_REVIEW_REQUIRED'
        : 'WAIT_FOR_FUNDING_P90',
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

  const [fundingInfoList, productResponse, coinGeckoMap, cmcMap] = await Promise.all([
    futuresGet('/fapi/v1/fundingInfo').catch((error) => {
      warnings.push(`fundingInfo unavailable: ${error.message}`);
      return [];
    }),
    fetchJson(BINANCE_PRODUCTS, { includeEtf: 'true' }).catch((error) => {
      warnings.push(`Binance market-cap proxy unavailable: ${error.message}`);
      return { data: [] };
    }),
    fetchCoinGeckoRanks().catch((error) => {
      warnings.push(`CoinGecko rank unavailable: ${error.message}`);
      return new Map();
    }),
    fetchCmcRanks().catch((error) => {
      warnings.push(`CoinMarketCap rank unavailable; SHORT_SETUP will be rank-downgraded: ${error.message}`);
      return new Map();
    }),
  ]);

  const binanceRankMap = buildBinanceRankMap(productResponse?.data);
  const tickerMap = Object.fromEntries(tickerList.map((item) => [item.symbol, item]));
  const premiumMap = Object.fromEntries(premiumList.map((item) => [item.symbol, item]));
  const fundingIntervalMap = Object.fromEntries(
    (Array.isArray(fundingInfoList) ? fundingInfoList : []).map((item) => [item.symbol, Number(item.fundingIntervalHours || 8)])
  );

  const active = exchangeInfo.symbols.filter((s) => (
    s.quoteAsset === 'USDT'
    && s.status === 'TRADING'
    && s.contractType === 'PERPETUAL'
    && s.underlyingType === 'COIN'
  ));
  if (!active.length) throw new UpstreamError('Binance returned zero active USDT perpetual crypto symbols');

  const universe = [];
  const universeRejectCounts = {};
  const rankConflictExamples = [];
  const bump = (reason) => { universeRejectCounts[reason] = (universeRejectCounts[reason] || 0) + 1; };

  for (const info of active) {
    const base = String(info.baseAsset || '').toUpperCase();
    const ticker = tickerMap[info.symbol];
    const rankInfo = resolveRankConsensus(base, cmcMap, coinGeckoMap, binanceRankMap);
    const onboardDate = Number(info.onboardDate || 0);
    const listingAgeDays = onboardDate > 0 ? (now - onboardDate) / 86_400_000 : null;
    const quoteVolumeUsd = Number(ticker?.quoteVolume || 0);

    let reason = null;
    if (EXCLUDED_BASES.has(base)) reason = 'excluded_asset';
    else if (rankInfo.top100Sources.length > 0) reason = 'rank_top100_any_source';
    else if (rankInfo.rankConflict) reason = 'rank_source_conflict';
    else if (!Number.isFinite(rankInfo.rank)) reason = 'rank_unavailable';
    else if (rankInfo.rank < STRATEGY.rankMin || rankInfo.rank > STRATEGY.rankMax) reason = 'rank_outside_101_500';
    else if (!Number.isFinite(listingAgeDays) || listingAgeDays < STRATEGY.minListingAgeDays) reason = 'listing_age_lt_90d';
    else if (!Number.isFinite(quoteVolumeUsd) || quoteVolumeUsd < STRATEGY.minQuoteVolumeUsd) reason = 'volume_lt_20m';
    if (reason) {
      bump(reason);
      if ((reason === 'rank_top100_any_source' || reason === 'rank_source_conflict') && rankConflictExamples.length < 20) {
        rankConflictExamples.push({ symbol: info.symbol, reason, ...rankInfo });
      }
      continue;
    }

    universe.push({
      symbol: info.symbol,
      base,
      ...rankInfo,
      listingAgeDays,
      quoteVolumeUsd,
      change24hPct: Number(ticker?.priceChangePercent || 0),
      lastPrice: Number(ticker?.lastPrice || 0),
    });
  }

  const dailyStage = await runPool(universe, async (item) => {
    const raw = await futuresGet('/fapi/v1/klines', { symbol: item.symbol, interval: '1d', limit: RUNTIME.dailyKlineLimit });
    const allCandles = parseKlines(raw);
    if (allCandles.length < 10) return null;
    const liveCloses = allCandles.map((c) => c.close);
    const closedCloses = closedCandles(allCandles, now).map((c) => c.close);
    const dailyRsi = currentRsi(liveCloses, STRATEGY.rsiPeriod);
    const closedDailyRsi = currentRsi(closedCloses, STRATEGY.rsiPeriod);
    const return7dPct = liveCloses.length >= 8 ? pctChange(liveCloses.at(-1), liveCloses.at(-8)) : null;
    const candidate = {
      ...item,
      dailyRsi,
      closedDailyRsi,
      dailyRsiMode: 'live',
      dailyRsiConfirmed: Number.isFinite(closedDailyRsi) && closedDailyRsi > STRATEGY.dailyRsiMinExclusive,
      return7dPct,
    };
    const reasons = hardFilterReasons(candidate);
    return reasons.length ? { rejected: true, reasons, candidate } : { rejected: false, candidate };
  }, RUNTIME.initialConcurrency);

  const dailyRejectCounts = {};
  const baseCandidates = [];
  for (const row of dailyStage.results) {
    if (row.rejected) {
      for (const reason of row.reasons) dailyRejectCounts[reason] = (dailyRejectCounts[reason] || 0) + 1;
    } else {
      baseCandidates.push(row.candidate);
    }
  }

  const detailedStage = await runPool(baseCandidates, (candidate) => enrichCandidate(candidate, {
    premiumMap, fundingIntervalMap,
  }), RUNTIME.detailConcurrency);

  const candidates = detailedStage.results.sort((a, b) => (
    statusOrder(b.status) - statusOrder(a.status)
    || b.score - a.score
    || b.dailyRsi - a.dailyRsi
  ));

  return {
    source: 'binance-futures-radar-vercel',
    strategyVersion: 'exhaustion-short-radar-v6-cmc-rank-consensus',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary: {
      totalPairs: active.length,
      rankedLiquidUniverse: universe.length,
      baseCandidates: baseCandidates.length,
      matches: candidates.length,
      shortSetups: candidates.filter((item) => item.status === 'SHORT_SETUP').length,
      strongWatch: candidates.filter((item) => item.status === 'STRONG_WATCH').length,
      watch: candidates.filter((item) => item.status === 'WATCH').length,
      dailyStageErrors: dailyStage.errors.length,
      detailStageErrors: detailedStage.errors.length,
      cmcRankSymbols: cmcMap.size,
      coinGeckoRankSymbols: coinGeckoMap.size,
      binanceProxyRankSymbols: binanceRankMap.size,
      rankAvailable: cmcMap.size > 0 || coinGeckoMap.size > 0 || binanceRankMap.size > 0,
    },
    strategy: {
      universe: 'Binance USDT perpetual crypto contracts',
      rank: '101-500; any trusted source <=100 rejects; cross-boundary conflicts reject',
      rankPrimary: 'CoinMarketCap public API; CoinGecko + Binance market-cap proxy cross-check',
      listingAge: '>=90 days',
      quoteVolume24h: '>=20m USDT',
      dailyRsi6: '>93 (live current daily candle)',
      closedDailyRsi6: 'reported for confirmation context only',
      return7d: '>20% (live current price vs 7d ago)',
      shortSetupGate: 'core heat/liquidity/rank gate + CMC verified 101-500 + funding >= P90',
      fundingWatch: 'P75-P90 => STRONG_WATCH',
      fundingArmedResearch: 'research-only: remember a P90 funding observation for 48h; does not change status logic',
      oiAndReversal: 'reference/scoring only; never hard gates',
      pilotExit: 'max 3 days; hard stop if price rises 30% from entry',
      catalystReview: 'required before any trade',
      autoTrade: false,
    },
    diagnostics: {
      warnings,
      universeRejectCounts,
      rankConflictExamples,
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
    return res.status(error.status || 500).json({
      error: 'Radar scan failed',
      message: error.message || 'Unknown error',
      upstreamStatus: error instanceof UpstreamError ? error.upstreamStatus : null,
      generatedAt: new Date().toISOString(),
    });
  }
};