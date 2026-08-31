'use strict';

// Trailing-window annualized returns for the FINAL-FORM system (V4 draft):
//   L2 bear-lock binary (0.0x hedge) + 25% breaker
//   L3 override 1.5x + confirm gate (dd365<=-20%) + 182d kill switch
//   Sunday hysteresis 0.40/0.45, T-1 close signals, 10bps fee+slippage.
// Research-only. Long price history from blockchain.info (daily, since 2010),
// AHR999 computed from formula: ahr = (P/dca200) * (P/fit),
//   fit = 10^(5.84*log10(coinAgeDays) - 17.01), age from 2009-01-03.
// dca200 = harmonic or geometric mean of past 200 closes; auto-pick whichever
// matches the RuochenLyu dataset better on the overlap (validation gate:
// median abs relative error must be < 5%, else abort).
// Windows: trailing 1/3/5/10/15/20y ending at last observation.
// Outputs per window: BTC HODL USD CAGR, system USD CAGR, BTC-term excess CAGR.

const fs = require('fs');
const path = require('path');

const PRICE_CSV = '/tmp/btc_coinmetrics.csv'; // Coin Metrics community data, PriceUSD daily since 2010-07
const AHR_URL = 'https://raw.githubusercontent.com/RuochenLyu/ahr999-dataset/main/datasets/ahr999.csv';
const GENESIS = Date.parse('2009-01-03T00:00:00Z');
const FEE = 10 / 10000;
const OVERRIDE_LEV = 1.5;
const KILL_DAYS = 182;
const BREAKER_MULT = 1.25;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'bfr-annualized/1.0' } });
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`);
  return res;
}

async function loadPrices() {
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
  const res = await fetchJson(AHR_URL);
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

function simulate(rows, ind, startIdx) {
  let equity = 1; let exposure = 1;
  let overrideActive = false; let overrideEntryIdx = null;
  let breakerTripped = false; let hedgeEntryClose = null;
  const path = new Array(rows.length).fill(null);
  for (let i = startIdx; i < rows.length; i += 1) {
    const d = i - 1;
    const bl = ind.bearLock[d] === true;
    if (new Date(rows[i].ts).getUTCDay() === 0) {
      const ahr = ind.ahr[d];
      if (!overrideActive && ahr !== null && ahr < 0.40) {
        if (ind.dd365[d] !== null && ind.dd365[d] <= -0.20) { overrideActive = true; overrideEntryIdx = i; }
      } else if (overrideActive && ahr !== null && ahr >= 0.45) { overrideActive = false; overrideEntryIdx = null; }
    }
    if (!bl) breakerTripped = false;
    let target;
    if (overrideActive) {
      target = (overrideEntryIdx !== null && (i - overrideEntryIdx) > KILL_DAYS) ? 1.0 : OVERRIDE_LEV;
    } else if (bl) {
      if (exposure === 0 && hedgeEntryClose !== null && rows[d].close >= hedgeEntryClose * BREAKER_MULT) breakerTripped = true;
      target = breakerTripped ? 1.0 : 0.0;
    } else target = 1.0;
    if (target !== exposure) {
      equity *= (1 - Math.abs(target - exposure) * FEE);
      if (target === 0) hedgeEntryClose = rows[d].close;
    }
    const r = rows[i].close / rows[i - 1].close - 1;
    exposure = target;
    equity *= (1 + exposure * r) / (1 + r);
    path[i] = equity;
  }
  return path;
}

function idxAtOrAfter(rows, ts) {
  let lo = 0; let hi = rows.length - 1; let ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].ts >= ts) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
  return ans;
}

async function main() {
  const [rows, ref] = await Promise.all([loadPrices(), loadRefAhr()]);
  let ind = null; let picked = null; let val = null;
  for (const mode of ['harmonic', 'geometric']) {
    const cand = computeIndicators(rows, mode);
    const v = validate(rows, cand, ref);
    if (!val || v.medianAbsRelErr < val.medianAbsRelErr) { ind = cand; val = v; picked = mode; }
  }
  if (val.medianAbsRelErr === null || val.medianAbsRelErr > 0.05) {
    throw new Error(`AHR999 replication failed validation: ${JSON.stringify(val)}`);
  }
  const startIdx = 400; // 200 MA + margin; dd365 needs 365 -> use max
  const simStart = Math.max(400, 366);
  const equityPath = simulate(rows, ind, simStart);
  const endIdx = rows.length - 1;
  const endTs = rows[endIdx].ts;

  const windows = [1, 3, 5, 10, 14.75, 15, 20];
  const table = [];
  for (const y of windows) {
    const ts = endTs - y * 365.25 * 86400000;
    const i0 = idxAtOrAfter(rows, ts);
    if (i0 < 0 || i0 <= simStart || equityPath[i0] === null) {
      table.push({ years: y, available: false, reason: i0 < 0 ? 'no price data' : 'before sim start (indicator warmup)' });
      continue;
    }
    const yearsExact = (endTs - rows[i0].ts) / (365.25 * 86400000);
    const hodl = Math.pow(rows[endIdx].close / rows[i0].close, 1 / yearsExact) - 1;
    const btcMult = equityPath[endIdx] / equityPath[i0];
    const excessBtcCagr = Math.pow(btcMult, 1 / yearsExact) - 1;
    const sysUsd = Math.pow((equityPath[endIdx] * rows[endIdx].close) / (equityPath[i0] * rows[i0].close), 1 / yearsExact) - 1;
    table.push({
      years: y,
      available: true,
      from: rows[i0].date,
      to: rows[endIdx].date,
      hodlUsdCagrPct: hodl * 100,
      systemUsdCagrPct: sysUsd * 100,
      excessBtcCagrPct: excessBtcCagr * 100,
      totalBtcExcessPct: (btcMult - 1) * 100,
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    engine: 'long-price-history linear overlay; ahr999 replicated from formula',
    ahrValidation: { dcaMode: picked, ...val },
    priceWindow: { start: rows[0].date, end: rows[endIdx].date, n: rows.length },
    simStart: rows[simStart].date,
    windows: table,
  };
  const file = path.join(__dirname, '..', 'research', 'btc-v4-annualized-windows.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
