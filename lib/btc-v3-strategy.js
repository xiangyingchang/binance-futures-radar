'use strict';

const CONFIG = Object.freeze({
  version: 'btc-v3.1-coinm',
  emaFast: 15,
  emaSlow: 30,
  maLong: 200,
  maSlopeDays: 30,
  valuationLookbackDays: 365,
  volLookbackDays: 30,
  targetAnnualVol: 0.60,
  annualizationDays: 365,
  cheapDrawdown: -0.20,
  veryCheapDrawdown: -0.35,
  cheapMaDeviation: -0.10,
  veryCheapMaDeviation: -0.20,
  minVolCap: 0.50,
  maxSignalExposure: 2.00,
  publicMarginCap: 1.50,
  coinMSymbol: 'BTCUSD_PERP',
  coinMPair: 'BTCUSD',
  expectedMarginAsset: 'BTC',
});

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStd(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function smaAt(values, period, endIndex = values.length - 1) {
  if (!Array.isArray(values) || period <= 0 || endIndex < period - 1) return null;
  const start = endIndex - period + 1;
  const window = values.slice(start, endIndex + 1).map((v) => finiteNumber(v));
  if (window.length !== period || window.some((v) => v === null)) return null;
  return mean(window);
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) {
    return Array.isArray(values) ? values.map(() => null) : [];
  }
  const clean = values.map((v) => finiteNumber(v));
  const out = new Array(clean.length).fill(null);
  if (clean.some((v) => v === null)) return out;
  let ema = mean(clean.slice(0, period));
  out[period - 1] = ema;
  const alpha = 2 / (period + 1);
  for (let i = period; i < clean.length; i += 1) {
    ema = (clean[i] * alpha) + (ema * (1 - alpha));
    out[i] = ema;
  }
  return out;
}

function realizedVol(closes, lookbackDays = CONFIG.volLookbackDays) {
  if (!Array.isArray(closes) || closes.length < lookbackDays + 1) return null;
  const window = closes.slice(-(lookbackDays + 1)).map((v) => finiteNumber(v));
  if (window.some((v) => v === null || v <= 0)) return null;
  const returns = [];
  for (let i = 1; i < window.length; i += 1) returns.push((window[i] / window[i - 1]) - 1);
  const std = sampleStd(returns);
  return std === null ? null : std * Math.sqrt(CONFIG.annualizationDays);
}

function trailingDrawdown(closes, lookbackDays = CONFIG.valuationLookbackDays) {
  if (!Array.isArray(closes) || closes.length < lookbackDays) return null;
  const window = closes.slice(-lookbackDays).map((v) => finiteNumber(v));
  if (window.some((v) => v === null || v <= 0)) return null;
  const current = window.at(-1);
  const peak = Math.max(...window);
  return (current / peak) - 1;
}

function computeSignal(closes, options = {}) {
  const values = Array.isArray(closes) ? closes.map((v) => finiteNumber(v)) : [];
  const minRequired = Math.max(CONFIG.valuationLookbackDays, CONFIG.maLong + CONFIG.maSlopeDays);
  if (values.length < minRequired || values.some((v) => v === null || v <= 0)) {
    return { ready: false, reason: `need_at_least_${minRequired}_valid_closed_daily_closes`, version: CONFIG.version };
  }

  const lastIndex = values.length - 1;
  const close = values[lastIndex];
  const ema15 = emaSeries(values, CONFIG.emaFast)[lastIndex];
  const ema30 = emaSeries(values, CONFIG.emaSlow)[lastIndex];
  const ma200 = smaAt(values, CONFIG.maLong, lastIndex);
  const ma200Past = smaAt(values, CONFIG.maLong, lastIndex - CONFIG.maSlopeDays);
  const ma200Slope30 = (ma200Past && ma200Past > 0) ? (ma200 / ma200Past) - 1 : null;
  const drawdown365 = trailingDrawdown(values, CONFIG.valuationLookbackDays);
  const ma200Deviation = ma200 ? (close / ma200) - 1 : null;
  const rv30 = realizedVol(values, CONFIG.volLookbackDays);

  const aboveMa200 = close > ma200;
  const emaBull = ema15 > ema30;
  const maSlopePositive = ma200Slope30 > 0;
  const trendScore = Number(aboveMa200) + Number(emaBull) + Number(maSlopePositive);
  const baseTargets = [0.50, 0.75, 1.00, 1.25];
  const regimeTarget = baseTargets[trendScore];
  const bearLock = !aboveMa200 && ma200Slope30 < 0;

  const cheap = drawdown365 <= CONFIG.cheapDrawdown || ma200Deviation <= CONFIG.cheapMaDeviation;
  const veryCheap = drawdown365 <= CONFIG.veryCheapDrawdown || ma200Deviation <= CONFIG.veryCheapMaDeviation;
  let valuationAdjustedTarget = regimeTarget;
  if (trendScore === 2 && cheap) valuationAdjustedTarget = Math.max(valuationAdjustedTarget, 1.25);
  if (trendScore === 3 && cheap) valuationAdjustedTarget = Math.max(valuationAdjustedTarget, 1.50);
  if (trendScore === 3 && veryCheap) valuationAdjustedTarget = Math.max(valuationAdjustedTarget, 2.00);
  if (bearLock) valuationAdjustedTarget = 0;

  const volatilityCap = rv30 > 0
    ? clamp(CONFIG.targetAnnualVol / rv30, CONFIG.minVolCap, CONFIG.maxSignalExposure)
    : CONFIG.minVolCap;
  const rawSignalTarget = bearLock ? 0 : Math.min(valuationAdjustedTarget, volatilityCap, CONFIG.maxSignalExposure);

  const marginCap = finiteNumber(options.marginCap, CONFIG.publicMarginCap);
  const finalTarget = Math.min(rawSignalTarget, clamp(marginCap, 0, CONFIG.maxSignalExposure));
  const dataQualityFlags = [];
  if (!Number.isFinite(rv30)) dataQualityFlags.push('rv30_unavailable');
  if (options.marginCap == null) dataQualityFlags.push('static_public_margin_cap_1_5x');

  return {
    ready: true,
    version: CONFIG.version,
    close,
    ema15,
    ema30,
    ma200,
    ma200Past,
    ma200Slope30,
    drawdown365,
    ma200Deviation,
    rv30,
    aboveMa200,
    emaBull,
    maSlopePositive,
    trendScore,
    bearLock,
    cheap,
    veryCheap,
    regimeTarget,
    valuationAdjustedTarget,
    volatilityCap,
    rawSignalTarget,
    marginCap,
    finalTarget,
    tactical2xRequested: rawSignalTarget > CONFIG.publicMarginCap,
    dataQualityFlags,
    autoTrade: false,
  };
}

function inversePnlBtc(signedContracts, contractSizeUsd, fromPrice, toPrice) {
  const q = finiteNumber(signedContracts);
  const size = finiteNumber(contractSizeUsd);
  const p0 = finiteNumber(fromPrice);
  const p1 = finiteNumber(toPrice);
  if ([q, size, p0, p1].some((v) => v === null) || p0 <= 0 || p1 <= 0) return null;
  return q * size * ((1 / p0) - (1 / p1));
}

function fundingPnlBtc(signedContracts, contractSizeUsd, markPrice, fundingRate) {
  const q = finiteNumber(signedContracts);
  const size = finiteNumber(contractSizeUsd);
  const price = finiteNumber(markPrice);
  const rate = finiteNumber(fundingRate);
  if ([q, size, price, rate].some((v) => v === null) || price <= 0) return null;
  return -(q * size / price) * rate;
}

function targetContracts({ targetExposure, equityBtc, price, contractSizeUsd, currentContracts = 0 }) {
  const target = finiteNumber(targetExposure);
  const equity = finiteNumber(equityBtc);
  const px = finiteNumber(price);
  const size = finiteNumber(contractSizeUsd);
  const current = finiteNumber(currentContracts, 0);
  if ([target, equity, px, size].some((v) => v === null) || equity <= 0 || px <= 0 || size <= 0) return null;
  const overlayBtc = (target - 1) * equity;
  const overlayUsd = overlayBtc * px;
  const signedContracts = Math.round(overlayUsd / size);
  return {
    targetExposure: target,
    equityBtc: equity,
    overlayBtc,
    overlayUsd,
    signedContracts,
    deltaContracts: signedContracts - current,
    side: signedContracts > current ? 'BUY' : signedContracts < current ? 'SELL' : 'HOLD',
  };
}

function maintenanceHeadroom({ equityBtc, signedContracts, contractSizeUsd, markPrice, maintenanceRate = 0.10 }) {
  const equity = finiteNumber(equityBtc);
  const q = finiteNumber(signedContracts);
  const size = finiteNumber(contractSizeUsd);
  const px = finiteNumber(markPrice);
  const rate = finiteNumber(maintenanceRate);
  if ([equity, q, size, px, rate].some((v) => v === null) || px <= 0 || rate < 0) return null;
  const maintenanceBtc = Math.abs(q) * size / px * rate;
  return {
    maintenanceBtc,
    headroomMultiple: maintenanceBtc > 0 ? equity / maintenanceBtc : Infinity,
    passes: maintenanceBtc === 0 || equity > maintenanceBtc,
  };
}

module.exports = {
  CONFIG,
  finiteNumber,
  clamp,
  sampleStd,
  smaAt,
  emaSeries,
  realizedVol,
  trailingDrawdown,
  computeSignal,
  inversePnlBtc,
  fundingPnlBtc,
  targetContracts,
  maintenanceHeadroom,
};
