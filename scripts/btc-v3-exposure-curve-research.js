'use strict';

const { CONFIG, computeSignal, inversePnlBtc, targetContracts } = require('../lib/btc-v3-strategy');
const { fetchJson, parseKlines, fetchContractMetadata } = require('../lib/binance-coinm');
const fs = require('fs');
const path = require('path');

const DAY = 86400000;
const WINDOW = 199 * DAY;
const FEE_BPS = 5;
const SLIPPAGE_BPS = 5;

async function fetchWindowed(pathname, baseParams, startTime, endTime) {
  const all = [];
  for (let start = startTime; start <= endTime; start += WINDOW + 1) {
    const end = Math.min(endTime, start + WINDOW);
    const rows = await fetchJson(pathname, { ...baseParams, startTime: start, endTime: end, limit: 1500 }, 20000);
    if (Array.isArray(rows)) all.push(...rows);
  }
  const seen = new Set();
  return all.filter((row) => {
    const key = Number(row[0]);
    if (!Number.isFinite(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(a[0]) - Number(b[0]));
}

function maxDrawdown(values) {
  let peak = -Infinity;
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, value / peak - 1);
  }
  return worst;
}

function annualizedReturn(start, end, days) {
  if (!(start > 0) || !(end > 0) || days <= 0) return null;
  return Math.pow(end / start, 365 / days) - 1;
}

function scenarioDefinitions() {
  return [
    { name: 'baseline_immediate', type: 'baseline' },
    { name: 'ladder_80_20', type: 'ladder', immediateFraction: 0.80, levels: [-0.03, -0.06, -0.10, -0.15] },
    { name: 'ladder_60_40', type: 'ladder', immediateFraction: 0.60, levels: [-0.03, -0.06, -0.10, -0.15] },
    { name: 'curve_mild', type: 'curve', levels: [
      { drop: -0.05, bonus: 0.05 }, { drop: -0.10, bonus: 0.10 }, { drop: -0.15, bonus: 0.20 },
    ] },
    { name: 'curve_aggressive', type: 'curve', levels: [
      { drop: -0.05, bonus: 0.10 }, { drop: -0.10, bonus: 0.25 }, { drop: -0.15, bonus: 0.40 },
    ] },
  ];
}

function tradeToContracts(state, newContracts, refPrice, fillPrice, taker) {
  const delta = newContracts - state.contracts;
  if (delta === 0) return;
  const fee = Math.abs(delta) * state.contractSize / fillPrice * (FEE_BPS / 10000);
  state.equityBtc -= fee;
  state.totalFeesBtc += fee;
  if (taker) {
    const slippedFill = fillPrice * (delta > 0 ? (1 + SLIPPAGE_BPS / 10000) : (1 - SLIPPAGE_BPS / 10000));
    const slipPnl = inversePnlBtc(delta, state.contractSize, slippedFill, refPrice);
    state.equityBtc += slipPnl;
    state.totalSlippageBtc += slipPnl;
  }
  state.turnoverUsd += Math.abs(delta) * state.contractSize;
  state.contracts = newContracts;
  state.tradeCount += 1;
}

function contractsForExposure(state, exposure, price) {
  return targetContracts({
    targetExposure: exposure,
    equityBtc: state.equityBtc,
    price,
    contractSizeUsd: state.contractSize,
    currentContracts: state.contracts,
  }).signedContracts;
}

function runScenario(def, indexDaily, executionDaily, contract) {
  const executionByOpen = new Map(executionDaily.map((r) => [r.openTime, r]));
  const state = {
    equityBtc: 1,
    contracts: 0,
    contractSize: contract.contractSize,
    totalFeesBtc: 0,
    totalSlippageBtc: 0,
    turnoverUsd: 0,
    tradeCount: 0,
    missedRallyDays: 0,
    ladderFillCount: 0,
    ladderOrderCount: 0,
  };
  const closes = [];
  const btcNav = [];
  const usdNav = [];
  const exposures = [];
  let lastClose = null;
  let firstDate = null;
  let lastDate = null;

  for (const idx of indexDaily) {
    const ex = executionByOpen.get(idx.openTime);
    if (!ex) continue;
    const date = new Date(idx.openTime).toISOString().slice(0, 10);
    if (!firstDate) firstDate = date;
    lastDate = date;

    if (lastClose !== null) {
      state.equityBtc += inversePnlBtc(state.contracts, state.contractSize, lastClose, ex.open);
    }

    const signal = closes.length >= CONFIG.valuationLookbackDays ? computeSignal(closes) : null;
    const targetExposure = signal?.ready ? signal.finalTarget : 1;
    const currentExposureAtOpen = 1 + (state.contracts * state.contractSize / ex.open) / state.equityBtc;

    // Risk reductions are always immediate. This preserves the V3 risk-off semantics.
    const targetAtOpenContracts = contractsForExposure(state, targetExposure, ex.open);
    if (targetAtOpenContracts < state.contracts) {
      tradeToContracts(state, targetAtOpenContracts, ex.open, ex.open, true);
    } else if (targetAtOpenContracts > state.contracts) {
      if (def.type === 'baseline' || def.type === 'curve') {
        tradeToContracts(state, targetAtOpenContracts, ex.open, ex.open, true);
      } else {
        const gap = targetAtOpenContracts - state.contracts;
        const immediate = Math.round(gap * def.immediateFraction);
        tradeToContracts(state, state.contracts + immediate, ex.open, ex.open, true);

        let remaining = targetAtOpenContracts - state.contracts;
        const weights = def.levels.map(() => 1 / def.levels.length);
        let allocated = 0;
        for (let j = 0; j < def.levels.length; j += 1) {
          const qty = j === def.levels.length - 1 ? remaining - allocated : Math.round(remaining * weights[j]);
          allocated += qty;
          if (qty <= 0) continue;
          state.ladderOrderCount += 1;
          const limit = ex.open * (1 + def.levels[j]);
          if (ex.low <= limit) {
            state.equityBtc += inversePnlBtc(state.contracts, state.contractSize, j === 0 ? ex.open : ex.open * (1 + def.levels[j - 1]), limit);
            tradeToContracts(state, state.contracts + qty, limit, limit, false);
            state.ladderFillCount += 1;
          }
        }
        if (state.contracts < targetAtOpenContracts && ex.close > ex.open) state.missedRallyDays += 1;
      }
    }

    // Paul-like research overlay: fully hold the V3 target, then add inventory only on predefined downside levels.
    if (def.type === 'curve') {
      let prevPx = ex.open;
      for (const level of def.levels) {
        const limit = ex.open * (1 + level.drop);
        state.ladderOrderCount += 1;
        if (ex.low <= limit) {
          state.equityBtc += inversePnlBtc(state.contracts, state.contractSize, prevPx, limit);
          const bonusTarget = Math.min(CONFIG.publicMarginCap, targetExposure + level.bonus);
          const desired = contractsForExposure(state, bonusTarget, limit);
          if (desired > state.contracts) {
            tradeToContracts(state, desired, limit, limit, false);
            state.ladderFillCount += 1;
          }
          prevPx = limit;
        }
      }
      state.equityBtc += inversePnlBtc(state.contracts, state.contractSize, prevPx, ex.close);
    } else {
      // Conservative approximation for ladder fills: if fills happened, use daily low as the post-fill mark before close.
      // For baseline, this reduces exactly to open -> close PnL.
      state.equityBtc += inversePnlBtc(state.contracts, state.contractSize, ex.open, ex.close);
    }

    lastClose = ex.close;
    closes.push(idx.close);
    const navUsd = state.equityBtc * ex.close;
    btcNav.push(state.equityBtc);
    usdNav.push(navUsd);
    exposures.push(1 + (state.contracts * state.contractSize / ex.close) / state.equityBtc);
  }

  const days = Math.max(1, Math.round((new Date(lastDate) - new Date(firstDate)) / DAY));
  const endingBtc = btcNav.at(-1);
  const endingUsd = usdNav.at(-1);
  const startUsd = executionDaily.find((r) => new Date(r.openTime).toISOString().slice(0, 10) === firstDate)?.open || 1;
  return {
    name: def.name,
    startDate: firstDate,
    endDate: lastDate,
    endingBtc,
    btcGainPct: (endingBtc - 1) * 100,
    endingUsd,
    usdGainPct: (endingUsd / startUsd - 1) * 100,
    btcMaxDrawdown: maxDrawdown(btcNav),
    usdMaxDrawdown: maxDrawdown(usdNav),
    btcCagr: annualizedReturn(1, endingBtc, days),
    usdCagr: annualizedReturn(startUsd, endingUsd, days),
    totalFeesBtc: state.totalFeesBtc,
    totalSlippageBtc: state.totalSlippageBtc,
    turnoverUsd: state.turnoverUsd,
    tradeCount: state.tradeCount,
    avgExposure: exposures.reduce((a, b) => a + b, 0) / exposures.length,
    maxExposure: Math.max(...exposures),
    missedRallyDays: state.missedRallyDays,
    ladderFillRate: state.ladderOrderCount ? state.ladderFillCount / state.ladderOrderCount : null,
  };
}

async function main() {
  const contract = await fetchContractMetadata(CONFIG.coinMSymbol);
  const startTime = contract.onboardDate;
  const endTime = Date.now() - DAY;
  const [indexRaw, executionRaw] = await Promise.all([
    fetchWindowed('/dapi/v1/indexPriceKlines', { pair: CONFIG.coinMPair, interval: '1d' }, startTime, endTime),
    fetchWindowed('/dapi/v1/continuousKlines', { pair: CONFIG.coinMPair, contractType: 'PERPETUAL', interval: '1d' }, startTime, endTime),
  ]);
  const indexDaily = parseKlines(indexRaw);
  const executionDaily = parseKlines(executionRaw);
  const scenarios = scenarioDefinitions().map((def) => runScenario(def, indexDaily, executionDaily, contract));
  const baseline = scenarios.find((s) => s.name === 'baseline_immediate');
  for (const s of scenarios) {
    s.deltaVsBaseline = {
      endingBtc: s.endingBtc - baseline.endingBtc,
      btcGainPctPoints: s.btcGainPct - baseline.btcGainPct,
      usdGainPctPoints: s.usdGainPct - baseline.usdGainPct,
      btcMaxDrawdownPoints: (s.btcMaxDrawdown - baseline.btcMaxDrawdown) * 100,
      usdMaxDrawdownPoints: (s.usdMaxDrawdown - baseline.usdMaxDrawdown) * 100,
      turnoverPct: baseline.turnoverUsd ? (s.turnoverUsd / baseline.turnoverUsd - 1) * 100 : null,
    };
  }
  const result = {
    generatedAt: new Date().toISOString(),
    strategyVersion: CONFIG.version,
    researchOnly: true,
    productionChanged: false,
    assumptions: {
      signalTiming: 'T-1 closed daily index data -> T open decision',
      ladderOrders: 'cancel-and-replace daily; buy limits below T open; fill if daily low touches level',
      riskReduction: 'always immediate at T open',
      feesBps: FEE_BPS,
      takerSlippageBps: SLIPPAGE_BPS,
      funding: 'omitted in this comparative execution study',
      intradayPath: 'daily OHLC approximation; suitable for relative screening, not final production validation',
    },
    scenarios,
  };
  const out = path.join(__dirname, '..', 'research', 'btc-v3-exposure-curve-result.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
