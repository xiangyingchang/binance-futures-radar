'use strict';

// E1: Layer-2 (trend layer) ablation study + Layer-3 override cross.
// Research-only. Does not modify main, production strategy, or deploy anything.
//
// Question: is the 0/1/2/3 trend ladder noise, with Bear Lock carrying all the value?
// Layer-2 variants:
//   full_trend    - current V3.1 finalTarget (ladder + valuation + vol cap + bear lock)
//   bearlock_only - binary: bearLock ? 0.0 : 1.0
//   ladder_only   - same as full_trend but WITHOUT bear lock zeroing
//   constant_1x   - always 1.0 (no layer-2; overlay only from layer-3)
// Layer-3 override modes (AHR999 hysteresis <0.40 enter, >=0.45 exit, Sunday only):
//   none, override_1_5x, override_2x, ramp (ahr<0.35 -> 2.0x else 1.5x)
//
// Acceptance rule (frozen before run):
//   If bearlock_only is not worse than full_trend on BOTH OOS ending BTC and
//   OOS BTC max drawdown (tolerance 1% relative), layer-2 collapses to the
//   binary bear-lock switch.
// IS = data start .. 2023-12-31, OOS = 2024-01-01 .. data end.

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
  clamp,
} = require('../lib/btc-v3-strategy');

const FEE_BPS = Number(process.env.BTC_V3_FEE_BPS || 5);
const SLIPPAGE_BPS = Number(process.env.BTC_V3_SLIPPAGE_BPS || 5);
const STRESS_MAINTENANCE_RATE = Number(process.env.BTC_V3_MAINT_RATE || 0.10);
const OOS_START = Date.UTC(2024, 0, 1);
const AHR_URL = 'https://raw.githubusercontent.com/RuochenLyu/ahr999-dataset/main/datasets/ahr999.csv';

function aggregateDaily(candles) {
  const grouped = new Map();
  for (const bar of candles) {
    const openTime = Math.floor(bar.openTime / DAY) * DAY;
    if (!grouped.has(openTime)) {
      grouped.set(openTime, { openTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, closeTime: bar.closeTime });
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
  const res = await fetch(AHR_URL, { headers: { 'User-Agent': 'bfr-layer2-ablation/1.0' } });
  if (!res.ok) throw new Error(`AHR dataset fetch failed: HTTP ${res.status}`);
  const csv = await res.text();
  const rows = csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const p = line.split(',');
    return { date: p[0], ahr999: Number(p[3]) };
  }).filter((row) => row.date && Number.isFinite(row.ahr999));
  return new Map(rows.map((row) => [row.date, row]));
}

function nearestClosedMark(markBars, timestamp) {
  let lo = 0; let hi = markBars.length - 1; let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (markBars[mid].closeTime <= timestamp) { best = markBars[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best ? best.close : null;
}

// Layer-2 variant target. Reuses fields from computeSignal so all inputs stay
// identical to production signal math; only the combination rule changes.
function layer2Target(variant, s) {
  if (!s?.ready) return 1;
  if (variant === 'full_trend') return s.finalTarget;
  if (variant === 'bearlock_only') return s.bearLock ? 0 : 1;
  if (variant === 'constant_1x') return 1;
  if (variant === 'ladder_only') {
    // Rebuild valuationAdjustedTarget without the bearLock zeroing.
    let vAdj = s.regimeTarget;
    if (s.trendScore === 2 && s.cheap) vAdj = Math.max(vAdj, 1.25);
    if (s.trendScore === 3 && s.cheap) vAdj = Math.max(vAdj, 1.50);
    if (s.trendScore === 3 && s.veryCheap) vAdj = Math.max(vAdj, 2.00);
    const raw = Math.min(vAdj, s.volatilityCap, CONFIG.maxSignalExposure);
    return Math.min(raw, clamp(CONFIG.publicMarginCap, 0, CONFIG.maxSignalExposure));
  }
  throw new Error(`Unknown layer-2 variant ${variant}`);
}

function layer3Target(mode, base, overrideActive, decisionAhr) {
  if (mode === 'none' || !overrideActive) return base;
  if (mode === 'override_1_5x') return 1.5;
  if (mode === 'override_2x') return 2;
  if (mode === 'ramp') return (decisionAhr !== null && decisionAhr < 0.35) ? 2.0 : 1.5;
  throw new Error(`Unknown layer-3 mode ${mode}`);
}

function updateOverride(openTime, ahrByDate, current) {
  if (new Date(openTime).getUTCDay() !== 0) return { active: current, ahr: null, decided: false };
  const row = ahrByDate.get(dateOnly(openTime - DAY));
  if (!row) return { active: current, ahr: null, decided: false };
  let active = current;
  if (row.ahr999 < 0.40) active = true;
  else if (row.ahr999 >= 0.45) active = false;
  return { active, ahr: row.ahr999, decided: true };
}

function segmentStats(rows, navKey) {
  if (!rows.length) return null;
  const nav = rows.map((r) => r[navKey]);
  const first = rows[0][navKey];
  const last = rows.at(-1)[navKey];
  return {
    startDate: rows[0].date,
    endDate: rows.at(-1).date,
    startNav: first,
    endNav: last,
    gainPct: (last / first - 1) * 100,
    maxDrawdown: maxDrawdown(nav),
  };
}

function runScenario({ layer2, layer3, market, ahrByDate }) {
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
  let fundingWhileShortBtc = 0;
  let liquidated = false;
  let minHeadroom = Infinity;
  let overrideActive = false;
  let lastDecisionAhr = null;
  let overrideDays = 0;
  let trades = 0;
  let targetChanges = 0;
  let shortDays = 0;
  let lastTarget = null;
  const closes = [];
  const rows = [];

  for (const indexCandle of market.indexDaily) {
    const execution = executionByOpen.get(indexCandle.openTime);
    if (!execution) continue;

    if (lastPrice !== null) equityBtc += inversePnlBtc(contracts, market.contract.contractSize, lastPrice, execution.open);
    lastPrice = execution.open;

    const midnightFunding = (fundingByDay.get(indexCandle.openTime) || []).filter((r) => r.fundingTime <= indexCandle.openTime);
    for (const item of midnightFunding) {
      const mark = nearestClosedMark(market.markBars, item.fundingTime) || execution.open;
      equityBtc += inversePnlBtc(contracts, market.contract.contractSize, lastPrice, mark);
      lastPrice = mark;
      const pnl = fundingPnlBtc(contracts, market.contract.contractSize, mark, item.fundingRate);
      equityBtc += pnl;
      totalFundingBtc += pnl;
      if (contracts < 0) fundingWhileShortBtc += pnl;
    }
    if (lastPrice !== execution.open) {
      equityBtc += inversePnlBtc(contracts, market.contract.contractSize, lastPrice, execution.open);
      lastPrice = execution.open;
    }

    const signal = closes.length >= CONFIG.valuationLookbackDays ? computeSignal(closes) : null;
    const overrideUpdate = updateOverride(indexCandle.openTime, ahrByDate, overrideActive);
    overrideActive = overrideUpdate.active;
    if (overrideUpdate.decided) lastDecisionAhr = overrideUpdate.ahr;
    if (overrideActive) overrideDays += 1;

    const base = signal?.ready ? layer2Target(layer2, signal) : 1;
    const targetExposure = signal?.ready ? layer3Target(layer3, base, overrideActive, lastDecisionAhr) : 1;
    if (lastTarget !== null && Math.abs(targetExposure - lastTarget) > 1e-9) targetChanges += 1;
    lastTarget = targetExposure;

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
      trades += 1;
      const slip = SLIPPAGE_BPS / 10000;
      const fillPrice = execution.open * (delta > 0 ? (1 + slip) : (1 - slip));
      const slipPnl = inversePnlBtc(delta, market.contract.contractSize, fillPrice, execution.open);
      equityBtc += slipPnl;
      totalSlippageBtc += slipPnl;
      const fee = Math.abs(delta) * market.contract.contractSize / fillPrice * (FEE_BPS / 10000);
      equityBtc -= fee;
      totalFeesBtc += fee;
      contracts = sizing.signedContracts;
      lastPrice = execution.open;
    }
    if (contracts < 0) shortDays += 1;

    const worstPrice = contracts >= 0 ? execution.low : execution.high;
    const stressedEquity = equityBtc + inversePnlBtc(contracts, market.contract.contractSize, execution.open, worstPrice);
    const stress = maintenanceHeadroom({
      equityBtc: stressedEquity,
      signedContracts: contracts,
      contractSizeUsd: market.contract.contractSize,
      markPrice: worstPrice,
      maintenanceRate: STRESS_MAINTENANCE_RATE,
    });
    if (stress && stress.headroomMultiple < minHeadroom) minHeadroom = stress.headroomMultiple;
    if (!stress || !stress.passes || stressedEquity <= 0) {
      liquidated = true;
      break;
    }

    const intradayFunding = (fundingByDay.get(indexCandle.openTime) || []).filter((r) => r.fundingTime > indexCandle.openTime && r.fundingTime <= execution.closeTime);
    for (const item of intradayFunding) {
      const mark = nearestClosedMark(market.markBars, item.fundingTime) || lastPrice;
      equityBtc += inversePnlBtc(contracts, market.contract.contractSize, lastPrice, mark);
      lastPrice = mark;
      const pnl = fundingPnlBtc(contracts, market.contract.contractSize, mark, item.fundingRate);
      equityBtc += pnl;
      totalFundingBtc += pnl;
      if (contracts < 0) fundingWhileShortBtc += pnl;
    }

    equityBtc += inversePnlBtc(contracts, market.contract.contractSize, lastPrice, execution.close);
    lastPrice = execution.close;
    closes.push(indexCandle.close);

    rows.push({
      date: dateOnly(indexCandle.openTime),
      openTime: indexCandle.openTime,
      equityBtc,
      navUsd: equityBtc * execution.close,
      targetExposure,
    });
  }

  const isRows = rows.filter((r) => r.openTime < OOS_START);
  const oosRows = rows.filter((r) => r.openTime >= OOS_START);
  return {
    layer2,
    layer3,
    scenario: `${layer2}__l3_${layer3}`,
    startDate: rows[0]?.date || null,
    endDate: rows.at(-1)?.date || null,
    endingBtc: rows.at(-1)?.equityBtc ?? equityBtc,
    btcGainPct: ((rows.at(-1)?.equityBtc ?? equityBtc) - 1) * 100,
    btcMaxDrawdown: maxDrawdown(rows.map((r) => r.equityBtc)),
    usdMaxDrawdown: maxDrawdown(rows.map((r) => r.navUsd)),
    inSample: segmentStats(isRows, 'equityBtc'),
    outOfSample: segmentStats(oosRows, 'equityBtc'),
    outOfSampleUsdMaxDrawdown: maxDrawdown(oosRows.map((r) => r.navUsd)),
    trades,
    targetChanges,
    shortDays,
    overrideDays,
    totalFeesBtc,
    totalSlippageBtc,
    totalFundingBtc,
    fundingWhileShortBtc,
    minMaintenanceHeadroom: minHeadroom,
    liquidated,
    observations: rows.length,
  };
}

async function main() {
  const [market, ahrByDate] = await Promise.all([loadMarketData(), loadAhr()]);
  const layer2Variants = ['full_trend', 'bearlock_only', 'ladder_only', 'constant_1x'];
  const layer3Modes = ['none', 'override_1_5x', 'override_2x', 'ramp'];
  const scenarios = [];
  for (const layer2 of layer2Variants) {
    for (const layer3 of layer3Modes) {
      scenarios.push(runScenario({ layer2, layer3, market, ahrByDate }));
      console.error(`done: ${layer2} x ${layer3}`);
    }
  }

  const full = scenarios.find((s) => s.scenario === 'full_trend__l3_none');
  const blOnly = scenarios.find((s) => s.scenario === 'bearlock_only__l3_none');
  const tol = 0.01;
  const acceptance = {
    rule: 'bearlock_only accepted if OOS ending BTC >= full_trend*(1-1%) AND OOS BTC maxDD not deeper than full_trend by more than 1pp',
    oosEndingBtc: { full_trend: full.outOfSample?.endNav, bearlock_only: blOnly.outOfSample?.endNav },
    oosBtcMaxDrawdown: { full_trend: full.outOfSample?.maxDrawdown, bearlock_only: blOnly.outOfSample?.maxDrawdown },
    bearlockOnlyAccepted:
      blOnly.outOfSample.endNav >= full.outOfSample.endNav * (1 - tol)
      && blOnly.outOfSample.maxDrawdown >= full.outOfSample.maxDrawdown - 0.01,
  };

  const result = {
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    productionChanged: false,
    strategyVersion: CONFIG.version,
    researchVersion: 'btc-v3-layer2-ablation-v1',
    experiment: 'E1 layer-2 trend ablation x layer-3 override cross',
    dataSource: market.dataSource,
    dataWindow: { startDate: dateOnly(market.actualStartTime), endDate: dateOnly(market.actualEndTime) },
    oosStart: dateOnly(OOS_START),
    assumptions: {
      signalTiming: 'T-1 fully closed BTCUSD index daily signal -> T BTCUSD_PERP open rebalance',
      ahrTiming: 'Sunday UTC rebalance uses Saturday fully closed AHR999; hysteresis enter <0.40, exit >=0.45',
      feeBps: FEE_BPS,
      slippageBps: SLIPPAGE_BPS,
      maintenanceRate: STRESS_MAINTENANCE_RATE,
      contractSizeUsd: market.contract.contractSize,
      funding: 'Official Binance Vision COIN-M fundingRate records where available; gaps not imputed as zero.',
      dca: 'Weekly DCA cash schedule identical across scenarios and excluded; this isolates overlay logic.',
      parametersFrozen: 'All thresholds inherited from frozen btc-v3.1-coinm config; nothing tuned on OOS.',
    },
    acceptance,
    scenarios,
  };
  const out = path.join(__dirname, '..', 'research', 'btc-v3-layer2-ablation-result.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ acceptance, summary: scenarios.map((s) => ({ scenario: s.scenario, endingBtc: Number(s.endingBtc.toFixed(4)), oosGainPct: s.outOfSample ? Number(s.outOfSample.gainPct.toFixed(2)) : null, btcMDD: Number(s.btcMaxDrawdown.toFixed(4)), minHeadroom: Number((s.minMaintenanceHeadroom === Infinity ? -1 : s.minMaintenanceHeadroom).toFixed(2)), liquidated: s.liquidated })) }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}
