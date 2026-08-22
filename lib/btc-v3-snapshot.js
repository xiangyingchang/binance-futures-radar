'use strict';

const { CONFIG, computeSignal, targetContracts } = require('./btc-v3-strategy');
const {
  fetchDailyIndexCandles,
  fetchContractMetadata,
  fetchPremiumIndex,
  fetchRecentFunding,
  fetchFundingInfo,
} = require('./binance-coinm');

function iso(ms) {
  return Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null;
}

async function buildBtcV3Snapshot(options = {}) {
  const requestedAt = Date.now();
  const symbol = options.symbol || CONFIG.coinMSymbol;
  const pair = options.pair || CONFIG.coinMPair;
  const marginCap = options.marginCap ?? CONFIG.publicMarginCap;
  const [candles, contract, premium, recentFunding, fundingInfo] = await Promise.all([
    fetchDailyIndexCandles({ pair, limit: 500, now: requestedAt }),
    fetchContractMetadata(symbol),
    fetchPremiumIndex(symbol),
    fetchRecentFunding(symbol, 30),
    fetchFundingInfo(symbol),
  ]);

  const qualityFlags = [];
  if (contract.marginAsset !== CONFIG.expectedMarginAsset) qualityFlags.push(`unexpected_margin_asset_${contract.marginAsset}`);
  if (contract.contractType !== 'PERPETUAL') qualityFlags.push(`unexpected_contract_type_${contract.contractType}`);
  if (contract.contractStatus !== 'TRADING') qualityFlags.push(`contract_status_${contract.contractStatus}`);
  if (!Number.isFinite(contract.contractSize) || contract.contractSize <= 0) qualityFlags.push('invalid_contract_size');
  if (candles.length < CONFIG.valuationLookbackDays) qualityFlags.push('insufficient_closed_daily_history');

  const signal = computeSignal(candles.map((candle) => candle.close), { marginCap });
  const latest = candles.at(-1) || null;
  const referenceSizing = signal.ready && latest && Number.isFinite(contract.contractSize)
    ? targetContracts({
      targetExposure: signal.finalTarget,
      equityBtc: 1,
      price: latest.close,
      contractSizeUsd: contract.contractSize,
      currentContracts: 0,
    })
    : null;

  return {
    strategyVersion: CONFIG.version,
    observedAt: new Date(requestedAt).toISOString(),
    sourceRequestTimestamp: requestedAt,
    source: 'Binance COIN-M public REST',
    signalPriceSource: 'BTCUSD index price daily klines',
    codeCommitSha: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || null,
    deploymentEnvironment: process.env.VERCEL_ENV || null,
    deploymentUrl: process.env.VERCEL_URL || null,
    executionRegion: process.env.VERCEL_REGION || process.env.NOW_REGION || null,
    instrument: {
      ...contract,
      canonical: symbol === CONFIG.coinMSymbol && contract.marginAsset === 'BTC' && contract.contractType === 'PERPETUAL',
    },
    latestClosedCandle: latest ? {
      openTime: latest.openTime,
      openTimeIso: iso(latest.openTime),
      closeTime: latest.closeTime,
      closeTimeIso: iso(latest.closeTime),
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
    } : null,
    signal,
    funding: {
      currentRate: premium.lastFundingRate,
      markPrice: premium.markPrice,
      indexPrice: premium.indexPrice,
      nextFundingTime: premium.nextFundingTime,
      nextFundingTimeIso: iso(premium.nextFundingTime),
      intervalHours: fundingInfo.fundingIntervalHours,
      recent: recentFunding,
    },
    referenceSizingForOneBtc: referenceSizing,
    dataQualityFlags: [...qualityFlags, ...(signal.dataQualityFlags || [])],
    autoTrade: false,
    executionMode: 'READ_ONLY_FORWARD_TEST',
  };
}

module.exports = { buildBtcV3Snapshot };
