'use strict';

const fs = require('fs');
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

function nearestClosedMark(markCandles, timestamp) {
  let lo = 0; let hi = markCandles.length - 1; let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candle = markCandles[mid];
    if (candle.closeTime <= timestamp) { best = candle; lo = mid + 1; } else hi = mid - 1;
  }
  return best ? best.close : null;
}

function maxDrawdown(values) {
  let peak = -Infinity; let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, (value / peak) - 1);
  }
  return worst;
}

function periodKey(ts, frequency) {
  const d = new Date(ts);
  if (frequency === 'daily') return d.toISOString().slice(0, 10);
  if (frequency === 'monthly') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((copy - yearStart) / DAY) + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function loadData() {
  const contract = await fetchContractMetadata(CONFIG.coinMSymbol);
  const startTime = contract.onboardDate;
  const endTime = Date.now() - DAY;
  const [indexRaw, executionRaw, markRaw, funding] = await Promise.all([
    fetchWindowed('/dapi/v1/indexPriceKlines', { pair: CONFIG.coinMPair, interval: '1d' }, startTime, endTime),
    fetchWindowed('/dapi/v1/continuousKlines', { pair: CONFIG.coinMPair, contractType: 'PERPETUAL', interval: '1d' }, startTime, endTime),
    fetchWindowed('/dapi/v1/markPriceKlines', { symbol: CONFIG.coinMSymbol, interval: '4h' }, startTime, endTime),
    fetchFundingRange(CONFIG.coinMSymbol, startTime, endTime),
  ]);
  return { contract, indexDaily: parseKlines(indexRaw), executionDaily: parseKlines(executionRaw), markCandles: parseKlines(markRaw), funding };
}

function runScenario(data, frequency) {
  const { contract, indexDaily, executionDaily, markCandles, funding } = data;
  const executionByOpen = new Map(executionDaily.map((row) => [row.openTime, row]));
  const fundingByDay = new Map();
  for (const row of funding) {
    const dayOpen = Math.floor(row.fundingTime / DAY) * DAY;
    if (!fundingByDay.has(dayOpen)) fundingByDay.set(dayOpen, []);
    fundingByDay.get(dayOpen).push(row);
  }

  let equityBtc = 1, contracts = 0, lastPrice = null;
  let totalFeesBtc = 0, totalSlippageBtc = 0, totalFundingBtc = 0;
  let liquidated = false, tradeCount = 0, turnoverUsd = 0;
  let heldTarget = 1, lastKey = null;
  const closes = [], usdNav = [], btcNav = [], exposureRows = [];

  for (const indexCandle of indexDaily) {
    const execution = executionByOpen.get(indexCandle.openTime);
    if (!execution) continue;
    if (lastPrice !== null) equityBtc += inversePnlBtc(contracts, contract.contractSize, lastPrice, execution.open);
    lastPrice = execution.open;

    for (const item of (fundingByDay.get(indexCandle.openTime) || []).filter((r) => r.fundingTime <= indexCandle.openTime)) {
      const mark = nearestClosedMark(markCandles, item.fundingTime) || execution.open;
      equityBtc += inversePnlBtc(contracts, contract.contractSize, lastPrice, mark); lastPrice = mark;
      const pnl = fundingPnlBtc(contracts, contract.contractSize, mark, item.fundingRate); equityBtc += pnl; totalFundingBtc += pnl;
    }
    if (lastPrice !== execution.open) { equityBtc += inversePnlBtc(contracts, contract.contractSize, lastPrice, execution.open); lastPrice = execution.open; }

    const signal = closes.length >= CONFIG.valuationLookbackDays ? computeSignal(closes) : null;
    const desired = signal?.ready ? signal.finalTarget : 1;
    const key = periodKey(indexCandle.openTime, frequency);
    if (lastKey === null || key !== lastKey) { heldTarget = desired; lastKey = key; }
    const targetExposure = heldTarget;

    const sizing = targetContracts({ targetExposure, equityBtc, price: execution.open, contractSizeUsd: contract.contractSize, currentContracts: contracts });
    const delta = sizing.deltaContracts;
    if (delta !== 0) {
      const slip = SLIPPAGE_BPS / 10000;
      const fillPrice = execution.open * (delta > 0 ? (1 + slip) : (1 - slip));
      const slippagePnl = inversePnlBtc(delta, contract.contractSize, fillPrice, execution.open);
      equityBtc += slippagePnl; totalSlippageBtc += slippagePnl;
      const fee = Math.abs(delta) * contract.contractSize / fillPrice * (FEE_BPS / 10000);
      equityBtc -= fee; totalFeesBtc += fee; contracts = sizing.signedContracts; lastPrice = execution.open;
      tradeCount += 1; turnoverUsd += Math.abs(delta) * contract.contractSize;
    }

    const worstPrice = contracts >= 0 ? execution.low : execution.high;
    const stressedEquity = equityBtc + inversePnlBtc(contracts, contract.contractSize, execution.open, worstPrice);
    const stress = maintenanceHeadroom({ equityBtc: stressedEquity, signedContracts: contracts, contractSizeUsd: contract.contractSize, markPrice: worstPrice, maintenanceRate: STRESS_MAINTENANCE_RATE });
    if (!stress || !stress.passes || stressedEquity <= 0) { liquidated = true; break; }

    for (const item of (fundingByDay.get(indexCandle.openTime) || []).filter((r) => r.fundingTime > indexCandle.openTime && r.fundingTime <= execution.closeTime)) {
      const mark = nearestClosedMark(markCandles, item.fundingTime) || lastPrice;
      equityBtc += inversePnlBtc(contracts, contract.contractSize, lastPrice, mark); lastPrice = mark;
      const pnl = fundingPnlBtc(contracts, contract.contractSize, mark, item.fundingRate); equityBtc += pnl; totalFundingBtc += pnl;
    }

    equityBtc += inversePnlBtc(contracts, contract.contractSize, lastPrice, execution.close); lastPrice = execution.close;
    closes.push(indexCandle.close);
    btcNav.push(equityBtc); usdNav.push(equityBtc * execution.close); exposureRows.push(targetExposure);
  }

  return {
    frequency,
    endingBtc: btcNav.at(-1) || equityBtc,
    btcGainPct: ((btcNav.at(-1) || equityBtc) - 1) * 100,
    endingUsd: usdNav.at(-1) || null,
    btcMaxDrawdown: maxDrawdown(btcNav),
    usdMaxDrawdown: maxDrawdown(usdNav),
    totalFeesBtc,
    totalSlippageBtc,
    totalFundingBtc,
    tradeCount,
    turnoverUsd,
    avgExposure: exposureRows.reduce((a,b)=>a+b,0) / Math.max(1, exposureRows.length),
    liquidated,
    observations: btcNav.length,
  };
}

(async () => {
  const data = await loadData();
  const scenarios = ['daily','weekly','monthly'].map((f) => runScenario(data, f));
  const daily = scenarios[0];
  for (const s of scenarios) {
    s.deltaVsDaily = {
      endingBtc: s.endingBtc - daily.endingBtc,
      btcGainPctPoints: s.btcGainPct - daily.btcGainPct,
      btcMaxDrawdownPoints: (s.btcMaxDrawdown - daily.btcMaxDrawdown) * 100,
      usdMaxDrawdownPoints: (s.usdMaxDrawdown - daily.usdMaxDrawdown) * 100,
      tradeCountPct: daily.tradeCount ? ((s.tradeCount / daily.tradeCount) - 1) * 100 : null,
      turnoverPct: daily.turnoverUsd ? ((s.turnoverUsd / daily.turnoverUsd) - 1) * 100 : null,
    };
  }
  const result = {
    generatedAt: new Date().toISOString(),
    strategyVersion: CONFIG.version,
    researchOnly: true,
    productionChanged: false,
    timing: 'T-1 closed signal -> T open; weekly uses first UTC day of ISO week, monthly first UTC day of month',
    costs: { feeBps: FEE_BPS, slippageBps: SLIPPAGE_BPS, funding: 'included', stressMaintenanceRate: STRESS_MAINTENANCE_RATE },
    scenarios,
  };
  fs.mkdirSync('research', { recursive: true });
  fs.writeFileSync('research/btc-v3-rebalance-frequency-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => { console.error(error); process.exit(1); });
