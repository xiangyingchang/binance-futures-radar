'use strict';

/**
 * /api/market — Binance-only market environment snapshot.
 * Runs on Vercel (sin1) so it can reach Binance fapi directly.
 * Returns BTC/ETH 24h+7d moves and alt-coin breadth over Binance USDT
 * perpetuals (same liquidity floor as the radar universe).
 */

const BINANCE_FUTURES = 'https://fapi.binance.com';

const RUNTIME = Object.freeze({
  requestTimeoutMs: 15000,
  breadthMinQuoteVolumeUsd: 20000000, // same floor as radar-v2 universe
});

const STABLE_BASES = new Set([
  'USDC', 'USDT', 'FDUSD', 'DAI', 'TUSD', 'BUSD', 'USDE', 'PYUSD',
  'USD1', 'USDP', 'USDS', 'USDR', 'USDD', 'XUSD', 'USDX', 'EUR',
]);

class UpstreamError extends Error {
  constructor(message, status = 502, upstreamStatus = null) {
    super(message);
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

async function fetchJson(url, timeoutMs = RUNTIME.requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'binance-futures-radar/6.0' },
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      const message = payload?.msg || payload?.message || `HTTP ${response.status}`;
      throw new UpstreamError(message, 502, response.status);
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

function futuresGet(path) {
  return fetchJson(`${BINANCE_FUTURES}${path}`);
}

function parseKlines(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    close: Number(row[4]),
  })).filter((c) => Number.isFinite(c.close));
}

function pctChange(latest, older) {
  if (!Number.isFinite(latest) || !Number.isFinite(older) || older <= 0) return null;
  return ((latest - older) / older) * 100;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(x) {
  return Number.isFinite(x) ? Math.round(x * 10) / 10 : null;
}

function symbolStats(ticker, closes7d) {
  const change24hPct = Number(ticker?.priceChangePercent);
  const change7dPct = closes7d.length >= 8 ? pctChange(closes7d.at(-1), closes7d.at(-8)) : null;
  return {
    price: Number(ticker?.lastPrice) || null,
    change24hPct: round1(Number.isFinite(change24hPct) ? change24hPct : null),
    change7dPct: round1(change7dPct),
  };
}

async function scanMarket() {
  const startedAt = Date.now();

  const [exchangeInfo, tickerList, btcKlines, ethKlines] = await Promise.all([
    futuresGet('/fapi/v1/exchangeInfo'),
    futuresGet('/fapi/v1/ticker/24hr'),
    futuresGet('/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=8'),
    futuresGet('/fapi/v1/klines?symbol=ETHUSDT&interval=1d&limit=8'),
  ]);

  if (!Array.isArray(exchangeInfo?.symbols)) {
    throw new UpstreamError('Malformed Binance exchangeInfo response');
  }
  if (!Array.isArray(tickerList)) {
    throw new UpstreamError('Malformed Binance ticker response');
  }

  const active = new Map(
    exchangeInfo.symbols
      .filter((s) => (
        s.quoteAsset === 'USDT'
        && s.status === 'TRADING'
        && s.contractType === 'PERPETUAL'
        && s.underlyingType === 'COIN'
      ))
      .map((s) => [s.symbol, s])
  );

  const rows = tickerList.filter((t) => active.has(t.symbol));
  const btcTicker = rows.find((r) => r.symbol === 'BTCUSDT');
  const ethTicker = rows.find((r) => r.symbol === 'ETHUSDT');

  const btc = symbolStats(btcTicker, parseKlines(btcKlines).map((c) => c.close));
  const eth = symbolStats(ethTicker, parseKlines(ethKlines).map((c) => c.close));

  const changes = [];
  for (const r of rows) {
    const info = active.get(r.symbol);
    const base = String(info?.baseAsset || '').toUpperCase();
    if (!base || base === 'BTC' || base === 'ETH' || STABLE_BASES.has(base)) continue;
    const quoteVolume = Number(r.quoteVolume || 0);
    if (!Number.isFinite(quoteVolume) || quoteVolume < RUNTIME.breadthMinQuoteVolumeUsd) continue;
    const ch = Number(r.priceChangePercent);
    if (Number.isFinite(ch)) changes.push(ch);
  }

  const n = changes.length;
  const median24hPct = round1(median(changes));
  const positivePct = n ? Math.round((changes.filter((v) => v > 0).length / n) * 1000) / 10 : null;
  const gt5Pct = n ? Math.round((changes.filter((v) => v > 5).length / n) * 1000) / 10 : null;
  const gt10Pct = n ? Math.round((changes.filter((v) => v > 10).length / n) * 1000) / 10 : null;

  return {
    source: 'binance-fapi',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary: {
      totalUsdtPerps: active.size,
      liquidAltsCount: n,
    },
    btc,
    eth,
    breadth: {
      n,
      median24hPct,
      positivePct,
      gt5Pct,
      gt10Pct,
      universe: `Binance USDT perpetuals (crypto, non-stable, 24h quote volume >= ${RUNTIME.breadthMinQuoteVolumeUsd / 1000000}m USDT, excl. BTC/ETH)`,
    },
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
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(error.status || 500).json({
      error: 'Market scan failed',
      message: error.message || 'Unknown error',
      upstreamStatus: error instanceof UpstreamError ? error.upstreamStatus : null,
      generatedAt: new Date().toISOString(),
    });
  }
};

module.exports.scanMarket = scanMarket;
