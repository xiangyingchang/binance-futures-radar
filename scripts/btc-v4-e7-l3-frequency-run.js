// E7 runner: executes V-A/V-B/V-C, answers preregistered questions (a)-(d),
// runs episode-level leave-one-out and episode bootstrap noise band.
// Output: research/btc-v4-e7-l3-frequency-result.json
'use strict';
const fs = require('fs');
const E = require('./btc-v4-e7-l3-frequency-engine.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const rows = E.loadPrices();
  const ind = E.computeIndicators(rows);
  const ref = await E.loadRefAhr();
  const medErr = E.validate(ind, rows, ref);
  console.log(`rows=${rows.length} ${rows[0].date}..${rows[rows.length - 1].date} ahrMedianErr=${(medErr * 100).toFixed(2)}%`);

  // window: same as E6 full-history (first index where ahr+dd365 available, ~2011-08)
  let startIdx = 0;
  for (let i = 0; i < rows.length; i += 1) { if (ind.ahr[i - 1] != null && ind.dd365[i - 1] != null && ind.bearLock[i - 1] != null) { startIdx = i; break; } }
  const endIdx = rows.length - 1;
  console.log(`window ${rows[startIdx].date}..${rows[endIdx].date}`);

  const base = E.simulate(rows, ind, startIdx, endIdx, 'off');   // L2-only baseline for excess? No — baseline is pure DCA.
  // Pure-DCA baseline: no overlay at all. Simulate with l3Mode off and L2 off is not
  // in engine; emulate by exposure always 1: overlayRatio stays 1. Compute directly:
  let dcaStack = 0, dcaInvested = 0, ammo = 0;
  for (let i = startIdx; i <= endIdx; i += 1) {
    const d = i - 1;
    if (new Date(rows[i].ts).getUTCDay() === 0 && ind.ahr[d] !== null) {
      let spend = (function tier(a) { const T = [[0.45, 1400], [0.75, 1225], [1.0, 700], [1.2, 420], [5.0, 210], [Infinity, 140]]; for (const t of T) if (a < t[0]) return t[1]; return 140; })(ind.ahr[d]);
      const WEEKLY = 700;
      if (spend > WEEKLY) { const extra = Math.min(spend - WEEKLY, ammo); spend = WEEKLY + extra; ammo -= extra; }
      else if (spend < WEEKLY) ammo += WEEKLY - spend;
      dcaStack += (spend / rows[i].close) * (1 - E.FEE);
      dcaInvested += spend;
    }
  }

  const variants = { 'V-A': 'weekly', 'V-B': 'enterDaily', 'V-C': 'fullDaily' };
  const results = {};
  for (const [name, mode] of Object.entries(variants)) {
    const r = E.simulate(rows, ind, startIdx, endIdx, mode);
    results[name] = { ...r, excessPct: (r.stack / dcaStack - 1) * 100 };
    console.log(`${name}: stack=${r.stack.toFixed(4)} excess=${results[name].excessPct.toFixed(1)}% switches=${r.switches} episodes=${r.episodes.length} overrideDays=${r.overrideDays} mdd=${r.overlayRatioMdd.toFixed(1)}%`);
  }

  // ---- (a) V-A skipped windows: daily condition true but gone before next Sunday ----
  const skipped = [];
  let inWin = null;
  for (let i = startIdx; i <= endIdx; i += 1) {
    const d = i - 1;
    const cond = ind.ahr[d] !== null && ind.ahr[d] < 0.40 && ind.dd365[d] !== null && ind.dd365[d] <= -0.20;
    const isSunday = new Date(rows[i].ts).getUTCDay() === 0;
    if (cond && !inWin) inWin = { startDate: rows[i].date, startIdx: i, sawSunday: false };
    if (inWin) {
      if (cond && isSunday) inWin.sawSunday = true;
      if (!cond) {
        inWin.endDate = rows[i - 1].date; inWin.endIdx = i - 1;
        if (!inWin.sawSunday) {
          const e = inWin.startIdx;
          const p30 = e + 30 <= endIdx ? rows[e + 30].close / rows[e].close - 1 : null;
          const p90 = e + 90 <= endIdx ? rows[e + 90].close / rows[e].close - 1 : null;
          skipped.push({ start: inWin.startDate, end: inWin.endDate, days: inWin.endIdx - inWin.startIdx + 1, entryPrice: rows[e].close, fwd30: p30 !== null ? +(p30 * 100).toFixed(1) : null, fwd90: p90 !== null ? +(p90 * 100).toFixed(1) : null });
        }
        inWin = null;
      }
    }
  }

  // ---- (b) early-entry ledger: V-B episodes vs matching V-A episodes ----
  const early = [];
  for (const eb of results['V-B'].episodes) {
    const match = results['V-A'].episodes.find(ea => Math.abs(ea.entryIdx - eb.entryIdx) <= 21 && ea.entryIdx >= eb.entryIdx);
    if (match && match.entryIdx > eb.entryIdx) {
      const dd = rows[match.entryIdx].close / rows[eb.entryIdx].close - 1;
      early.push({ vbEntry: eb.entryDate, vaEntry: match.entryDate, daysEarly: match.entryIdx - eb.entryIdx, priceChangeWhileEarlyPct: +(dd * 100).toFixed(2), vbEntryPrice: eb.entryPrice, vaEntryPrice: match.entryPrice });
    } else if (!match) {
      early.push({ vbEntry: eb.entryDate, vaEntry: null, daysEarly: null, note: 'no matching V-A episode within 21d (V-A skipped or merged)' });
    }
  }

  // ---- (c) leave-one-out over V-A episode set (masking each episode's period) ----
  // Approach: re-simulate with ahr forced >=0.45 during the masked episode's [entry,exit]
  const loo = [];
  const epsA = results['V-A'].episodes;
  for (let k = 0; k < epsA.length; k += 1) {
    const mask = epsA[k];
    const ahrBackup = ind.ahr.slice();
    for (let i = mask.entryIdx - 1; i <= (mask.exitIdx ?? endIdx); i += 1) if (ind.ahr[i] !== null && ind.ahr[i] < 0.45) ind.ahr[i] = 0.46;
    const rA = E.simulate(rows, ind, startIdx, endIdx, 'weekly');
    const rB = E.simulate(rows, ind, startIdx, endIdx, 'enterDaily');
    const rC = E.simulate(rows, ind, startIdx, endIdx, 'fullDaily');
    loo.push({ masked: `${mask.entryDate}..${mask.exitDate}`, excessA: +((rA.stack / dcaStack - 1) * 100).toFixed(1), excessB: +((rB.stack / dcaStack - 1) * 100).toFixed(1), excessC: +((rC.stack / dcaStack - 1) * 100).toFixed(1), bMinusA: +(((rB.stack - rA.stack) / dcaStack) * 100).toFixed(2), cMinusA: +(((rC.stack - rA.stack) / dcaStack) * 100).toFixed(2) });
    ind.ahr = ahrBackup;
  }

  // ---- (d) post-entry max drawdown distribution per variant ----
  const ddStats = {};
  for (const [name, r] of Object.entries(results)) {
    ddStats[name] = r.episodes.map(ep => ({ entry: ep.entryDate, exit: ep.exitDate, postEntryMaxDDPct: +((ep.minPrice / ep.entryPrice - 1) * 100).toFixed(1), minDate: ep.minDate, killed: !!ep.killed, openAtEnd: !!ep.openAtEnd }));
  }

  // ---- bootstrap noise band on B-A and C-A (episode-block resample, seed 20260903) ----
  // Blocks: split timeline into segments at V-A episode boundaries; resample segments with replacement
  // Simplified per-E5 convention: resample yearly blocks of daily overlay ratio differences.
  const years = {};
  for (let i = startIdx; i <= endIdx; i += 1) {
    const y = rows[i].date.slice(0, 4);
    (years[y] = years[y] || []).push(i);
  }
  const yearKeys = Object.keys(years);
  // per-year multiplicative overlay growth for each variant (re-sim per year is costly; approximate via daily ratio streams)
  function dailyRatios(mode) {
    const r = E.simulate(rows, ind, startIdx, endIdx, mode);
    return r; // we need path; engine doesn't expose it — fallback: yearly re-sim
  }
  // yearly re-sim windows
  const yearly = {};
  for (const y of yearKeys) {
    const s = years[y][0], e = years[y][years[y].length - 1];
    if (e - s < 30) continue;
    const yr = {};
    for (const [name, mode] of Object.entries(variants)) {
      const rr = E.simulate(rows, ind, Math.max(s, startIdx), e, mode);
      // yearly overlay growth vs own pure dca in same window
      let ds = 0, am = 0;
      for (let i = Math.max(s, startIdx); i <= e; i += 1) {
        const d = i - 1;
        if (new Date(rows[i].ts).getUTCDay() === 0 && ind.ahr[d] !== null) {
          let spend = (function (a) { const T = [[0.45, 1400], [0.75, 1225], [1.0, 700], [1.2, 420], [5.0, 210], [Infinity, 140]]; for (const t of T) if (a < t[0]) return t[1]; return 140; })(ind.ahr[d]);
          if (spend > 700) { const ex = Math.min(spend - 700, am); spend = 700 + ex; am -= ex; } else if (spend < 700) am += 700 - spend;
          ds += (spend / rows[i].close) * (1 - E.FEE);
        }
      }
      yr[name] = ds > 0 ? rr.stack / ds : 1;
    }
    yearly[y] = yr;
  }
  const yk = Object.keys(yearly);
  const rng = mulberry32(20260903);
  const bootBA = [], bootCA = [];
  for (let b = 0; b < 10000; b += 1) {
    let gA = 1, gB = 1, gC = 1;
    for (let j = 0; j < yk.length; j += 1) {
      const pick = yearly[yk[Math.floor(rng() * yk.length)]];
      gA *= pick['V-A']; gB *= pick['V-B']; gC *= pick['V-C'];
    }
    bootBA.push((gB - gA) / gA * 100);
    bootCA.push((gC - gA) / gA * 100);
  }
  bootBA.sort((a, b) => a - b); bootCA.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.floor(p * arr.length)];
  const band = {
    bMinusA: { p10: +q(bootBA, 0.10).toFixed(1), p50: +q(bootBA, 0.50).toFixed(1), p90: +q(bootBA, 0.90).toFixed(1) },
    cMinusA: { p10: +q(bootCA, 0.10).toFixed(1), p50: +q(bootCA, 0.50).toFixed(1), p90: +q(bootCA, 0.90).toFixed(1) },
  };

  const out = {
    meta: { generated: new Date().toISOString(), seed: 20260903, window: `${rows[startIdx].date}..${rows[endIdx].date}`, ahrMedianErrPct: +(medErr * 100).toFixed(2), engine: 'linear daily approximation (no funding/convexity/wicks); solvency per E2', prereg: 'research/btc-v4-e7-preregistration.md @ 1e79435' },
    baseline: { dcaStack: +dcaStack.toFixed(4), invested: dcaInvested },
    variants: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { stack: +v.stack.toFixed(4), excessPct: +v.excessPct.toFixed(1), switches: v.switches, feeBtcPaidPct: +v.feeBtcPaidPct.toFixed(2), overrideDays: v.overrideDays, hedgeDays: v.hedgeDays, overlayRatioMddPct: +v.overlayRatioMdd.toFixed(1), episodes: v.episodes.map(e => ({ entry: e.entryDate, exit: e.exitDate, entryPrice: +e.entryPrice.toFixed(0), killed: !!e.killed, openAtEnd: !!e.openAtEnd })) }])),
    qa_skippedWindows: skipped,
    qb_earlyEntryLedger: early,
    qc_leaveOneOut: loo,
    qd_postEntryDrawdown: ddStats,
    bootstrapBand: band,
  };
  fs.writeFileSync('research/btc-v4-e7-l3-frequency-result.json', JSON.stringify(out, null, 2));
  console.log('\nB-A band:', JSON.stringify(band.bMinusA), 'C-A band:', JSON.stringify(band.cMinusA));
  console.log('skipped windows:', skipped.length, '| early entries:', early.length);
  console.log('written research/btc-v4-e7-l3-frequency-result.json');
}

main().catch(e => { console.error(e); process.exit(1); });
