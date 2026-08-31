'use strict';

// E3 + E4 + E5: long-history simulation on the FINAL-FORM system from E1/E2:
//   Layer-2 = bear-lock binary switch (bearLock -> 0.0x hedge, else 1.0x)
//   Layer-3 = AHR999 override at 1.5x (E2 cap), Sunday hysteresis <0.40 / >=0.45
// Research-only. Does not modify main, production strategy, or deploy anything.
//
// Why a separate engine: the COIN-M archive only starts 2020-08 and contains
// ~2 override hand-backs; E3/E5 need the 2011+ history (10 override episodes,
// 7 hand-backs in the ledger backtest). This engine uses the AHR999 dataset's
// daily closes with a linear-futures overlay approximation in BTC terms:
//   equity_btc(t) = equity_btc(t-1) * (1 + e*r) / (1 + r),  r = daily return,
// exposure e decided on T-1 close, fees 10bps total on |delta e|.
// Caveats (frozen): no funding, no inverse-contract convexity, no intraday
// wicks. Solvency was settled separately by E2; this engine measures
// ACCUMULATION distributions, not liquidation risk.
//
// E3 variants (hand-back = override exits while bearLock still true):
//   short           - current rule: hedge to 0.0x immediately
//   no_short        - never hedge (bearLock ignored) [reference floor]
//   neutral_handback- after hand-back stay 1.0x until bearLock clears once
//   breaker         - hedge, but if close rises >=25% above hedge-entry close
//                     while hedged, exit to 1.0x until bearLock clears
// E4 variants (on top of current rule):
//   killDays N      - if override ACTIVE continuously > N days, cap target to
//                     1.0x until hysteresis exit (structural-failure sentinel)
//   confirmGate     - entry additionally requires drawdown365 <= -20% on the
//                     decision day (independent confirmation)
// E5: seeded bootstrap over non-1x exposure segments (override segments and
//   hedge segments resampled within type, with replacement), 10k draws,
//   P10/P50/P90 of total excess multiplier.
//
// Acceptance rules (frozen before run):
//   E3: keep shorting only if `short` beats `no_short` on full-history ending
//       equity AND per-handback leave-one-out never drops below no_short.
//       Breaker adopted if it keeps >=90% of short's excess with a better
//       worst hedge segment.
//   E4: sentinel adopted if historical cost < 2% of ending equity.

const fs = require('fs');
const path = require('path');

const AHR_URL = 'https://raw.githubusercontent.com/RuochenLyu/ahr999-dataset/main/datasets/ahr999.csv';
const FEE_BPS_TOTAL = 10; // 5 fee + 5 slippage per unit of exposure changed
const OVERRIDE_LEV = 1.5;
const MA_LONG = 200;
const SLOPE_DAYS = 30;
const DD_LOOKBACK = 365;
const WARMUP = 365;

async function loadSeries() {
  const res = await fetch(AHR_URL, { headers: { 'User-Agent': 'bfr-e3e4e5-longsim/1.0' } });
  if (!res.ok) throw new Error(`AHR dataset fetch failed: HTTP ${res.status}`);
  const csv = await res.text();
  const rows = csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const p = line.split(',');
    return { date: p[0], ts: Date.parse(`${p[0]}T00:00:00Z`), close: Number(p[1]), ahr: Number(p[3]) };
  }).filter((r) => r.date && Number.isFinite(r.close) && r.close > 0 && Number.isFinite(r.ahr));
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

function precompute(rows) {
  const n = rows.length;
  const ma200 = new Array(n).fill(null);
  const bearLock = new Array(n).fill(null);
  const dd365 = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += rows[i].close;
    if (i >= MA_LONG) sum -= rows[i - MA_LONG].close;
    if (i >= MA_LONG - 1) ma200[i] = sum / MA_LONG;
  }
  for (let i = 0; i < n; i += 1) {
    if (ma200[i] !== null && ma200[i - SLOPE_DAYS] != null) {
      const slope = ma200[i] / ma200[i - SLOPE_DAYS] - 1;
      bearLock[i] = rows[i].close < ma200[i] && slope < 0;
    }
    if (i >= DD_LOOKBACK - 1) {
      let peak = 0;
      for (let j = i - DD_LOOKBACK + 1; j <= i; j += 1) peak = Math.max(peak, rows[j].close);
      dd365[i] = rows[i].close / peak - 1;
    }
  }
  return { ma200, bearLock, dd365 };
}

function simulate(rows, sig, opts) {
  const { variant, breakerMult = 1.25, killDays = null, confirmGate = false } = opts;
  let equity = 1;
  let exposure = 1;
  let overrideActive = false;
  let overrideEntryIdx = null;
  let handbackNeutral = false;
  let breakerTripped = false;
  let hedgeEntryClose = null;
  let peak = 1;
  let maxDD = 0;
  let totalFees = 0;
  const segments = [];
  const handbacks = [];
  const overrideEpisodes = [];
  const activeDurations = [];
  let blockedEntries = 0;
  let currentSeg = null;
  let epStartEquity = null;
  let epStartDate = null;

  for (let i = WARMUP + 1; i < rows.length; i += 1) {
    const d = i - 1; // decision index: T-1 close
    const isSunday = new Date(rows[i].ts).getUTCDay() === 0;
    const bl = sig.bearLock[d] === true;

    if (isSunday) {
      const ahr = rows[d].ahr;
      const wasActive = overrideActive;
      if (!overrideActive && ahr < 0.40) {
        const gateOk = !confirmGate || (sig.dd365[d] !== null && sig.dd365[d] <= -0.20);
        if (gateOk) overrideActive = true;
        else blockedEntries += 1;
      } else if (overrideActive && ahr >= 0.45) overrideActive = false;
      if (!wasActive && overrideActive) {
        overrideEntryIdx = i;
        epStartEquity = equity;
        epStartDate = rows[i].date;
      }
      if (wasActive && !overrideActive) {
        activeDurations.push(i - overrideEntryIdx);
        overrideEpisodes.push({ start: epStartDate, end: rows[i].date, days: i - overrideEntryIdx, mult: equity / epStartEquity });
        if (bl) {
          handbacks.push({ date: rows[i].date, idx: i });
          if (variant === 'neutral_handback') handbackNeutral = true;
        }
        overrideEntryIdx = null;
      }
    }
    if (!bl) { handbackNeutral = false; breakerTripped = false; }

    let target;
    if (overrideActive) {
      const killed = killDays !== null && overrideEntryIdx !== null && (i - overrideEntryIdx) > killDays;
      target = killed ? 1.0 : OVERRIDE_LEV;
    } else if (bl) {
      if (variant === 'no_short') target = 1.0;
      else if (variant === 'neutral_handback' && handbackNeutral) target = 1.0;
      else if (variant === 'breaker') {
        if (exposure === 0 && hedgeEntryClose !== null && rows[d].close >= hedgeEntryClose * breakerMult) breakerTripped = true;
        target = breakerTripped ? 1.0 : 0.0;
      } else target = 0.0;
    } else target = 1.0;

    if (target !== exposure) {
      const fee = Math.abs(target - exposure) * (FEE_BPS_TOTAL / 10000);
      equity *= (1 - fee);
      totalFees += fee;
      if (target === 0) hedgeEntryClose = rows[d].close;
      if (currentSeg) { currentSeg.end = rows[d].date; currentSeg.mult = equity / currentSeg.startEquity; segments.push(currentSeg); currentSeg = null; }
      if (target !== 1.0) {
        currentSeg = {
          type: target === 0 ? 'hedge' : 'override',
          start: rows[i].date,
          startEquity: equity,
          fromHandback: target === 0 && handbacks.some((h) => h.idx === i || h.idx === i - 1),
        };
      }
    }

    const r = rows[i].close / rows[i - 1].close - 1;
    exposure = target; // decided at T-1 close, executed at T open
    equity *= (1 + exposure * r) / (1 + r);
    if (equity > peak) peak = equity;
    maxDD = Math.min(maxDD, equity / peak - 1);
  }
  if (currentSeg) { currentSeg.end = rows.at(-1).date; currentSeg.mult = equity / currentSeg.startEquity; segments.push(currentSeg); }
  if (overrideActive && overrideEntryIdx !== null) {
    activeDurations.push(rows.length - 1 - overrideEntryIdx);
    overrideEpisodes.push({ start: epStartDate, end: rows.at(-1).date, days: rows.length - 1 - overrideEntryIdx, mult: equity / epStartEquity, openEnded: true });
  }

  return {
    ...opts,
    endingEquityBtc: equity,
    excessPct: (equity - 1) * 100,
    btcMaxDrawdown: maxDD,
    totalFeesPct: totalFees * 100,
    segments,
    handbacks: handbacks.map((h) => h.date),
    overrideEpisodes,
    activeDurations,
    blockedEntries,
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrap(segments, draws = 10000, seed = 20260831) {
  const hedges = segments.filter((s) => s.type === 'hedge').map((s) => s.mult);
  const overrides = segments.filter((s) => s.type === 'override').map((s) => s.mult);
  const rand = mulberry32(seed);
  const totals = new Array(draws);
  for (let k = 0; k < draws; k += 1) {
    let p = 1;
    for (let j = 0; j < overrides.length; j += 1) p *= overrides[Math.floor(rand() * overrides.length)];
    for (let j = 0; j < hedges.length; j += 1) p *= hedges[Math.floor(rand() * hedges.length)];
    totals[k] = p;
  }
  totals.sort((a, b) => a - b);
  const q = (x) => totals[Math.min(draws - 1, Math.floor(x * draws))];
  return {
    draws,
    seed,
    nOverrideSegments: overrides.length,
    nHedgeSegments: hedges.length,
    p10ExcessPct: (q(0.10) - 1) * 100,
    p50ExcessPct: (q(0.50) - 1) * 100,
    p90ExcessPct: (q(0.90) - 1) * 100,
    probNegative: totals.filter((t) => t < 1).length / draws,
  };
}

async function main() {
  const rows = await loadSeries();
  const sig = precompute(rows);

  const scenarios = [
    { name: 'e3_short_current', variant: 'short' },
    { name: 'e3_no_short', variant: 'no_short' },
    { name: 'e3_neutral_handback', variant: 'neutral_handback' },
    { name: 'e3_breaker_1_25', variant: 'breaker', breakerMult: 1.25 },
    { name: 'e4_kill_182', variant: 'short', killDays: 182 },
    { name: 'e4_kill_364', variant: 'short', killDays: 364 },
    { name: 'e4_confirm_gate', variant: 'short', confirmGate: true },
    { name: 'e4_gate_plus_kill_364', variant: 'short', confirmGate: true, killDays: 364 },
  ];
  const results = scenarios.map((sc) => ({ name: sc.name, ...simulate(rows, sig, sc) }));

  const cur = results.find((r) => r.name === 'e3_short_current');
  const noShort = results.find((r) => r.name === 'e3_no_short');
  const hedgeSegs = cur.segments.filter((s) => s.type === 'hedge');
  const leaveOneOut = hedgeSegs.map((s) => ({
    segment: `${s.start}..${s.end}`,
    mult: s.mult,
    fromHandback: s.fromHandback,
    totalWithoutIt: cur.endingEquityBtc / s.mult,
  }));

  const boot = {};
  for (const name of ['e3_short_current', 'e3_no_short', 'e3_breaker_1_25']) {
    boot[name] = bootstrap(results.find((r) => r.name === name).segments);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    productionChanged: false,
    researchVersion: 'btc-v3-e3e4e5-longsim-v1',
    dataWindow: { start: rows[WARMUP + 1].date, end: rows.at(-1).date, observations: rows.length - WARMUP - 1 },
    engineCaveats: [
      'Linear daily overlay approximation in BTC terms; no funding, no inverse convexity, no wicks.',
      'Solvency/liquidation risk is out of scope here (settled by E2).',
      'Exit fees on return-to-1x land outside segments; effect < fee budget, ignored in bootstrap.',
    ],
    finalFormUnderTest: 'L2 bear-lock binary (0.0x hedge), L3 override 1.5x, Sunday hysteresis 0.40/0.45',
    scenarios: results.map((r) => ({
      name: r.name,
      excessPct: r.excessPct,
      endingEquityBtc: r.endingEquityBtc,
      btcMaxDrawdown: r.btcMaxDrawdown,
      totalFeesPct: r.totalFeesPct,
      handbacks: r.handbacks,
      overrideEpisodes: r.overrideEpisodes,
      activeDurations: r.activeDurations,
      blockedEntries: r.blockedEntries,
      hedgeSegments: r.segments.filter((s) => s.type === 'hedge').map((s) => ({ start: s.start, end: s.end, mult: s.mult, fromHandback: s.fromHandback })),
    })),
    e3LeaveOneOut: leaveOneOut,
    e5Bootstrap: boot,
  };
  const file = path.join(__dirname, '..', 'research', 'btc-v3-e3e4e5-result.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify({
    window: out.dataWindow,
    summary: results.map((r) => ({ name: r.name, excessPct: Number(r.excessPct.toFixed(1)), mdd: Number(r.btcMaxDrawdown.toFixed(3)), handbacks: r.handbacks.length, episodes: r.overrideEpisodes.length, blocked: r.blockedEntries, maxActiveDays: r.activeDurations.length ? Math.max(...r.activeDurations) : 0 })),
    bootstrap: boot,
  }, null, 2));
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
