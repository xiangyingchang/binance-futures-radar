const BINANCE_FUTURES = 'https://fapi.binance.com';
const BINANCE_PRODUCTS = 'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products';
const COINGECKO_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets';
const CMC_PUBLIC_LISTINGS = 'https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/listings/latest';

const CONFIG = {
  requestTimeoutMs: 12000,
  coinGeckoTimeoutMs: 8000,
  cmcTimeoutMs: 9000,
  rsiPeriod: 6,
  klineLimit: 35,
  rsi1hThreshold: 90,
  rsi4hThreshold: 80,
  fundingAprMin: -500,
  rankMinExclusive: 100,
  change24hMax: 35,
  concurrency: 24,
  depthLimit: 100,
};

class UpstreamError extends Error {
  constructor(message, status = 502, upstreamStatus = null) {
    super(message);
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

async function fetchJson(url, params = {}, timeoutMs = CONFIG.requestTimeoutMs) {
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
        'User-Agent': 'binance-futures-radar/1.1',
      },
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
    if (error.name === 'AbortError') {
      throw new UpstreamError(`Request timed out after ${timeoutMs / 1000}s`, 504);
    }
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(error.message || 'Unable to reach upstream');
  } finally {
    clearTimeout(timer);
  }
}

function futuresGet(path, params = {}) {
  return fetchJson(`${BINANCE_FUTURES}${path}`, params);
}

function calculateRSI(closes, period = CONFIG.rsiPeriod) {
  if (!Array.isArray(closes) || closes.length < period + 1) return 0;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const currentGain = diff > 0 ? diff : 0;
    const currentLoss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = ((avgGain * (period - 1)) + currentGain) / period;
    avgLoss = ((avgLoss * (period - 1)) + currentLoss) / period;
  }

  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function buildBinanceRankMap(productList) {
  const marketCaps = [];
  for (const item of Array.isArray(productList) ? productList : []) {
    if (item?.q !== 'USDT' || item?.cs == null) continue;
    const price = Number(item.c || 0);
    const supply = Number(item.cs || 0);
    const base = String(item.b || '').toUpperCase();
    if (base && price > 0 && supply > 0) marketCaps.push({ base, marketCap: price * supply });
  }
  marketCaps.sort((a, b) => b.marketCap - a.marketCap);
  const map = new Map();
  marketCaps.forEach((item, index) => {
    if (!map.has(item.base)) map.set(item.base, index + 1);
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

async function fetchCoinGeckoRanks() {
  const shared = { vs_currency: 'usd', order: 'market_cap_desc', per_page: 250, sparkline: 'false' };
  const [page1, page2] = await Promise.all([
    fetchJson(COINGECKO_MARKETS, { ...shared, page: 1 }, CONFIG.coinGeckoTimeoutMs),
    fetchJson(COINGECKO_MARKETS, { ...shared, page: 2 }, CONFIG.coinGeckoTimeoutMs),
  ]);
  return buildUniqueSymbolRankMap(
    [...(Array.isArray(page1) ? page1 : []), ...(Array.isArray(page2) ? page2 : [])],
    (coin) => coin?.market_cap_rank,
  );
}

async function fetchCmcRanks() {
  const payload = await fetchJson(CMC_PUBLIC_LISTINGS, {
    start: 1,
    limit: 500,
    convert: 'USD',
    sort: 'market_cap',
    sort_dir: 'desc',
    cryptocurrency_type: 'all',
  }, CONFIG.cmcTimeoutMs);
  return buildUniqueSymbolRankMap(Array.isArray(payload?.data) ? payload.data : [], (coin) => coin?.cmc_rank);
}

function rankLookupKeys(base) {
  const normalized = String(base || '').toUpperCase();
  if (!normalized) return [];
  return normalized.startsWith('1000') ? [normalized, normalized.slice(4)] : [normalized];
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

  const top100Sources = sources
    .filter(([, rank]) => rank <= CONFIG.rankMinExclusive)
    .map(([source]) => source);

  return {
    ...primary,
    cmcRank,
    coinGeckoRank,
    binanceProxyRank,
    rankSources: Object.fromEntries(sources),
    top100Sources,
    rankAvailable: sources.length > 0,
  };
}

function fundingApr(rate, intervalHours) {
  const interval = intervalHours > 0 ? intervalHours : 8;
  return rate * (24 / interval) * 365 * 100;
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
  let cursor = 0;
  let failed = 0;

  async function runner() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        const result = await worker(items[index]);
        if (result) results.push(result);
      } catch (_) {
        failed += 1;
      }
    }
  }

  const count = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: count }, runner));
  return { results, failed };
}

async function scanMarket() {
  const startedAt = Date.now();
  const warnings = [];

  const critical = await Promise.all([
    futuresGet('/fapi/v1/exchangeInfo'),
    futuresGet('/fapi/v1/ticker/24hr'),
    futuresGet('/fapi/v1/premiumIndex'),
  ]);

  const [exchangeInfo, tickerList, premiumList] = critical;
  if (!Array.isArray(exchangeInfo?.symbols) || !Array.isArray(tickerList) || !Array.isArray(premiumList)) {
    throw new UpstreamError('Malformed Binance metadata response');
  }

  const [fundingInfoList, productResponse, cmcMap, coinGeckoMap] = await Promise.all([
    futuresGet('/fapi/v1/fundingInfo').catch(() => []),
    fetchJson(BINANCE_PRODUCTS, { includeEtf: 'true' }).catch((error) => {
      warnings.push(`Binance market-cap proxy unavailable: ${error.message}`);
      return { data: [] };
    }),
    fetchCmcRanks().catch((error) => {
      warnings.push(`CoinMarketCap ranks unavailable: ${error.message}`);
      return new Map();
    }),
    fetchCoinGeckoRanks().catch((error) => {
      warnings.push(`CoinGecko ranks unavailable: ${error.message}`);
      return new Map();
    }),
  ]);

  const symbols = exchangeInfo.symbols
    .filter((s) => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.underlyingType === 'COIN')
    .map((s) => s.symbol);

  if (symbols.length === 0) throw new UpstreamError('Binance returned zero active USDT perpetual symbols');

  const tickerMap = Object.fromEntries(tickerList.map((item) => [item.symbol, item]));
  const fundingMap = Object.fromEntries(premiumList.map((item) => [item.symbol, Number(item.lastFundingRate || 0)]));
  const fundingIntervalMap = Object.fromEntries(
    (Array.isArray(fundingInfoList) ? fundingInfoList : []).map((item) => [item.symbol, Number(item.fundingIntervalHours || 8)])
  );
  const baseMap = Object.fromEntries(exchangeInfo.symbols.map((item) => [item.symbol, item.baseAsset]));
  const binanceRankMap = buildBinanceRankMap(Array.isArray(productResponse?.data) ? productResponse.data : []);

  const rejectCounts = { rank_unavailable: 0, rank_top100_any_source: 0 };

  symbols.sort(
    (a, b) => Number(tickerMap[b]?.priceChangePercent || 0) - Number(tickerMap[a]?.priceChangePercent || 0)
  );

  const { results, failed } = await runPool(
    symbols,
    async (symbol) => {
      const k1h = await futuresGet('/fapi/v1/klines', {
        symbol,
        interval: '1h',
        limit: CONFIG.klineLimit,
      });
      if (!Array.isArray(k1h)) return null;
      const rsi1h = calculateRSI(k1h.map((candle) => Number(candle[4])));
      if (rsi1h <= CONFIG.rsi1hThreshold) return null;

      const k4h = await futuresGet('/fapi/v1/klines', {
        symbol,
        interval: '4h',
        limit: CONFIG.klineLimit,
      });
      if (!Array.isArray(k4h)) return null;
      const rsi4h = calculateRSI(k4h.map((candle) => Number(candle[4])));
      if (rsi4h < CONFIG.rsi4hThreshold) return null;

      const interval = fundingIntervalMap[symbol] || 8;
      const funding = fundingMap[symbol] || 0;
      const annualizedFunding = fundingApr(funding, interval);
      if (annualizedFunding <= CONFIG.fundingAprMin) return null;

      const change24h = Number(tickerMap[symbol]?.priceChangePercent || 0);
      if (change24h >= CONFIG.change24hMax) return null;

      const rankInfo = resolveRankConsensus(baseMap[symbol], cmcMap, coinGeckoMap, binanceRankMap);
      if (!rankInfo.rankAvailable) {
        rejectCounts.rank_unavailable += 1;
        return null;
      }
      if (rankInfo.top100Sources.length > 0) {
        rejectCounts.rank_top100_any_source += 1;
        return null;
      }

      const depthData = await futuresGet('/fapi/v1/depth', {
        symbol,
        limit: CONFIG.depthLimit,
      }).catch(() => null);

      return {
        symbol,
        ...rankInfo,
        funding,
        fundingApr: annualizedFunding,
        interval,
        rsi1h,
        rsi4h,
        change24h,
        volume: Number(tickerMap[symbol]?.quoteVolume || 0),
        ...analyzeDepth(depthData),
      };
    },
    CONFIG.concurrency
  );

  results.sort((a, b) => b.rsi1h - a.rsi1h || b.volume - a.volume);

  return {
    source: 'binance-futures-radar-vercel',
    strategyVersion: 'legacy-high-rsi-v1-multisource-rank',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary: {
      totalPairs: symbols.length,
      matches: results.length,
      symbolErrors: failed,
      rankAvailable: cmcMap.size > 0 || coinGeckoMap.size > 0 || binanceRankMap.size > 0,
      cmcRankSymbols: cmcMap.size,
      coinGeckoRankSymbols: coinGeckoMap.size,
      binanceProxyRankSymbols: binanceRankMap.size,
      rankUnavailableRejected: rejectCounts.rank_unavailable,
      top100Rejected: rejectCounts.rank_top100_any_source,
    },
    diagnostics: { warnings, rankRejectCounts: rejectCounts },
    strategy: {
      rsi1h: `>${CONFIG.rsi1hThreshold}`,
      rsi4h: `>=${CONFIG.rsi4hThreshold}`,
      fundingApr: `>${CONFIG.fundingAprMin}%`,
      rank: `>100; CMC primary, CoinGecko + Binance proxy cross-check; missing rank rejects`,
      change24h: `<${CONFIG.change24hMax}%`,
    },
    matches: results,
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
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
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
