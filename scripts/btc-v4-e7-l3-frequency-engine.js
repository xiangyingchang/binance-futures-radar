// E7: BTC V4 L3 override entry/calibration frequency ablation
// Preregistered criteria: research/btc-v4-e7-preregistration.md (commit 1e79435)
// Engine: derived from btc-v4-e6-dca-fullsystem.js — same data, same cashflow,
// only L3 decision frequency varies.
//   V-A: L3 enter Sunday / exit+kill Sunday   (production)
//   V-B: L3 enter daily  / exit+kill Sunday
//   V-C: L3 enter daily  / exit+kill daily
// Shared: confirm gate dd365<=-0.20, 1.5x cap, 0.45 hysteresis exit, 182d kill,
// hand-back flip-short, L2 daily bearLock + 1.25 breaker, T-1 signals,
// L1 Sunday DCA six tiers + ammo pool (identical across variants).
'use strict';
const fs = require('fs');

const PRICE_CSV = '/tmp/btc_cm_full.csv';
const AHR_URL = 'https://raw.githubusercontent.com/RuochenLyu/ahr999-dataset/main/datasets/ahr999.csv';
const GENESIS = Date.parse('2009-01-03T00:00:00Z');
const FEE = 10 / 10000;
const OVERRIDE_LEV = 1.5;
const KILL_DAYS = 182;
const BREAKER_MULT = 1.25;
const WEEKLY_BUDGET = 700;
const TIERS = [
  { max: 0.45, usd: 1400 }, { max: 0.75, usd: 1225 }, { max: 1.0, usd: 700 },
  { max: 1.2, usd: 420 }, { max: 5.0, usd: 210 }, { max: Infinity, usd: 140 },
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
  const res = await fetch(AHR_URL, { headers: { 'User-Agent': 'bfr-e7/1.0' } });
  if (!res.ok) throw new Error(`fetch failed ${res.status}`);
  const csv = await res.text();
  const m = new Map();
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const p = line.split(',');
    if (p[0] && Number.isFinite(Number(p[3]))) m.set(p[0], Number(p[3]));
  }
  return m;
}

function computeIndicators(rows) {
  const n = rows.length;
  const ma200 = new Array(n).fill(null);
  const slope = new Array(n).fill(null);
  const bearLock = new Array(n).fill(null);
  const ahr = new Array(n).fill(null);
  const dd365 = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += rows[i].close;
    if (i >= 200) sum -= rows[i - 200].close;
    if (i >= 199) ma200[i] = sum / 200;
    if (i >= 229 && ma200[i - 30] !== null) slope[i] = ma200[i] / ma200[i - 30] - 1;
    if (ma200[i] !== null && slope[i] !== null) bearLock[i] = rows[i].close < ma200[i] && slope[i] < 0;
    if (i >= 199) {
      let g = 1;
      for (let k = i - 199; k <= i; k += 1) g += 0; // placeholder keeps loop shape identical to E6
      // geometric mean of last 200 closes
      let logSum = 0;
      for (let k = i - 199; k <= i; k += 1) logSum += Math.log(rows[k].close);
      const gma = Math.exp(logSum / 200);
      const ageDays = (rows[i].ts - GENESIS) / 86400000;
      const fit = Math.pow(10, 5.84 * Math.log10(ageDays) - 17.01);
      ahr[i] = (rows[i].close / gma) * (rows[i].close / fit);
    }
    if (i >= 365) {
      let peak = 0;
      for (let k = i - 365; k <= i; k += 1) peak = Math.max(peak, rows[k].close);
      dd365[i] = rows[i].close / peak - 1;
    }
  }
  return { ma200, slope, bearLock, ahr, dd365 };
}

function validate(ind, rows, ref) {
  const errs = [];
  let cnt = 0;
  for (let i = rows.length - 1; i >= 0 && cnt < 400; i -= 1) {
    const r = ref.get(rows[i].date);
    if (r !== undefined && ind.ahr[i] !== null) { errs.push(Math.abs(ind.ahr[i] - r) / r); cnt += 1; }
  }
  errs.sort((a, b) => a - b);
  return errs.length ? errs[Math.floor(errs.length / 2)] : null;
}

function tierUsd(a) { for (const t of TIERS) if (a < t.max) return t.usd; return 140; }

// l3Mode: 'weekly' (V-A) | 'enterDaily' (V-B) | 'fullDaily' (V-C)
//          | 'vd1' | 'vd2' | 'off'
// options.capturePath is telemetry only; it does not change state-machine
// calculations and is used by E8 to measure opportunity/protection overlap.
function simulate(rows, ind, startIdx, endIdx, l3Mode, options = {}) {
  const capturePath = options.capturePath === true;
  let stack = 0, ammo = 0, invested = 0, exposure = 1;
  let overrideActive = false, overrideEntryIdx = null;
  let breakerTripped = false, hedgeEntryClose = null;
  let switches = 0, feeBtcPaid = 0, hedgeDays = 0, overrideDays = 0;
  let ratioPeak = 0, ratioMdd = 0, overlayRatio = 1;
  const episodes = []; // {entryIdx, exitIdx, entryPrice, minPrice, minIdx, killed}
  const exposurePath = capturePath ? new Array(endIdx + 1).fill(null) : null;
  let cur = null;

  for (let i = startIdx; i <= endIdx; i += 1) {
    const d = i - 1;
    const isSunday = new Date(rows[i].ts).getUTCDay() === 0;
    const bl = ind.bearLock[d] === true;
    const ahr = ind.ahr[d];
    const useL3 = l3Mode !== 'off';

    // --- L3 state machine ---
    if (useL3) {
      // Existing modes retain their exact branches. E8 adds only the two
      // Bear-Lock-aware entry predicates below; exits remain Sunday-only.
      const canEnter = l3Mode === 'weekly'
        ? isSunday
        : l3Mode === 'vd1'
          ? (!bl || isSunday)
          : l3Mode === 'vd2'
            ? !bl
            : true;
      const canExit = l3Mode === 'fullDaily' ? true : isSunday;
      if (!overrideActive && canEnter && ahr !== null && ahr < 0.40
          && ind.dd365[d] !== null && ind.dd365[d] <= -0.20) {
        overrideActive = true; overrideEntryIdx = i;
        cur = { entryIdx: i, entryDate: rows[i].date, entryPrice: rows[i].close, minPrice: rows[i].close, minDate: rows[i].date, killed: false, entrySunday: isSunday };
      } else if (overrideActive && canExit && ahr !== null && ahr >= 0.45) {
        overrideActive = false; overrideEntryIdx = null;
        if (cur) { cur.exitIdx = i; cur.exitDate = rows[i].date; episodes.push(cur); cur = null; }
      }
    }
    if (!bl) breakerTripped = false;

    // --- target exposure (priority: kill > override > L2 daily > default) ---
    let target = exposure;
    const killCheck = l3Mode === 'fullDaily' ? true : isSunday;
    if (useL3 && overrideActive) {
      const killed = overrideEntryIdx !== null && (i - overrideEntryIdx) > KILL_DAYS && killCheck;
      if (killed && cur) cur.killed = true;
      target = killed ? 1.0 : OVERRIDE_LEV;
    } else {
      // L2 daily bearLock (E6 final): decide every day
      if (bl) {
        if (exposure === 0 && hedgeEntryClose !== null && rows[d].close >= hedgeEntryClose * BREAKER_MULT) breakerTripped = true;
        target = breakerTripped ? 1.0 : 0.0;
      } else target = 1.0;
    }

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
    if (useL3 && overrideActive) {
      overrideDays += 1;
      if (cur && rows[i].close < cur.minPrice) { cur.minPrice = rows[i].close; cur.minDate = rows[i].date; }
    }

    ratioPeak = Math.max(ratioPeak, overlayRatio);
    ratioMdd = Math.min(ratioMdd, overlayRatio / ratioPeak - 1);

    // --- L1 DCA (identical) ---
    if (isSunday && ahr !== null) {
      let spend = tierUsd(ahr);
      if (spend > WEEKLY_BUDGET) { const extra = Math.min(spend - WEEKLY_BUDGET, ammo); spend = WEEKLY_BUDGET + extra; ammo -= extra; }
      else if (spend < WEEKLY_BUDGET) ammo += WEEKLY_BUDGET - spend;
      stack += (spend / rows[i].close) * (1 - FEE);
      invested += spend;
    }
    if (exposurePath) exposurePath[i] = {
      date: rows[i].date,
      signalDate: rows[d].date,
      target,
      exposure,
      bearLock: bl,
      overrideActive,
      ahr,
      dd365: ind.dd365[d],
    };
  }
  if (cur) { cur.exitIdx = endIdx; cur.exitDate = rows[endIdx].date; cur.openAtEnd = true; episodes.push(cur); }
  return { stack, invested, ammo, switches, feeBtcPaidPct: feeBtcPaid * 100, hedgeDays, overrideDays, overlayRatioMdd: ratioMdd * 100, episodes, exposurePath };
}

function idxAtOrAfter(rows, ts) { for (let i = 0; i < rows.length; i += 1) if (rows[i].ts >= ts) return i; return -1; }

module.exports = { loadPrices, loadRefAhr, computeIndicators, validate, simulate, idxAtOrAfter, FEE, OVERRIDE_LEV, KILL_DAYS };
