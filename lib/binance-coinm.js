'use strict';

const DAPI = 'https://dapi.binance.com';
const DEFAULT_TIMEOUT_MS = 12000;

class UpstreamError extends Error {
  constructor(message, status = 502, upstreamStatus = null) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

async function fetchJson(path, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const target = new URL(`${DAPI}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      headers: { Accept: 'application/json', 'User-Agent': 'binance-futures-radar-btc-v3/1.0' },
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      throw new UpstreamError(payload?.msg || payload?.message || `HTTP ${response.status}`, 502, response.status);
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new UpstreamError(`COIN-M request timed out after ${timeoutMs}ms`, 504);
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(error.message || 'Unable to reach Binance COIN-M');
  } finally {
    clearTimeout(timer);
  }
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
  })).filter((row) => Number.isFinite(row.openTime) && Number.isFinite(row.close) && row.close > 0);
}

function closedCandles(candles, now = Date.now()) {
  return (Array.isArray(candles) ? candles : []).filter((candle) => Number(candle.closeTime) < now);
}

async function fetchDailyPerpetualCandles({ pair = 'BTCUSD', limit = 500, now = Date.now() } = {}) {
  const rows = await fetchJson('/dapi/v1/continuousKlines', {
    pair,
    contractType: 'PERPETUAL',
    interval: '1d',
    limit,
  });
  return closedCandles(parseKlines(rows), now);
}

async function fetchContractMetadata(symbol = 'BTCUSD_PERP') {
  const exchangeInfo = await fetchJson('/dapi/v1/exchangeInfo');
  const contract = Array.isArray(exchangeInfo?.symbols)
    ? exchangeInfo.symbols.find((item) => item?.symbol === symbol)
    : null;
  if (!contract) throw new UpstreamError(`COIN-M contract not found: ${symbol}`);
  return {
    symbol: contract.symbol,
    pair: contract.pair,
    contractType: contract.contractType,
    contractStatus: contract.contractStatus,
    onboardDate: Number(contract.onboardDate),
    contractSize: Number(contract.contractSize),
    quoteAsset: contract.quoteAsset,
    baseAsset: contract.baseAsset,
    marginAsset: contract.marginAsset,
    liquidationFee: Number(contract.liquidationFee),
    marketTakeBound: Number(contract.marketTakeBound),
  };
}

async function fetchPremiumIndex(symbol = 'BTCUSD_PERP') {
  const payload = await fetchJson('/dapi/v1/premiumIndex', { symbol });
  const row = Array.isArray(payload) ? payload[0] : payload;
  return {
    symbol: row?.symbol || symbol,
    markPrice: Number(row?.markPrice),
    indexPrice: Number(row?.indexPrice),
    lastFundingRate: Number(row?.lastFundingRate),
    nextFundingTime: Number(row?.nextFundingTime),
    time: Number(row?.time),
  };
}

async function fetchRecentFunding(symbol = 'BTCUSD_PERP', limit = 30) {
  const rows = await fetchJson('/dapi/v1/fundingRate', { symbol, limit });
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    symbol: row.symbol,
    fundingTime: Number(row.fundingTime),
    fundingRate: Number(row.fundingRate),
  })).filter((row) => Number.isFinite(row.fundingTime) && Number.isFinite(row.fundingRate));
}

async function fetchFundingInfo(symbol = 'BTCUSD_PERP') {
  const rows = await fetchJson('/dapi/v1/fundingInfo');
  const row = Array.isArray(rows) ? rows.find((item) => item?.symbol === symbol) : null;
  return row ? {
    symbol,
    fundingIntervalHours: Number(row.fundingIntervalHours),
    adjustedFundingRateCap: Number(row.adjustedFundingRateCap),
    adjustedFundingRateFloor: Number(row.adjustedFundingRateFloor),
  } : { symbol, fundingIntervalHours: 8, adjustedFundingRateCap: null, adjustedFundingRateFloor: null };
}

module.exports = {
  DAPI,
  UpstreamError,
  fetchJson,
  parseKlines,
  closedCandles,
  fetchDailyPerpetualCandles,
  fetchContractMetadata,
  fetchPremiumIndex,
  fetchRecentFunding,
  fetchFundingInfo,
};
