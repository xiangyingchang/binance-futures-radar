'use strict';

// E2: Layer-3 leverage calibration via synthetic stress paths.
// Research-only. Does not modify main, production strategy, or deploy anything.
//
// Question: what is the highest override leverage whose WORST synthetic path
// keeps maintenance headroom >= 3x? Historical episodes never tested
// "enter ACTIVE then market drops another 40-60%" with funding shocks and
// mark-price wicks simultaneously; this grid does.
//
// Mechanics mirror the canonical COIN-M model:
//   - inverse contract PnL in BTC (negative convexity for longs on the way down)
//   - Sunday-only recalibration to target exposure (weekly averaging-down)
//   - daily worst-price (wick) maintenance check, tiered maintenance rates
//   - 3 funding events/day at stressed adverse rate (longs pay)
//
// Acceptance rule (frozen before run):
//   production leverage cap = highest tier with worstCaseMinHeadroom >= 3.0
//   under maintenanceRate 10%, wick 20%, funding 3x P99.

const fs = require('fs');
const path = require('path');

const CONTRACT_SIZE_USD = 100;
const P0 = 60000; // entry price; results are scale-invariant for inverse contracts
const START_EQUITY_BTC = 1;

const LEVERAGES = [1.25, 1.5, 1.75, 2.0];
const DROPS = [0.40, 0.50, 0.60];
const DURATIONS_DAYS = [14, 56, 182]; // crash, fast bear, grinding bear
const WICKS = [0.10, 0.20]; // intraday low below close
const MAINT_RATES = [0.05, 0.10]; // doc baseline 5%, canonical stress 10%
const FUNDING_RATES = [0.0005, 0.003]; // per 8h event: ~P99 baseline, 3x P99 stress
const FUNDING_EVENTS_PER_DAY = 3;

function inversePnlBtc(q, size, p0, p1) {
  return q * size * ((1 / p0) - (1 / p1));
}

function runPath({ leverage, drop, days, wick, maintRate, fundingRate }) {
  // Geometric daily decline from P0 to P0*(1-drop).
  const dailyFactor = Math.pow(1 - drop, 1 / days);
  let equity = START_EQUITY_BTC;
  let price = P0;
  let contracts = 0;
  let minHeadroom = Infinity;
  let minHeadroomDay = null;
  let liquidated = false;
  let liquidationDay = null;
  let totalFundingBtc = 0;

  for (let day = 0; day <= days; day += 1) {
    const open = price;

    // Sunday-only recalibration; day 0 is entry Sunday.
    if (day % 7 === 0 && !liquidated) {
      const overlayBtc = (leverage - 1) * equity;
      contracts = Math.round((overlayBtc * open) / CONTRACT_SIZE_USD);
    }

    const close = day === 0 ? open : open * dailyFactor;
    const low = close * (1 - wick);

    // Funding: adverse for longs (positive rate, longs pay), settled at close-ish mark.
    for (let e = 0; e < FUNDING_EVENTS_PER_DAY; e += 1) {
      const pnl = -(contracts * CONTRACT_SIZE_USD / close) * fundingRate;
      equity += pnl;
      totalFundingBtc += pnl;
    }

    // Maintenance check at the wick.
    const equityAtWick = equity + inversePnlBtc(contracts, CONTRACT_SIZE_USD, open, low);
    const maintenanceBtc = Math.abs(contracts) * CONTRACT_SIZE_USD / low * maintRate;
    const headroom = maintenanceBtc > 0 ? equityAtWick / maintenanceBtc : Infinity;
    if (headroom < minHeadroom) {
      minHeadroom = headroom;
      minHeadroomDay = day;
    }
    if (equityAtWick <= 0 || (maintenanceBtc > 0 && equityAtWick <= maintenanceBtc)) {
      liquidated = true;
      liquidationDay = day;
      break;
    }

    // Mark to close.
    equity += inversePnlBtc(contracts, CONTRACT_SIZE_USD, open, close);
    price = close;
    if (equity <= 0) {
      liquidated = true;
      liquidationDay = day;
      break;
    }
  }

  return {
    leverage,
    dropPct: drop * 100,
    days,
    wickPct: wick * 100,
    maintRatePct: maintRate * 100,
    fundingPerEvent: fundingRate,
    endingEquityBtc: equity,
    equityLossPct: (1 - equity / START_EQUITY_BTC) * 100,
    totalFundingBtc,
    minHeadroom,
    minHeadroomDay,
    liquidated,
    liquidationDay,
  };
}

function main() {
  const runs = [];
  for (const leverage of LEVERAGES) {
    for (const drop of DROPS) {
      for (const days of DURATIONS_DAYS) {
        for (const wick of WICKS) {
          for (const maintRate of MAINT_RATES) {
            for (const fundingRate of FUNDING_RATES) {
              runs.push(runPath({ leverage, drop, days, wick, maintRate, fundingRate }));
            }
          }
        }
      }
    }
  }

  // Acceptance grid: the frozen worst-case slice.
  const acceptanceSlice = runs.filter((r) => r.maintRatePct === 10 && r.wickPct === 20 && r.fundingPerEvent === 0.003);
  const byLeverage = LEVERAGES.map((leverage) => {
    const all = runs.filter((r) => r.leverage === leverage);
    const slice = acceptanceSlice.filter((r) => r.leverage === leverage);
    const worstAll = Math.min(...all.map((r) => r.minHeadroom));
    const worstSlice = Math.min(...slice.map((r) => r.minHeadroom));
    return {
      leverage,
      worstMinHeadroomFullGrid: worstAll,
      worstMinHeadroomAcceptanceSlice: worstSlice,
      liquidatedAnywhereFullGrid: all.some((r) => r.liquidated),
      liquidatedInAcceptanceSlice: slice.some((r) => r.liquidated),
      worstEquityLossPct: Math.max(...all.map((r) => r.equityLossPct)),
      passes3xHeadroom: worstSlice >= 3,
    };
  });

  const passing = byLeverage.filter((r) => r.passes3xHeadroom).map((r) => r.leverage);
  const recommendedCap = passing.length ? Math.max(...passing) : null;

  const result = {
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    productionChanged: false,
    researchVersion: 'btc-v3-leverage-stress-v1',
    experiment: 'E2 synthetic stress calibration of layer-3 override leverage',
    model: {
      instrument: 'inverse COIN-M perp, contract size 100 USD',
      entry: 'enter ACTIVE at day 0 (Sunday), recalibrate to target every 7 days only',
      path: 'geometric daily decline to total drop over duration; daily wick below close',
      funding: '3 events/day at stressed adverse rate (longs pay), no relief',
      maintenanceCheck: 'daily at wick price',
      caveats: [
        'No recovery legs modeled; pure monotonic decline is deliberately pessimistic.',
        'Static maintenance rate per run; real Binance tiers are lower at small notional, so 5%/10% dominate real tiers for this position size.',
        'AHR999 would stay <0.40 through these paths, so override remains ACTIVE; no exit modeled.',
      ],
    },
    acceptanceRule: 'cap = highest leverage with worst-case min headroom >= 3.0 in slice {maint 10%, wick 20%, funding 0.003/event}',
    byLeverage,
    recommendedCap,
    runs,
  };

  const out = path.join(__dirname, '..', 'research', 'btc-v3-leverage-stress-result.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ byLeverage, recommendedCap }, null, 2));
}

main();
