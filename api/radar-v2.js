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
  requestTimeoutMs: 12_000,
  coinGeckoTimeoutMs: 8_000,
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
      // Keep the HTTP status even when an upstream sends a non-JSON body.
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
    if (price > 0 && supply > 0) marketCaps.push({ base: String(item.b || '').toUpperCase(), marketCap: price * supply });
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
  return buildCoinGeckoRankMap([...(Array.isArray(page1) ? page1 : []), ...(Array.isArray(page2) ? page2 : [])]);
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

async function fetchFundingHistory(symbol, now) {
  const startTime = now - (RUNTIME.fundingLookbackDays * 24 * 60 * 60 * 1000);
  const rows = [];
  let cursor = startTime;

  for (let page = 0; page < 4 && cursor < now; page += 1) {
    const batch = await futuresGet('/fapi/v1/fundingRate', {
      symbol,
      startTime: cursor,
      endTime: now,
      limit: 1000,
    });
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
  if (!Number.isFinite(current) || current <= 0) return { oi24hPct: null, oi7dPct: null, oiSamples: data.length };

  const currentTs = Number(data.at(-1)?.timestamp || 0);
  const nearestBefore = (hours) => {
    const target = currentTs - (ho²È="24(€€€‘•¥Í¥½¹…Ñ”è™¥¹…±MÑ…ÑÕÌ€ôôô€M!=IQ}MQU@œ(€€€€€€ü€Q1eMQ}IY%]}IEU%Iœ(€€€€€€è…¹‘¥‘…Ñ”¹É…¹­M½ÕÉ”€„ôô€½¥¹•­¼œ(€€€€€€€€ü€I9-}M=UI}IY%]}IEU%Iœ(€€€€€€€€è€]%Q}=I}	QQI}MQU@œ°(€ôì)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í…¹5…É­•Ð ¤ì(€½¹ÍÐÍÑ…ÉÑ•‘Ð€ô…Ñ”¹¹½Ü ¤ì(€½¹ÍÐ¹½Ü€ô…Ñ”¹¹½Ü ¤ì(€½¹ÍÐÝ…É¹¥¹Ì€ômtì((€½¹ÍÐm•á¡…¹•%¹™¼°Ñ¥­•É1¥ÍÐ°ÁÉ•µ¥Õµ1¥ÍÑt€ô…Ý…¥ÐAÉ½µ¥Í”¹…±°¡l(€€€™ÕÑÕÉ•Í•Ð œ½™…Á¤½ØÄ½•á¡…¹•%¹™¼œ¤°(€€€™ÕÑÕÉ•Í•Ð œ½™…Á¤½ØÄ½Ñ¥­•È¼ÈÑ¡Èœ¤°(€€€™ÕÑÕÉ•Í•Ð œ½™…Á¤½ØÄ½ÁÉ•µ¥Õµ%¹‘•àœ¤°(€t¤ì((€¥˜€ …ÉÉ…ä¹¥ÍÉÉ…ä¡•á¡…¹•%¹™¼ü¹Íåµ‰½±Ì¤ñð€…ÉÉ…ä¹¥ÍÉÉ…ä¡Ñ¥­•É1¥ÍÐ¤ñð€…ÉÉ…ä¹¥ÍÉÉ…ä¡ÁÉ•µ¥Õµ1¥ÍÐ¤¤ì(€€€Ñ¡É½Ü¹•ÜUÁÍÑÉ•…µÉÉ½È 5…±™½Éµ•	¥¹…¹”µ•Ñ…‘…Ñ„É•ÍÁ½¹Í”œ¤ì(€ô((€½¹ÍÐm™Õ¹‘¥¹%¹™½1¥ÍÐ°ÁÉ½‘ÕÑI•ÍÁ½¹Í”°½¥¹•­½5…Át€ô…Ý…¥ÐAÉ½µ¥Í”¹…±°¡l(€€€™ÕÑÕÉ•Í•Ð œ½™…Á¤½ØÄ½™Õ¹‘¥¹%¹™¼œ¤¹…Ñ  ¡•ÉÉ½È¤€ôøì(€€€€€Ý…É¹¥¹Ì¹ÁÕÍ ¡™Õ¹‘¥¹%¹™¼Õ¹…Ù…¥±…‰±”è€‘í•ÉÉ½È¹µ•ÍÍ…•õ€¤ì(€€€€€É•ÑÕÉ¸mtì(€€€ô¤°(€€€™•Ñ¡)Í½¸¡	%99}AI=UQL°ì¥¹±Õ‘•Ñ˜è€ÑÉÕ”œô¤¹…Ñ  ¡•ÉÉ½È¤€ôøì(€€€€€Ý…É¹¥¹Ì¹ÁÕÍ ¡	¥¹…¹”µ…É­•Ðµ…ÀÁÉ½áäÕ¹…Ù…¥±…‰±”è€‘í•ÉÉ½È¹µ•ÍÍ…•õ€¤ì(€€€€€É•ÑÕÉ¸ì‘…Ñ„èmtôì(€€€ô¤°(€€€™•Ñ¡½¥¹•­½I…¹­Ì ¤¹…Ñ  ¡•ÉÉ½È¤€ôøì(€€€€€Ý…É¹¥¹Ì¹ÁÕÍ ¡½¥¹•­¼É…¹¬Õ¹…Ù…¥±…‰±”ìÕÍ¥¹œ	¥¹…¹”ÁÉ½áäÝ¡•¸Á½ÍÍ¥‰±”è€‘í•ÉÉ½È¹µ•ÍÍ…•õ€¤ì(€€€€€É•ÑÕÉ¸¹•Ü5…À ¤ì(€€€ô¤°(€t¤ì((€½¹ÍÐ‰¥¹…¹•I…¹­5…À€ô‰Õ¥±‘	¥¹…¹•I…¹­5…À¡ÁÉ½‘ÕÑI•ÍÁ½¹Í”ü¹‘…Ñ„¤ì(€½¹ÍÐÑ¥­•É5…À€ô=‰©•Ð¹™É½µ¹ÑÉ¥•Ì¡Ñ¥­•É1¥ÍÐ¹µ…À ¡¥Ñ•´¤€ôøm¥Ñ•´¹Íåµ‰½°°¥Ñ•µt¤¤ì(€½¹ÍÐÁÉ•µ¥Õµ5…À€ô=‰©•Ð¹™É½µ¹ÑÉ¥•Ì¡ÁÉ•µ¥Õµ1¥ÍÐ¹µ…À ¡¥Ñ•´¤€ôøm¥Ñ•´¹Íåµ‰½°°¥Ñ•µt¤¤ì(€½¹ÍÐ™Õ¹‘¥¹%¹Ñ•ÉÙ…±5…À€ô=‰©•Ð¹™É½µ¹ÑÉ¥•Ì (€€€€¡ÉÉ…ä¹¥ÍÉÉ…ä¡™Õ¹‘¥¹%¹™½1¥ÍÐ¤€ü™Õ¹‘¥¹%¹™½1¥ÍÐ€èmt¤¹µ…À ¡¥Ñ•´¤€ôøm¥Ñ•´¹Íåµ‰½°°9Õµ‰•È¡¥Ñ•´¹™Õ¹‘¥¹%¹Ñ•ÉÙ…±!½ÕÉÌñð€à¥t¤(€€¤ì((€½¹ÍÐ…Ñ¥Ù”€ô•á¡…¹•%¹™¼¹Íåµ‰½±Ì¹™¥±Ñ•È ¡Ì¤€ôø€ (€€€Ì¹ÅÕ½Ñ•ÍÍ•Ð€ôôô€UMPœ(€€€€˜˜Ì¹ÍÑ…ÑÕÌ€ôôô€QI%9œ(€€€€˜˜Ì¹½¹ÑÉ…ÑQåÁ”€ôôô€AIAQU0œ(€€€€˜˜Ì¹Õ¹‘•É±å¥¹QåÁ”€ôôô€=%8œ(€€¤¤ì(€¥˜€ ……Ñ¥Ù”¹±•¹Ñ ¤Ñ¡É½Ü¹•ÜUÁÍÑÉ•…µÉÉ½È 	¥¹…¹”É•ÑÕÉ¹•é•É¼…Ñ¥Ù”UMPÁ•ÉÁ•ÑÕ…°ÉåÁÑ¼Íåµ‰½±Ìœ¤ì((€½¹ÍÐÕ¹¥Ù•ÉÍ”€ômtì(€½¹ÍÐÕ¹¥Ù•ÉÍ•I•©•Ñ½Õ¹ÑÌ€ôíôì(€½¹ÍÐ‰ÕµÀ€ô€¡É•…Í½¸¤€ôøìÕ¹¥Ù•ÉÍ•I•©•Ñ½Õ¹ÑÍmÉ•…Í½¹t€ô€¡Õ¹¥Ù•ÉÍ•I•©•Ñ½Õ¹ÑÍmÉ•…Í½¹tñð€À¤€¬€Äìôì((€™½È€¡½¹ÍÐ¥¹™¼½˜…Ñ¥Ù”¤ì(€€€½¹ÍÐ‰…Í”€ôMÑÉ¥¹œ¡¥¹™¼¹‰…Í•ÍÍ•Ðñð€œœ¤¹Ñ½UÁÁ•É…Í” ¤ì(€€€½¹ÍÐÑ¥­•È€ôÑ¥­•É5…Ám¥¹™¼¹Íåµ‰½±tì(€€€½¹ÍÐìÉ…¹¬°É…¹­M½ÕÉ”ô€ôÉ•Í½±Ù•I…¹¬¡‰…Í”°½¥¹•­½5…À°‰¥¹…¹•I…¹­5…À¤ì(€€€½¹ÍÐ½¹‰½…É‘…Ñ”€ô9Õµ‰•È¡¥¹™¼¹½¹‰½…É‘…Ñ”ñð€À¤ì(€€€½¹ÍÐ±¥ÍÑ¥¹•…åÌ€ô½¹‰½…É‘…Ñ”€ø€À€ü€¡¹½Ü€´½¹‰½…É‘…Ñ”¤€¼€ ÈÐ€¨€ØÀ€¨€ØÀ€¨€ÄÀÀÀ¤€è¹Õ±°ì(€€€½¹ÍÐÅÕ½Ñ•Y½±Õµ•UÍ€ô9Õµ‰•È¡Ñ¥­•Èü¹ÅÕ½Ñ•Y½±Õµ”ñð€À¤ì((€€€±•ÐÉ•…Í½¸€ô¹Õ±°ì(€€€¥˜€¡a1U}	ML¹¡…Ì¡‰…Í”¤¤É•…Í½¸€ô€•á±Õ‘•‘}…ÍÍ•Ðœì(€€€•±Í”¥˜€ …9Õµ‰•È¹¥Í¥¹¥Ñ”¡É…¹¬¤¤É•…Í½¸€ô€É…¹­}Õ¹…Ù…¥±…‰±”œì(€€€•±Í”¥˜€¡É…¹¬€ðMQIQd¹É…¹­5¥¸ñðÉ…¹¬€øMQIQd¹É…¹­5…à¤É•…Í½¸€ô€É…¹­}½ÕÑÍ¥‘•|ÄÀÅ|ÔÀÀœì(€€€•±Í”¥˜€ …9Õµ‰•È¹¥Í¥¹¥Ñ”¡±¥ÍÑ¥¹•…åÌ¤ñð±¥ÍÑ¥¹•…åÌ€ðMQIQd¹µ¥¹1¥ÍÑ¥¹•…åÌ¤É•…Í½¸€ô€±¥ÍÑ¥¹}…•}±Ñ|äÁœì(€€€•±Í”¥˜€ …9Õµ‰•È¹¥Í¥¹¥Ñ”¡ÅÕ½Ñ•Y½±Õµ•UÍ¤ñðÅÕ½Ñ•Y½±Õµ•UÍ€ðMQIQd¹µ¥¹EÕ½Ñ•Y½±Õµ•UÍ¤É•…Í½¸€ô€Ù½±Õµ•}±Ñ|ÈÁ´œì((€€€¥˜€¡É•…Í½¸¤ì(€€€€€‰ÕµÀ¡É•…Í½¸¤ì(€€€€€½¹Ñ¥¹Õ”ì(€€€ô((€€€Õ¹¥Ù•ÉÍ”¹ÁÕÍ ¡ì(€€€€€Íåµ‰½°è¥¹™¼¹Íåµ‰½°°(€€€€€‰…Í”°(€€€€€É…¹¬°(€€€€€É…¹­M½ÕÉ”°(€€€€€±¥ÍÑ¥¹•…åÌ°(€€€€€ÅÕ½Ñ•Y½±Õµ•UÍ°(€€€€€¡…¹”ÈÑ¡AÐè9Õµ‰•È¡Ñ¥­•Èü¹ÁÉ¥•¡…¹•A•É•¹Ðñð€À¤°(€€€€€±…ÍÑAÉ¥”è9Õµ‰•È¡Ñ¥­•Èü¹±…ÍÑAÉ¥”ñð€À¤°(€€€ô¤ì(€ô((€½¹ÍÐ‘…¥±åMÑ…”€ô…Ý…¥ÐÉÕ¹A½½°¡Õ¹¥Ù•ÉÍ”°…Íå¹Œ€¡¥Ñ•´¤€ôøì(€€€½¹ÍÐÉ…Ü€ô…Ý…¥Ð™ÕÑÕÉ•Í•Ð œ½™…Á¤½ØÄ½­±¥¹•Ìœ°ì(€€€€€Íåµ‰½°è¥Ñ•´¹Íåµ‰½°°(€€€€€¥¹Ñ•ÉÙ…°è€œÅœ°(€€€€€±¥µ¥ÐèIU9Q%5¹‘…¥±å-±¥¹•1¥µ¥Ð°(€€€ô¤ì(€€€½¹ÍÐ…¹‘±•Ì€ô±½Í•‘…¹‘±•Ì¡Á…ÉÍ•-±¥¹•Ì¡É…Ü¤°¹½Ü¤ì(€€€¥˜€¡…¹‘±•Ì¹±•¹Ñ €ð€ÈÈ¤É•ÑÕÉ¸¹Õ±°ì(€€€½¹ÍÐ±½Í•Ì€ô…¹‘±•Ì¹µ…À ¡Œ¤€ôøŒ¹±½Í”¤ì(€€€½¹ÍÐ‘…¥±åIÍ¤€ôÕÉÉ•¹ÑIÍ¤¡±½Í•Ì°MQIQd¹ÉÍ¥A•É¥½¤ì(€€€½¹ÍÐÉ•ÑÕÉ¸Ý‘AÐ€ô±½Í•Ì¹±•¹Ñ €øô€à€üÁÑ¡…¹”¡±½Í•Ì¹…Ð ´Ä¤°±½Í•Ì¹…Ð ´à¤¤€è¹Õ±°ì(€€€½¹ÍÐ…¹‘¥‘…Ñ”€ôì€¸¸¹¥Ñ•´°‘…¥±åIÍ¤°É•ÑÕÉ¸Ý‘AÐôì(€€€½¹ÍÐÉ•…Í½¹Ì€ô¡…É‘¥±Ñ•ÉI•…Í½¹Ì¡…¹‘¥‘…Ñ”¤ì(€€€¥˜€¡É•…Í½¹Ì¹±•¹Ñ ¤É•ÑÕÉ¸ìÉ•©•Ñ•èÑÉÕ”°É•…Í½¹Ì°…¹‘¥‘…Ñ”ôì(€€€É•ÑÕÉ¸ìÉ•©•Ñ•è™…±Í”°…¹‘¥‘…Ñ”ôì(€ô°IU9Q%5¹¥¹¥Ñ¥…±½¹ÕÉÉ•¹ä¤ì((€½¹ÍÐ‘…¥±åI•©•Ñ½Õ¹ÑÌ€ôíôì(€½¹ÍÐ‰…Í•…¹‘¥‘…Ñ•Ì€ômtì(€™½È€¡½¹ÍÐÉ½Ü½˜‘…¥±åMÑ…”¹É•ÍÕ±ÑÌ¤ì(€€€¥˜€¡É½Ü¹É•©•Ñ•¤ì(€€€€€™½È€¡½¹ÍÐÉ•…Í½¸½˜É½Ü¹É•…Í½¹Ì¤‘…¥±åI•©•Ñ½Õ¹ÑÍmÉ•…Í½¹t€ô€¡‘…¥±åI•©•Ñ½Õ¹ÑÍmÉ•…Í½¹tñð€À¤€¬€Äì(€€€ô•±Í”ì(€€€€€‰…Í•…¹‘¥‘…Ñ•Ì¹ÁÕÍ ¡É½Ü¹…¹‘¥‘…Ñ”¤ì(€€€ô(€ô((€½¹ÍÐ‘•Ñ…¥±•‘MÑ…”€ô…Ý…¥ÐÉÕ¹A½½°¡‰…Í•…¹‘¥‘…Ñ•Ì°€¡…¹‘¥‘…Ñ”¤€ôø•¹É¥¡…¹‘¥‘…Ñ”¡…¹‘¥‘…Ñ”°ì(€€€ÁÉ•µ¥Õµ5…À°(€€€™Õ¹‘¥¹%¹Ñ•ÉÙ…±5…À°(€ô¤°IU9Q%5¹‘•Ñ…¥±½¹ÕÉÉ•¹ä¤ì((€½¹ÍÐ…¹‘¥‘…Ñ•Ì€ô‘•Ñ…¥±•‘MÑ…”¹É•ÍÕ±ÑÌ¹Í½ÉÐ ¡„°ˆ¤€ôø€ (€€€ÍÑ…ÑÕÍ=É‘•È¡ˆ¹ÍÑ…ÑÕÌ¤€´ÍÑ…ÑÕÍ=É‘•È¡„¹ÍÑ…ÑÕÌ¤(€€€ñðˆ¹Í½É”€´„¹Í½É”(€€€ñðˆ¹‘…¥±åIÍ¤€´„¹‘…¥±åIÍ¤(€€¤¤ì((€½¹ÍÐÍ¡½ÉÑM•ÑÕÁÌ€ô…¹‘¥‘…Ñ•Ì¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹ÍÑ…ÑÕÌ€ôôô€M!=IQ}MQU@œ¤¹±•¹Ñ ì(€½¹ÍÐÍÑÉ½¹]…Ñ €ô…¹‘¥‘…Ñ•Ì¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹ÍÑ…ÑÕÌ€ôôô€MQI=9}]Q œ¤¹±•¹Ñ ì(€½¹ÍÐÝ…Ñ €ô…¹‘¥‘…Ñ•Ì¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹ÍÑ…ÑÕÌ€ôôô€]Q œ¤¹±•¹Ñ ì((€É•ÑÕÉ¸ì(€€€Í½ÕÉ”è€‰¥¹…¹”µ™ÕÑÕÉ•ÌµÉ…‘…ÈµÙ•É•°œ°(€€€ÍÑÉ…Ñ•åY•ÉÍ¥½¸è€•á¡…ÕÍÑ¥½¸µÍ¡½ÉÐµÉ…‘…ÈµØÈœ°(€€€•¹•É…Ñ•‘Ðè¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤°(€€€‘ÕÉ…Ñ¥½¹5Ìè…Ñ”¹¹½Ü ¤€´ÍÑ…ÉÑ•‘Ð°(€€€ÍÕµµ…Éäèì(€€€€€Ñ½Ñ…±A…¥ÉÌè…Ñ¥Ù”¹±•¹Ñ °(€€€€€É…¹­•‘1¥ÅÕ¥‘U¹¥Ù•ÉÍ”èÕ¹¥Ù•ÉÍ”¹±•¹Ñ °(€€€€€‰…Í•…¹‘¥‘…Ñ•Ìè‰…Í•…¹‘¥‘…Ñ•Ì¹±•¹Ñ °(€€€€€µ…Ñ¡•Ìè…¹‘¥‘…Ñ•Ì¹±•¹Ñ °(€€€€€Í¡½ÉÑM•ÑÕÁÌ°(€€€€€ÍÑÉ½¹]…Ñ °(€€€€€Ý…Ñ °(€€€€€‘…¥±åMÑ…•ÉÉ½ÉÌè‘…¥±åMÑ…”¹•ÉÉ½ÉÌ¹±•¹Ñ °(€€€€€‘•Ñ…¥±MÑ…•ÉÉ½ÉÌè‘•Ñ…¥±•‘MÑ…”¹•ÉÉ½ÉÌ¹±•¹Ñ °(€€€€€½¥¹•­½I…¹­Måµ‰½±Ìè½¥¹•­½5…À¹Í¥é”°(€€€€€‰¥¹…¹•AÉ½áåI…¹­Måµ‰½±Ìè‰¥¹…¹•I…¹­5…À¹Í¥é”°(€€€€€É…¹­Ù…¥±…‰±”è½¥¹•­½5…À¹Í¥é”€ø€Àñð‰¥¹…¹•I…¹­5…À¹Í¥é”€ø€À°(€€€ô°(€€€ÍÑÉ…Ñ•äèì(€€€€€Õ¹¥Ù•ÉÍ”è€	¥¹…¹”UMPÁ•ÉÁ•ÑÕ…°ÉåÁÑ¼½¹ÑÉ…ÑÌœ°(€€€€€É…¹¬è€œÄÀÄ´ÌÀÀÁÉ¥µ…Éäì€ÌÀÄ´ÔÀÀÍ•½¹‘…Éäœ°(€€€€€±¥ÍÑ¥¹”è€œøôäÀ‘…åÌœ°(€€€€€ÅÕ½Ñ•Y½±Õµ”ÈÑ è€œøôÈÁ´UMPœ°(€€€€€‘…¥±åIÍ¤ÄÐè€œøäÀ€¡±…ÍÐ±½Í•‘…¥±ä…¹‘±”¤œ°(€€€€€É•ÑÕÉ¸Ýè€œøÔÀ”œ°(€€€€€É½Ý‘¥¹œè€Õ¹‘¥¹œÁ•É•¹Ñ¥±”€¬=$É½ÝÑ œ°(€€€€€É•Ù•ÉÍ…°è€œÅ ¼Ñ ±½Í•µ…¹‘±”•á¡…ÕÍÑ¥½¸Í¥¹…±Ìœ°(€€€€€Í¡½ÉÑM•ÑÕÁ…Ñ”è€Í½É”øôàÔ€¬½¥¹•­¼É…¹¬€¬™Õ¹‘¥¹œøõ@äÀ€¬ÍÑÉ½¹œ=$€¬€øôÈÉ•Ù•ÉÍ…°Í¥¹…±Ìœ°(€€€€€…Ñ…±åÍÑI•Ù¥•Üè€É•ÅÕ¥É•‰•™½É”…¹äÑÉ…‘”œ°(€€€€€…ÕÑ½QÉ…‘”è™…±Í”°(€€€ô°(€€€‘¥…¹½ÍÑ¥Ìèì(€€€€€Ý…É¹¥¹Ì°(€€€€€Õ¹¥Ù•ÉÍ•I•©•Ñ½Õ¹ÑÌ°(€€€€€‘…¥±åI•©•Ñ½Õ¹ÑÌ°(€€€€€‘…¥±åÉÉ½ÉÌè‘…¥±åMÑ…”¹•ÉÉ½ÉÌ¹Í±¥” À°€ÄÀ¤°(€€€€€‘•Ñ…¥±ÉÉ½ÉÌè‘•Ñ…¥±•‘MÑ…”¹•ÉÉ½ÉÌ¹Í±¥” À°€ÄÀ¤°(€€€ô°(€€€µ…Ñ¡•Ìè…¹‘¥‘…Ñ•Ì°(€ôì)ô()µ½‘Õ±”¹•áÁ½ÉÑÌ€ô…Íå¹Œ™Õ¹Ñ¥½¸¡…¹‘±•È¡É•Ä°É•Ì¤ì(€É•Ì¹Í•Ñ!•…‘•È •ÍÌµ½¹ÑÉ½°µ±±½Üµ=É¥¥¸œ°€œ¨œ¤ì(€É•Ì¹Í•Ñ!•…‘•È •ÍÌµ½¹ÑÉ½°µ±±½Üµ5•Ñ¡½‘Ìœ°€P°=AQ%=9Lœ¤ì(€É•Ì¹Í•Ñ!•…‘•È •ÍÌµ½¹ÑÉ½°µ±±½Üµ!•…‘•ÉÌœ°€½¹Ñ•¹ÐµQåÁ”œ¤ì((€¥˜€¡É•Ä¹µ•Ñ¡½€ôôô€=AQ%=9Lœ¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÈÀÐ¤¹•¹ ¤ì(€¥˜€¡É•Ä¹µ•Ñ¡½€„ôô€Pœ¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÔ¤¹©Í½¸¡ì•ÉÉ½Èè€5•Ñ¡½¹½Ð…±±½Ý•œô¤ì((€ÑÉäì(€€€½¹ÍÐÁ…å±½…€ô…Ý…¥ÐÍ…¹5…É­•Ð ¤ì(€€€É•Ì¹Í•Ñ!•…‘•È …¡”µ½¹ÑÉ½°œ°€ÁÕ‰±¥Œ°Ìµµ…á…”ôÄÈÀ°ÍÑ…±”µÝ¡¥±”µÉ•Ù…±¥‘…Ñ”ôØÀÀœ¤ì(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÈÀÀ¤¹©Í½¸¡Á…å±½…¤ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€½¹ÍÐÕÁÍÑÉ•…´€ô•ÉÉ½È¥¹ÍÑ…¹•½˜UÁÍÑÉ•…µÉÉ½È€ü•ÉÉ½È¹ÕÁÍÑÉ•…µMÑ…ÑÕÌ€è¹Õ±°ì(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ¡•ÉÉ½È¹ÍÑ…ÑÕÌñð€ÔÀÀ¤¹©Í½¸¡ì(€€€€€•ÉÉ½Èè€I…‘…ÈÍ…¸™…¥±•œ°(€€€€€µ•ÍÍ…”è•ÉÉ½È¹µ•ÍÍ…”ñð€U¹­¹½Ý¸•ÉÉ½Èœ°(€€€€€ÕÁÍÑÉ•…µMÑ…ÑÕÌèÕÁÍÑÉ•…´°(€€€€€•¹•É…Ñ•‘Ðè¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤°(€€€ô¤ì(€ô)ôì(