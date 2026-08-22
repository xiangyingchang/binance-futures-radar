'use strict';

const {
  CONFIG,
  computeSignal,
  inversePnlBtc,
  fundingPnlBtc,
  targetContracts,
  maintenanceHeadroom,
} = require('../lib/btc-v3-strategy');
const { fetchJson, parseKlines, fetchContractMetadata } = require('../lib/binance-coinm');

const DAY = 86400000;
const WINDOW = 199 * DAY;
const FEE_BPS = Number(process.env.BTC_V3_FEE_BPS || 5);
const SLIPPAGE_BPS = Number(process.env.BTC_V3_SLIPPAGE_BPS || 5);
const STRESS_MAINTENANCE_RATE = Number(process.env.BTC_V3_MAINT_RATE || 0.10);

async function fetchWindowed(path, baseParams, startTime, endTime) {
  const all = [];
  for (let start = startTime; start <= endTime; start += WINDOW + 1) {
    const end = Math.min(endTime, start + WINDOW);
    const rows = await fetchJson(path, { ...baseParams, startTime: start, endTime: end, limit: 1500 }, 20000);
    if (Array.isArray(rows)) all.push(...rows);
  }
  const seen = new Set();
  return all.filter((row) => {
    const key = Array.isArray(row) ? Number(row[0]) : Number(row.fundingTime);
    if (!Number.isFinite(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (Array.isArray(a) ? Number(a[0]) : Number(a.fundingTime)) - (Array.isArray(b) ? Number(b[0]) : Number(b.fundingTime)));
}

async function fetchFundingRange(symbol, startTime, endTime) {
  const out = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const batch = await fetchJson('/dapi/v1/fundingRate', { symbol, startTime: cursor, endTime, limit: 1000 }, 20000);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 1000) break;
    const last = Number(batch.at(-1).fundingTime);
    if (!Number.isFinite(last) || last < cursor) break;
    cursor = last + 1;
  }
  return out.map((row) => ({ fundingTime: Number(row.fundingTime), fundingRate: Number(row.fundingRate) }))
    .filter((row) => Number.isFinite(row.fundingTime) && Number.isFinite(row.fundingRate))
    .sort((a, b) => a.fundingTime - b.fundingTime);
}

function nearestMark(markCandles, timestamp) {
  let lo = 0;
  let hi = markCandles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candle = markCandles[mid];
    if (candle.openTime <= timestamp) {
      best = candle;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best ? best.close : null;
}

function maxDrawdown(values) {
  let peak = -Infinity;
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, (value / peak) - 1);
  }
  return worst;
}

async function main() {
  const contract = await fetchContractMetadata(CONFIG.coinMSymbol);
  if (contract.marginAsset !== 'BTC' || contract.contractType !== 'PERPETUAL') {
    throw new Error(`Canonical instrument mismatch: ${JSON.stringify(contract)}`);
  }
  const startTime = contract.onboardDate;
  const endTime = Date.now() - DAY;

  const [indexRaw, executionRaw, markRaw, funding] = await Promise.all([
    fetchWindowed('/dapi/v1/indexPriceKlines', { pair: CONFIG.coinMPair, interval: '1d' }, startTime, endTime),
    fetchWindowed('/dapi/v1/continuousKlines', { pair: CONFIG.coinMPair, contractType: 'PERPETUAL', interval: '1d' }, startTime, endTime),
    fetchWindowed('/dapi/v1/markPriceKlines', { symbol: CONFIG.coinMSymbol, interval: '4h' }, startTime, endTime),
    fetchFundingRange(CONFIG.coinMSymbol, startTime, endTime),
  ]);

  const indexDaily = parseKlines(indexRaw);
  const executionDaily = parseKlines(executionRaw);
  const markCandles = parseKlines(markRaw);
  const executionByOpen = new Map(executionDaily.map((row) => [row.openTime, row]));
  const fundingByDay = new Map();
  for (const row of funding) {
    const dayOpen = Math.floor(row.fundingTime / DAY) * DAY;
    if (!fundingByDay.has(dayOpen)) fundingByDay.set(dayOpen, []);
    fundingByDay.get(dayOpen).push(row);
  }

  let equityBtc = 1;
  let contracts = 0;
  let lastPrice = null;
  let totalFeesBtc = 0;
  let totalFundingBtc = 0;
  let liquidated = false;
  const closes = [];
  const usdNav = [];
  const btcNav = [];
  const rows = [];

  for (let i = 0; i < indexDaily.length; i += 1) {
    const indexCandle = indexDaily[i];
    const execution = executionByOpen.get(indexCandle.openTime);
    if (!execution) continue;

    if (lastPrice !== null) equityBtc += inversePnlBtc(contracts, contract.contractSize, lastPrice, execution.open);
    lastPrice = execution.open;

    const midnightFunding = (fundingByDay.get(indexCandle.openTime) || [])
      .filter((row) => row.fundingTime <= indexCandle.openTime);
    for (const item of midnightFunding) {
      const mark = nearestMark(markCandles, item.fundingTime) || execution.open;
      equityBtc += inversePnlBtc(contracts, contract.contractSize, lastPrice, mark);
      lastPrice = mark;
      const fundingPnl = fundingPnlBtc(contracts, contract.contractSize, mark, item.fundingRate);
      equityBtc += fundingPnl;
      totalFundingBtc += fundingPnl;
    }
    if (lastPrice !== execution.open) {
      equityBtc += inversePnlBtc(contracts, contract.contractSize, lastPrice, execution.open);
      lastPrice = execution.open;
    }

    const previousSignal = closes.length >= CONFIG.valuationLookbackDays ? computeSignal(closes) : null;
    const targetExposure = previousSignal?.ready ? previousSignal.finalTarget : 1;
    const sizing = targetContracts({
      targetExposure,
      equityBtc,
      price: execution.open,
      contractSizeUsd: contract.contractSize,
      currentContracts: contracts,
    });
    if (!sizing) throw new Error(`Unable to size on ${new Date(indexCandle.openTime).toISOString()}`);

    const delta = sizing.deltaContracts;
    if (delta !== 0) {
      const slip = SLIPPAGE_BPS / 10000;
      const execPrice = execution.open * (delta > 0 ? (1 + slip) : (1 - slip));
      equityBtc += inversePnlBtc(delta, contract.contractSize, execution.open, execPrice);
      const fee = Math.abs(delta) * contract.contractSize / execPrice * (FEE_BPS / 10000);
      equityBtc -= fee;
      totalFeesBtc += fee;
      contracts = sizing.signedContracts;
      lastPrice = execution.open;
    }

    const worstPrice = contracts >= 0 ? execution.low : execution.high;
    const stressedEquity = equityBtc + inversePnlBtc(contracts, contract.contractSize, execution.open, worstPrice);
    const stress = maintenanceHeadroom({
      equityBtc: stressedEquity,
      signedContracts: contracts,
      contractSizeUsd: contract.contractSize,
      markPrice: worstPrice,
      maintenanceRate: STRESS_MAINTENANCE_RATE,
    });
    if (!stress || !stress.passes || stressedEquity <= 0) {
      liquidated = true;
      rows.push({
        date: new Date(indexCandle.openTime).toISOString().slice(0, 10),
        liquidated: true,
        targetExposure,
        contracts,
      });
      break;
    }

    const intradayFunding = (fundingByDay.get(indexCandle.openTime) || [])
      .filter((row) => row.fundingTime > indexCandle.openTime && row.fundingTime <= execution.closeTime);
    for (const item of intradayFunding) {
      const mark = nearestMark(markCandles, item.fundingTime) || execution.close;
      equityBtc += inversePnlBtc(contracts, contract.contractSize, lastPrice, mark);
      lastPrice = mark;
      const fundingPnl = fundingPnlBtc(contracts, contract.contractSize, mark, item.fundingRate);
      equityBtc += fundingPnl;
      totalFundingBtc += fundingPnl;
    }

    equityBtc += inversePnlBtc(contracts, contract.contractSize, lastPrice, execution.close);
    lastPrice = execution.close;
    closes.push(indexCandle.close);

    const navUsd = equityBtc * execution.close;
    btcNav.push(equityBtc);
    usdNav.push(navUsd);
    rows.push({
      date: new Date(indexCandle.openTime).toISOString().slice(0, 10),
      indexClose: indexCandle.close,
      perpClose: execution.close,
      equityBtc,
      navUsd,
      targetExposure,
      contracts,
      trendScore: previousSignal?.trendScore ?? null,
      bearLock: previousSignal?.bearLock ?? false,
      finalTarget: previousSignal?.finalTarget ?? 1,
      maintenanceHeadroom: stress.headroomMultiple,
    });
  }

  const endingBtc = btcNav.at(-1) || equityBtc;
  const summary = {
    strategyVersion: CONFIG.version,
    canonicalInstrument: CONFIG.coinMSymbol,
    signalSource: 'Binance COIN-M BTCUSD index price daily klines',
    executionSource: 'Binance COIN-M BTCUSD perpetual continuous daily klines',
    startDate: rows[0]?.date || null,
    endDate: rows.at(-1)?.date || null,
    startingBtc: 1,
    endingBtc,
    btcGainPct: (endingBtc - 1) * 100,
    usdMaxDrawdown: maxDrawdown(usdNav),
    btcMaxDrawdown: maxDrawdown(btcNav),
    totalFeesBtc,
    totalFundingBtc,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    stressMaintenanceRate: STRESS_MAINTENANCE_RATE,
    liquidated,
    observations: rows.length,
    caveat: 'Research backtest. Historical exchange maintenance tiers are not reconstructed; a conservative static maintenance-rate stress test is used instead.',
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
