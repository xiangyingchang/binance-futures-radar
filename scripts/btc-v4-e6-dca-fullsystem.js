'use strict';

// E6: DCA full-system windows + L2 decision-frequency ablation.
// Research-only.
//
// Part A — Full three-layer system WITH weekly DCA cash flows (fixes the
//   static-holding caveat of btc-v4-annualized-windows.js):
//   L1: Sunday DCA, AHR999 six tiers (1400/1225/700/420/210/140 U) + ammo pool
//       (budget 700U/wk; unused budget accrues; extra spend drawn from pool).
//   L2: bear-lock binary hedge (0.0x) + 25% breaker.
//   L3: override 1.5x, Sunday hysteresis 0.40/0.45, confirm gate dd365<=-20%,
//       182d kill switch.
//   Metric: final BTC stack vs pure-DCA stack with IDENTICAL cash flows.
//
// Part B — L2 decision frequency ablation (evidence for daily vs weekly):
//   'daily'  : bear-lock & breaker state changes applied any day (T-1 signal)
//   'weekly' : ALL decisions applied Sundays only (T-1 signal)
//   L3 enter/exit stays Sunday-only in both (production spec).
//   Compare excess BTC, switches, fees, hedge-entry delay.
//
// Engine: linear daily overlay approximation in BTC terms (same caveats as
// E3/E5: no funding, no inverse convexity, no wicks; solvency settled by E2).

const fs = require('fs');
const path = require('path');

const PRICE_CSV = '/tmp/btc_cm_full.csv';
const AHR_URL = 'https://raw.githubusercontent.com/RuochenLyu/ahr999-dataset/main/datasets/ahr999.csv';
const GENESIS = Date.parse('2009-01-03T00:00:00Z');
const FEE = 10 / 10000;
const OVERRIDE_LEV = 1.5;
const KILL_DAYS = 182;
const BREAKER_MULT = 1.25;
const WEEKLY_BUDGET = 700;
const TIERS = [
  { max: 0.45, usd: 1400 },
  { max: 0.8, usd: 1225 },
  { max: 1.2, usd: 700 },
  { max: 2.0, usd: 420 },
  { max: 3.0, usd: 210 },
  { max: Infinity, usd: 140 },
];

function loadPrices() {
  const csv = fs.readFileSync(PRICE_CSV, 'utf8');
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const ti = header.indexOf('time');
  const pi = header.indexOf('PriceUSD');
  const rows = [];
  for (const line of lines.slice(1)) {
    const p = line.split(',');
    const date = p[ti].slice(0, 10);
    const close = Number(p[pi]);
    if (date && Number.isFinite(close) && close > 0) rows.push({ date, ts: Date.parse(`${date}T00:00:00Z`), close });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

async function loadRefAhr() {
  const res = await fetch(AHR_URL, { headers: { 'User-Agent': 'bfr-e6/1.0' } });
  if (!res.ok) throw new Error(`fetch failed ${res.status}`);
  const csv = await res.text();
  const m = new Map();
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const p = line.split(',');
    if (p[0] && Number.isFinite(Number(p[3]))) m.set(p[0], Number(p[3]));
  }
  return m;
}

function computeIndicators(rows, dcaMode) {
  const n = rows.length;
  const out = { ma200: new Array(n).fill(null), bearLock: new Array(n).fill(null), dd365: new Array(n).fill(null), ahr: new Array(n).fill(null) };
  let sum = 0; let invSum = 0; let logSum = 0;
  for (let i = 0; i < n; i += 1) {
    const c = rows[i].close;
    sum += c; invSum += 1 / c; logSum += Math.log(c);
    if (i >= 200) { const o = rows[i - 200].close; sum -= o; invSum -= 1 / o; logSum -= Math.log(o); }
    if (i >= 199) {
      out.ma200[i] = sum / 200;
      const dca = dcaMode === 'harmonic' ? 200 / invSum : Math.exp(logSum / 200);
      const ageDays = (rows[i].ts - GENESIS) / 86400000;
      const fit = Math.pow(10, 5.84 * Math.log10(ageDays) - 17.01);
      out.ahr[i] = (c / dca) * (c / fit);
    }
    if (out.ma200[i] !== null && out.ma200[i - 30] != null) {
      out.bearLock[i] = c < out.ma200[i] && (out.ma200[i] / out.ma200[i - 30] - 1) < 0;
    }
    if (i >= 364) {
      let peak = 0;
      for (let j = i - 364; j <= i; j += 1) peak = Math.max(peak, rows[j].close);
      out.dd365[i] = c / peak - 1;
    }
  }
  return out;
}

function validate(rows, ind, ref) {
  const errs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = ref.get(rows[i].date);
    if (r && ind.ahr[i] !== null) errs.push(Math.abs(ind.ahr[i] / r - 1));
  }
  errs.sort((a, b) => a - b);
  return { n: errs.length, medianAbsRelErr: errs[Math.floor(errs.length / 2)] || null };
}

function tierUsd(ahr) {
  for (const t of TIERS) if (ahr < t.max) return t.usd;
  return TIERS[TIERS.length - 1].usd;
}

// Full system sim with DCA cash flows.
// l2Freq: 'daily' | 'weekly' | 'none' (none = pure DCA baseline, no overlay at all)
// useL3: boolean
function simulateDca(rows, ind, startIdx, endIdx, l2Freq, useL3) {
  let stack = 0;            // BTC accumulated
  let ammo = 0;             // USD ammo pool
  let invested = 0;         // total USD spent on spot
  let exposure = 1;
  let overrideActive = false; let overrideEntryIdx = null;
  let breakerTripped = false; let hedgeEntryClose = null;
  let switches = 0; let feeBtcPaid = 0; let hedgeDays = 0; let overrideDays = 0;
  const hedgeEntryDelays = [];
  let pendingBearSince = null; // first day (index) bear-lock signal was true while unhedged
  let ratioPeak = 0; let ratioMdd = 0; // vs own path peak in BTC terms (overlay ratio)
  let overlayRatio = 1;

  for (let i = startIdx; i <= endIdx; i += 1) {
    const d = i - 1;
    const isSunday = new Date(rows[i].ts).getUTCDay() === 0;
    const bl = ind.bearLock[d] === true;

    // --- L3 state (Sunday-only, both variants) ---
    if (useL3 && isSunday) {
      const ahr = ind.ahr[d];
      if (!overrideActive && ahr !== null && ahr < 0.40) {
        if (ind.dd365[d] !== null && ind.dd365[d] <= -0.20) { overrideActive = true; overrideEntryIdx = i; }
      } else if (overrideActive && ahr !== null && ahr >= 0.45) { overrideActive = false; overrideEntryIdx = null; }
    }
    if (!bl) breakerTripped = false;

    // --- target exposure ---
    let target = exposure;
    const decideL2 = l2Freq === 'daily' || (l2Freq === 'weekly' && isSunday);
    if (l2Freq === 'none') {
      target = 1.0;
    } else if (useL3 && overrideActive) {
      target = (overrideEntryIdx !== null && (i - overrideEntryIdx) > KILL_DAYS) ? 1.0 : OVERRIDE_LEV;
    } else if (decideL2) {
      if (bl) {
        if (exposure === 0 && hedgeEntryClose !== null && rows[d].close >= hedgeEntryClose * BREAKER_MULT) breakerTripped = true;
        target = breakerTripped ? 1.0 : 0.0;
      } else target = 1.0;
    }
    // breaker check must also run daily while hedged in daily mode (weekly: Sunday only, covered above)

    // hedge-entry delay accounting
    if (bl && exposure !== 0 && pendingBearSince === null && !overrideActive && !breakerTripped && l2Freq !== 'none') pendingBearSince = i;
    if (target === 0 && exposure !== 0 && pendingBearSince !== null) { hedgeEntryDelays.push(i - pendingBearSince); pendingBearSince = null; }
    if (!bl) pendingBearSince = null;

    if (target !== exposure) {
      const feeMult = 1 - Math.abs(target - exposure) * FEE;
      stack *= feeMult; overlayRatio *= feeMult;
      feeBtcPaid += Math.abs(target - exposure) * FEE;
      switches += 1;
      if (target === 0) hedgeEntryClose = rows[d].close;
    }

    const r = rows[i].close / rows[i - 1].close - 1;
    exposure = target;
    const mult = (1 + exposure * r) / (1 + r);
    stack *= mult; overlayRatio *= mult;
    if (exposure === 0) hedgeDays += 1;
    if (useL3 && overrideActive) overrideDays += 1;

    ratioPeak = Math.max(ratioPeak, overlayRatio);
    ratioMdd = Math.min(ratioMdd, overlayRatio / ratioPeak - 1);

    // --- L1 DCA buy (Sundays) — identical across variants ---
    if (isSunday && ind.ahr[d] !== null) {
      let spend = tierUsd(ind.ahr[d]);
      if (spend > WEEKLY_BUDGET) {
        const extra = Math.min(spend - WEEKLY_BUDGET, ammo);
        spend = WEEKLY_BUDGET + extra;
        ammo -= extra;
      } else if (spend < WEEKLY_BUDGET) {
        ammo += WEEKLY_BUDGET - spend;
      }
      stack += (spend / rows[i].close) * (1 - FEE);
      invested += spend;
    }
  }
  return { stack, invested, ammo, switches, feeBtcPaidPct: feeBtcPaid * 100, hedgeDays, overrideDays, avgHedgeEntryDelay: hedgeEntryDelays.length ? hedgeEntryDelays.reduce((a, b) => a + b, 0) / hedgeEntryDelays.length : null, hedgeEntries: hedgeEntryDelays.length, overlayRatioMdd: ratioMdd * 100 };
}

function idxAtOrAfter(rows, ts) {
  let lo = 0; let hi = rows.length - 1; let ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].ts >= ts) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
  return ans;
}

async function main() {
  const rows = loadPrices();
  const ref = await loadRefAhr();
  let ind = null; let picked = null; let val = null;
  for (const mode of ['harmonic', 'geometric']) {
    const cand = computeIndicators(rows, mode);
    const v = validate(rows, cand, ref);
    if (!val || v.medianAbsRelErr < val.medianAbsRelErr) { ind = cand; val = v; picked = mode; }
  }
  if (val.medianAbsRelErr === null || val.medianAbsRelErr > 0.05) throw new Error(`AHR replication failed: ${JSON.stringify(val)}`);

  const simStart = 400;
  const endIdx = rows.length - 1;
  const endTs = rows[endIdx].ts;

  // ---- Part A: DCA full-system windows ----
  const windows = [1, 3, 5, 10, 99];
  const partA = [];
  for (const y of windows) {
    const ts = y === 99 ? rows[simStart].ts : endTs - y * 365.25 * 86400000;
    const i0 = Math.max(idxAtOrAfter(rows, ts), simStart);
    if (i0 >= endIdx) { partA.push({ years: y, available: false }); continue; }
    const base = simulateDca(rows, ind, i0, endIdx, 'none', false);
    const sys = simulateDca(rows, ind, i0, endIdx, 'daily', true);
    partA.push({
      window: y === 99 ? 'full' : `${y}y`,
      from: rows[i0].date, to: rows[endIdx].date,
      investedUsd: Math.round(base.invested),
      pureDcaBtc: base.stack, systemBtc: sys.stack,
      excessBtcPct: (sys.stack / base.stack - 1) * 100,
      pureDcaUsd: Math.round(base.stack * rows[endIdx].close),
      systemUsd: Math.round(sys.stack * rows[endIdx].close),
      switches: sys.switches, hedgeDays: sys.hedgeDays, overrideDays: sys.overrideDays,
      overlayRatioMddPct: sys.overlayRatioMdd,
    });
  }

  // ---- Part B: L2 frequency ablation (full window, with & without L3) ----
  const partB = [];
  for (const useL3 of [true, false]) {
    for (const freq of ['daily', 'weekly']) {
      const base = simulateDca(rows, ind, simStart, endIdx, 'none', false);
      const sys = simulateDca(rows, ind, simStart, endIdx, freq, useL3);
      partB.push({
        variant: `L2_${freq}${useL3 ? '+L3' : '_only'}`,
        excessBtcPct: (sys.stack / base.stack - 1) * 100,
        systemBtc: sys.stack, switches: sys.switches,
        feePaidPctOfStack: sys.feeBtcPaidPct,
        hedgeDays: sys.hedgeDays, hedgeEntries: sys.hedgeEntries,
        avgHedgeEntryDelayDays: sys.avgHedgeEntryDelay,
        overlayRatioMddPct: sys.overlayRatioMdd,
      });
    }
  }
  // windowed comparison daily vs weekly (full system) for stability check
  const partB2 = [];
  for (const y of [3, 5, 10]) {
    const i0 = Math.max(idxAtOrAfter(rows, endTs - y * 365.25 * 86400000), simStart);
    const base = simulateDca(rows, ind, i0, endIdx, 'none', false);
    const dly = simulateDca(rows, ind, i0, endIdx, 'daily', true);
    const wky = simulateDca(rows, ind, i0, endIdx, 'weekly', true);
    partB2.push({ window: `${y}y`, dailyExcessPct: (dly.stack / base.stack - 1) * 100, weeklyExcessPct: (wky.stack / base.stack - 1) * 100, dailySwitches: dly.switches, weeklySwitches: wky.switches });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    researchVersion: 'btc-v4-e6-dca-fullsystem-v1',
    engine: 'linear daily overlay in BTC terms; no funding/convexity/wicks (solvency settled by E2)',
    ahrValidation: { dcaMode: picked, ...val },
    priceWindow: { start: rows[0].date, end: rows[endIdx].date, n: rows.length },
    simStart: rows[simStart].date,
    dcaSpec: { weeklyBudgetUsd: WEEKLY_BUDGET, tiers: TIERS.map(t => ({ below: t.max, usd: t.usd })), ammoPool: true, buyDay: 'Sunday', feeBps: 10 },
    partA_dcaFullSystemWindows: partA,
    partB_l2FrequencyAblation: partB,
    partB2_freqByWindow: partB2,
  };
  const file = path.join(__dirname, '..', 'research', 'btc-v4-e6-dca-fullsystem.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
