'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadMarketData,
  DAY,
  dateOnly,
  maxDrawdown,
} = require('./btc-v3-exposure-curve-research');
const {
  CONFIG,
  computeSignal,
  inversePnlBtc,
  fundingPnlBtc,
  targetContracts,
  maintenanceHeadroom,
} = require('../lib/btc-v3-strategy');

const FEE_BPS = Number(process.env.BTC_V3_FEE_BPS || 5);
const SLIPPAGE_BPS = Number(process.env.BTC_V3_SLIPPAGE_BPS || 5);
const STRESS_MAINTENANCE_RATE = Number(process.env.BTC_V3_MAINT_RATE || 0.10);
const AHR_URL = 'https://raw.githubusercontent.com/RuochenLyu/ahr999-dataset/main/datasets/ahr999.csv';

function aggregateDaily(candles) {
  const grouped = new Map();
  for (const bar of candles) {
    const openTime = Math.floor(bar.openTime / DAY) * DAY;
    if (!grouped.has(openTime)) {
      grouped.set(openTime, {
        openTime,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        closeTime: bar.closeTime,
      });
    } else {
      const row = grouped.get(openTime);
      row.high = Math.max(row.high, bar.high);
      row.low = Math.min(row.low, bar.low);
      row.close = bar.close;
      row.closeTime = bar.closeTime;
    }
  }
  return [...grouped.values()].sort((a, b) => a.openTime - b.openTime);
}

async function loadAhr() {
  const res = await fetch(AHR_URL, {
    headers: { 'User-Agent': 'binance-futures-radar-v3-ahr-fusion-research/1.0' },
  });
  if (!res.ok) throw new Error(`AHR dataset fetch failed: HTTP ${res.status}`);
  const csv = await res.text();
  const rows = csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const p = line.split(',');
    return { date: p[0], ahr999: Number(p[3]), close: Number(p[1]) };
  }).filter((row) => row.date && Number.isFinite(row.ahr999));
  return new Map(rows.map((row) => [row.date, row]));
}

function nearestClosedMark(markBars, timestamp) {
  let lo = 0;
  let hi = markBars.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const bar = markBars[mid];
    if (bar.closeTime <= timestamp) {
      best = bar;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best ? best.close : null;
}

function slippagePnlBtc(deltaContracts, contractSizeUsd, referencePrice, fillPrice) {
  return inversePnlBtc(deltaContracts, contractSizeUsd, fillPrice, referencePrice);
}

function scenarioTarget(mode, baseSignal, overrideActive) {
  const base = baseSignal?.ready ? baseSignal.finalTarget : 1;
  if (mode === 'v3') return base;
  if (mode === 'override_2x') return overrideActive ? 2 : base;
  if (mode === 'hard_veto') return overrideActive && !baseSignal.bearLock ? 2 : base;
  if (mode === 'soft_1x_then_2x') {
    if (!overrideActive) return base;
    return baseSignal.bearLock ? 1 : 2;
  }
  throw new Error(`Unknown mode ${mode}`);
}

function updateOverride(openTime, ahrByDate, current) {
  if (new Date(openTime).getUTCDay() !== 0) return { active: current, ahr: null, changed: false };
  const previousDate = dateOnly(openTime - DAY);
  const row = ahrByDate.get(previousDate);
  if (!row) return { active: current, ahr: null, changed: false };
  let active = current;
  if (row.ahr999 < 0.40) active = true;
  else if (row.ahr999 >= 0.45) active = false;
  return { active, ahr: row.ahr999, changed: active !== current };
}

function fundingCoverage(market, startTime, endTime) {
  const rows = market.funding.filter((x) => x.fundingTime >= startTime && x.fundingTime <= endTime);
  return {
    status: market.fundingData.firstFundingTime && market.fundingData.firstFundingTime <= startTime ? 'complete_or_near_complete' : 'partial',
    firstAvailableDate: market.fundingData.firstFundingTime ? dateOnly(market.fundingData.firstFundingTime) : null,
    lastAvailableDate: market.fundingData.lastFundingTime ? dateOnly(market.fundingData.lastFundingTime) : null,
    eventsInPeriod: rows.length,
  };
}

function runScenario({ mode, market, ahrByDate }) {
  const executionDaily = aggregateDaily(market.executionBars);
  const executionByOpen = new Map(executionDaily.map((row) => [row.openTime, row]));
  const fundingByDay = new Map();
  for (const row of market.funding) {
    const dayOpen = Math.floor(row.fundingTime / DAY) * DAY;
    if (!fundingByDay.has(dayOpen)) fundingByDay.set(dayOpen, []);
    fundingByDay.get(dayOpen).push(row);
  }

  let equityBtc = 1;
  let contracts = 0;
  let lastPrice = null;
  let totalFeesBtc = 0;
  let totalSlippageBtc = 0;
  let totalFundingBtc = 0;
  let liquidated = false;
  let minMaintenanceHeadroom = Infinity;
  let overrideActive = false;
  let overrideDays = 0;
  let bearLockOverrideDays = 0;
  let daysAt2x = 0;
  let entries = 0;
  let exits = 0;
  const closes = [];
  const btcNav = [];
  const usdNav = [];
  const exposureSeries = [];
  const rows = [];

  for (const indexCandle of market.indexDaily) {
    const execution = executionByOpen.get(indexCandle.openTime);
    if (!execution) continue;

    if (lastPrice !== null) equityBtc += inversePnlBtc(contracts, market.contract.contractSize, lastPrice, execution.open);
    lastPrice = execution.open;

    const midnightFunding = (fundingByDay.get(indexCandle.openTime) || [])
      .filter((row) => row.fundingTime <= indexCandle.openTime);
    for (const item of midnightFunding) {
      const mark = nearestClosedMark(market.markBars, item.fundingTime) || execution.open;
      equityBtc += inversePnlBtc(contracts, market.contract.contractSize, lastPrice, mark);
      lastPrice = mark;
      const pnl = fundingPnlBtc(contracts, market.contract.contractSize, mark, item.fundingRate);
      equityBtc += pnl;
      totalFundingBtc += pnl;
    }
    if (lastPrice !== execution.open) {
      equityBtc += inversePnlBtc(contracts, market.contract.contractSize, lastPrice, execution.open);
      lastPrice = execution.open;
    }

    const previousSignal = closes.length >= CONFIG.valuationLookbackDays
      ? computeSignal(closes)
      : null;

    const overrideUpdate = updateOverride(indexCandle.openTime, ahrByDate, overrideActive);
    if (!overrideActive && overrideUpdate.active) entries += 1;
    if (overrideActive && !overrideUpdate.active) exits += 1;
    overrideActive = overrideUpdate.active;

    const targetExposure = previousSignal?.ready
      ? scenarioTarget(mode, previousSignal, overrideActive)
      : 1;

    if (overrideActive) {
      overrideDays += 1;
      if (previousSignal?.bearLock) bearLockOverrideDays += 1;
    }
    if (Math.abs(targetExposure - 2) < 1e-9) daysAt2x += 1;

    const sizing = targetContracts({
      targetExposure,
      equityBtc,
      price: execution.open,
      contractSizeUsd: market.contract.contractSize,
      currentContracts: contracts,
    });
    if (!sizing) throw new Error(`Unable to size on ${dateOnly(indexCandle.openTime)}`);

    const delta = sizing.deltaContracts;
    if (delta !== 0) {
      const slip = SLIPPAGE_BPS / 10000;
      const fillPrice = execution.open * (delta > 0 ? (1 + slip) : (1 - slip));
      const slippagePnl = slippagePnlBtc(delta, market.contract.contractSize, execution.open, fillPrice);
      equityBtc += slippagePnl;
      totalSlippageBtc += slippagePnl;
      const fee = Math.abs(delta) * market.contract.contractSize / fillPrice * (FEE_BPS / 10000);
      equityBtc -= fee;
      totalFeesBtc += fee;
      contracts = sizing.signedContracts;
      lastPrice = execution.open;
    }

    const worstPrice = contracts >= 0 ? execution.low : execution.high;
    const stressedEquity = equityBtc + inversePnlBtc(
      contracts,
      market.contract.contractSize,
      execution.open,
      worstPrice,
    );
    const stress = maintenanceHeadroom({
      equityBtc: stressedEquity,
      signedContracts: contracts,
      contractSizeUsd: market.contract.contractSize,
      markPrice: worstPrice,
      maintenanceRate: STRESS_MAINTENANCE_RATE,
    });
    if (stress?.headroomMultiple < minMaintenanceHeadroom) minMaintenanceHeadroom = stress.headroomMultiple;
    if (!stress || !stress.passes || stressedEquity <= 0) {
      liquidated = true;
      rows.push({
        date: dateOnly(indexCandle.openTime),
        liquidated: true,
        targetExposure,
        bearLock: previousSignal?.bearLock ?? false,
        overrideActive,
      });
      break;
    }

    const intradayFunding = (fundingByDay.get(indexCandle.openTime) || [])
      .filter((row) => row.fundingTime > indexCandle.openTime && row.fundingTime <= execution.closeTime);
    for (const item of intradayFunding) {
      const mark = nearestClosedMark(market.markBars, item.fundingTime) || lastPrice;
      equityBtc += inversePnlBtc(contracts, market.contract.contractSize, lastPrice, mark);
      lastPrice = mark;
      const pnl = fundingPnlBtc(contracts, market.contract.contractSize, mark, item.fundingRate);
      equityBtc += pnl;
      totalFundingBtc += pnl;
    }

    equityBtc += inversePnlBtc(contracts, market.contract.contractSize, lastPrice, execution.close);
    lastPrice = execution.close;
    closes.push(indexCandle.close);

    const navUsd = equityBtc * execution.close;
    const actualExposure = 1 + ((contracts * market.contract.contractSize) / execution.close) / equityBtc;
    btcNav.push(equityBtc);
    usdNav.push(navUsd);
    exposureSeries.push(actualExposure);
    rows.push({
      date: dateOnly(indexCandle.openTime),
      equityBtc,
      navUsd,
      targetExposure,
      actualExposure,
      trendScore: previousSignal?.trendScore ?? null,
      bearLock: previousSignal?.bearLock ?? false,
      overrideActive,
      ahrOnDecisionDay: overrideUpdate.ahr,
      maintenanceHeadroom: stress.headroomMultiple,
    });
  }

  const endingBtc = btcNav.at(-1) || equityBtc;
  const lastExecution = executionDaily.findLast((row) => rows.some((x) => x.date === dateOnly(row.openTime)));
  const endingUsd = endingBtc * (lastExecution?.close || 0);
  return {
    mode,
    startDate: rows[0]?.date || null,
    endDate: rows.at(-1)?.date || null,
    startingBtc: 1,
    endingBtc,
    btcGainPct: (endingBtc - 1) * 100,
    endingUsd,
    btcMaxDrawdown: maxDrawdown(btcNav),
    usdMaxDrawdown: maxDrawdown(usdNav),
    averageExposure: exposureSeries.length ? exposureSeries.reduce((a, b) => a + b, 0) / exposureSeries.length : null,
    maxExposure: exposureSeries.length ? Math.max(...exposureSeries) : null,
    totalFeesBtc,
    totalSlippageBtc,
    totalFundingBtc,
    overrideEntries: entries,
    overrideExits: exits,
    overrideDays,
    bearLockOverrideDays,
    daysAt2x,
    minMaintenanceHeadroom,
    liquidated,
    observations: rows.length,
  };
}

async function main() {
  const [market, ahrByDate] = await Promise.all([loadMarketData(), loadAhr()]);
  const modes = ['v3', 'override_2x', 'hard_veto', 'soft_1x_then_2x'];
  const scenarios = modes.map((mode) => runScenario({ mode, market, ahrByDate }));
  const result = {
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    productionChanged: false,
    strategyVersion: CONFIG.version,
    researchVersion: 'btc-v3-ahr-fusion-canonical-v1',
    dataSource: market.dataSource,
    dataWindow: {
      startDate: dateOnly(market.actualStartTime),
      endDate: dateOnly(market.actualEndTime),
    },
    assumptions: {
      signalTiming: 'T-1 fully closed BTCUSD index daily signal -> T BTCUSD_PERP open rebalance',
      ahrTiming: 'Sunday UTC rebalance uses Saturday fully closed AHR999; hysteresis enter <0.40, exit >=0.45',
      feeBps: FEE_BPS,
      slippageBps: SLIPPAGE_BPS,
      maintenanceRate: STRESS_MAINTENANCE_RATE,
      canonicalInstrument: market.contract.symbol,
      contractSizeUsd: market.contract.contractSize,
      funding: 'Official Binance Vision COIN-M fundingRate records where available; missing pre-archive history is not imputed.',
      dca: 'Not included in this canonical fusion run. This isolates leverage/exposure logic; the weekly DCA cash schedule is identical across scenarios.',
    },
    fundingCoverage: fundingCoverage(market, market.actualStartTime, market.actualEndTime),
    scenarios,
  };
  const out = path.join(__dirname, '..', 'research', 'btc-v3-ahr-fusion-canonical-result.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}
