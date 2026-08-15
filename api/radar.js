const BINANCE_FUTURES = 'https://fapi.binance.com';
const BINANCE_PRODUCTS = 'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products';

const CONFIG = {
  requestTimeoutMs: 12000,
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
        'User-Agent': 'binance-futures-radar/2.0',
      },
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      // Preserve HTTP status when the upstream body is not JSON.
    }

    if (!response.ok) {
      const message = payload?.msg || payload?.message || `HTTP ${response.status}`;
      throw new UpstreamError(message, 502, response.status);
    }

    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new UpstreamError(`Binance request timed out after ${timeoutMs / 1000}s`, 504);
    }
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(error.message || 'Unable to reach Binance');
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

function buildRankMap(productList) {
  const marketCaps = [];
  for (const item of productList) {
    if (item?.q !== 'USDT' || item?.cs == null) continue;
    const price = Number(item.c || 0);
    const supply = Number(item.cs || 0);
    if (price > 0 && supply > 0) marketCaps.push({ base: item.b, marketCap: price * supply });
  }
  marketCaps.sort((a, b) => b.marketCap - a.marketCap);
  const map = {};
  marketCaps.forEach((item, index) => {
    if (!map[item.base]) map[item.base] = index + 1;
  });
  return map;
}

function resolveRank(base, rankMap) {
  let rank = rankMap[base];
  if (!rank && base?.startsWith('1000')) rank = rankMap[base.slice(4)];
  return rank || null;
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

  const critical = await Promise.all([
    futuresGet('/fapi/v1/exchangeInfo'),
    futuresGet('/fapi/v1/ticker/24hr'),
    futuresGet('/fapi/v1/premiumIndex'),
  ]);

  const [exchangeInfo, tickerList, premiumList] = critical;
  if (!Array.isArray(exchangeInfo?.symbols) || !Array.isArray(tickerList) || !Array.isArray(premiumList)) {
    throw new UpstreamError('Malformed Binance metadata response');
  }

  const [fundingInfoList, productResponse] = await Promise.all([
    futuresGet('/fapi/v1/fundingInfo').catch(() => []),
    fetchJson(BINANCE_PRODUCTS, { includeEtf: 'true' }).catch(() => ({ data: [] })),
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
  const rankMap = buildRankMap(Array.isArray(productResponse?.data) ? productResponse.data : []);

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

      const rank = resolveRank(baseMap[symbol], rankMap);
      if (rank !== null && rank <= CONFIG.rankMinExclusive) return null;

      const depthData = await futuresGet('/fapi/v1/depth', {
        symbol,
        limit: CONFIG.depthLimit,
      }).catch(() => null);

      return {
        symbol,
        rank,
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
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary: {
      totalPairs: symbols.length,
      matches: results.length,
      symbolErrors: failed,
      rankAvailable: Object.keys(rankMap).length > 0,
    },
    strategy: {
      rsi1h: `>${CONFIG.rsi1hThreshold}`,
      rsi4h: `>=${CONFIG.rsi4hThreshold}`,
      fundingApr: `>${CONFIG.fundingAprMin}%`,
      rank: `>${CONFIG.rankMinExclusive} when available`,
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
