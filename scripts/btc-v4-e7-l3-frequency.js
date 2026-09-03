'use strict';

// E7: BTC V4 layer-3 (deep-water override) entry/calibration frequency ablation.
// Research-only. This runner does not touch production cron, Forward Test ledger,
// or frozen strategy parameters.
//
// The core DCA/overlay mechanics intentionally mirror E6. The only production
// decision variable in the three primary runs is L3 entry/calibration frequency:
//   V-A: Sunday entry / Sunday calibration
//   V-B: daily entry / Sunday calibration
//   V-C: daily entry / daily calibration
//
// Input is the E6 Coin Metrics daily PriceUSD window. The runner accepts the
// downloaded API JSON (BTC_E7_PRICE_JSON) or the original E6 CSV path
// (BTC_E7_PRICE_CSV). AHR999 is recomputed from the E6 formula and validated
// against the public reference dataset.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const PRICE_JSON = process.env.BTC_E7_PRICE_JSON || '/tmp/e7_coinmetrics_page.json';
const PRICE_CSV = process.env.BTC_E7_PRICE_CSV || '/tmp/btc_cm_full.csv';
const PRICE_API_URL = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=PriceUSD&frequency=1d&start_time=2010-07-18&end_time=2026-05-23&page_size=10000';
const AHR_URL = 'https://raw.githubusercontent.com/RuochenLyu/ahr999-dataset/main/datasets/ahr999.csv';
const GENESIS = Date.parse('2009-01-03T00:00:00Z');

// Frozen E6 mechanics.
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

// E7 pre-registration commits. The second commit is the execution-timing
// clarification appended before any E7 backtest was run.
const PREREG_COMMITS = ['5ad5f7b', 'c58b322'];
const EVIDENCE_TAG = 'v4-research-e1e6';
const EVIDENCE_COMMIT = 'eeae654';
const BOOTSTRAP_DRAWS = 10000;
const BOOTSTRAP_SEED = 20260831;

// E2 frozen stress grid.
const CONTRACT_SIZE_USD = 100;
const E2_BASE_ENTRY_PRICE = 60000;
const E2_BASE_EQUITY_BTC = 1;
const E2_LEVERAGES = [1.25, 1.5, 1.75, 2.0];
const E2_DROPS = [0.40, 0.50, 0.60];
const E2_DURATIONS_DAYS = [14, 56, 182];
const E2_WICKS = [0.10, 0.20];
const E2_MAINT_RATES = [0.05, 0.10];
const E2_FUNDING_RATES = [0.0005, 0.003];
const E2_FUNDING_EVENTS_PER_DAY = 3;

const VARIANTS = {
  'V-A': { entryFrequency: 'sunday', calibrationFrequency: 'sunday', description: '现行：周日入场 / 周日校准' },
  'V-B': { entryFrequency: 'daily', calibrationFrequency: 'sunday', description: '每日入场 / 周日校准' },
  'V-C': { entryFrequency: 'daily', calibrationFrequency: 'daily', description: '每日入场 / 每日校准' },
};

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function gitMeta() {
  try {
    const commit = cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = cp.execFileSync('git', ['status', '--porcelain', '--', __filename], { encoding: 'utf8' }).trim();
    return { commit, scriptDirtyAtRun: Boolean(status) };
  } catch (_) {
    return { commit: null, scriptDirtyAtRun: null };
  }
}

function parsePriceRows(items) {
  const rows = [];
  for (const item of items) {
    const rawDate = item.time || item.date;
    const close = Number(item.PriceUSD ?? item.close);
    if (!rawDate || !Number.isFinite(close) || close <= 0) continue;
    const date = String(rawDate).slice(0, 10);
    const ts = Date.parse(`${date}T00:00:00Z`);
    if (Number.isFinite(ts)) rows.push({ date, ts, close });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

function validateDailyRows(rows) {
  const seen = new Set();
  const duplicateDates = [];
  const missingDays = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (seen.has(rows[i].date)) duplicateDates.push(rows[i].date);
    seen.add(rows[i].date);
    if (i > 0) {
      const gap = Math.round((rows[i].ts - rows[i - 1].ts) / 86400000);
      if (gap !== 1) missingDays.push({ after: rows[i - 1].date, before: rows[i].date, gapDays: gap });
    }
  }
  if (duplicateDates.length || missingDays.length) {
    throw new Error(`Price input is not a unique daily series: ${JSON.stringify({ duplicateDates, missingDays: missingDays.slice(0, 10) })}`);
  }
}

function loadPrices() {
  let rows;
  let source;
  if (fs.existsSync(PRICE_JSON)) {
    const raw = fs.readFileSync(PRICE_JSON);
    const parsed = JSON.parse(raw.toString('utf8'));
    rows = parsePriceRows(Array.isArray(parsed) ? parsed : parsed.data || []);
    source = { type: 'coinmetrics-community-api-json', path: PRICE_JSON, sha256: sha256Buffer(raw), url: PRICE_API_URL };
  } else if (fs.existsSync(PRICE_CSV)) {
    const raw = fs.readFileSync(PRICE_CSV);
    const lines = raw.toString('utf8').trim().split(/\r?\n/);
    const header = lines[0].split(',');
    const ti = header.indexOf('time');
    const pi = header.indexOf('PriceUSD');
    if (ti < 0 || pi < 0) throw new Error(`CSV lacks time/PriceUSD columns: ${PRICE_CSV}`);
    rows = parsePriceRows(lines.slice(1).map((line) => {
      const p = line.split(',');
      return { time: p[ti], PriceUSD: p[pi] };
    }));
    source = { type: 'coinmetrics-community-csv', path: PRICE_CSV, sha256: sha256Buffer(raw), url: 'https://github.com/coinmetrics/data' };
  } else {
    throw new Error(`Missing E6 price input. Download the fixed window to ${PRICE_JSON}, or set BTC_E7_PRICE_JSON/BTC_E7_PRICE_CSV.`);
  }
  validateDailyRows(rows);
  const manifest = {
    ...source,
    observations: rows.length,
    start: rows[0]?.date || null,
    end: rows.at(-1)?.date || null,
    first: rows[0] || null,
    last: rows.at(-1) || null,
    duplicateDates: 0,
    missingDays: 0,
  };
  return { rows, manifest };
}

async function loadReferenceAhr() {
  const res = await fetch(AHR_URL, { headers: { 'User-Agent': 'bfr-e7/1.0' } });
  if (!res.ok) throw new Error(`AHR reference fetch failed ${res.status}: ${AHR_URL}`);
  const text = await res.text();
  const map = new Map();
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const p = line.split(',');
    if (p[0] && Number.isFinite(Number(p[3]))) map.set(p[0], Number(p[3]));
  }
  return { map, sha256: sha256Buffer(Buffer.from(text)), observations: map.size };
}

function computeIndicators(rows, dcaMode) {
  const n = rows.length;
  const out = {
    ma200: new Array(n).fill(null),
    bearLock: new Array(n).fill(null),
    dd365: new Array(n).fill(null),
    ahr: new Array(n).fill(null),
  };
  let sum = 0;
  let invSum = 0;
  let logSum = 0;
  for (let i = 0; i < n; i += 1) {
    const c = rows[i].close;
    sum += c;
    invSum += 1 / c;
    logSum += Math.log(c);
    if (i >= 200) {
      const old = rows[i - 200].close;
      sum -= old;
      invSum -= 1 / old;
      logSum -= Math.log(old);
    }
    if (i >= 199) {
      out.ma200[i] = sum / 200;
      const dca = dcaMode === 'harmonic' ? 200 / invSum : Math.exp(logSum / 200);
      const ageDays = (rows[i].ts - GENESIS) / 86400000;
      const fit = Math.pow(10, 5.84 * Math.log10(ageDays) - 17.01);
      out.ahr[i] = (c / dca) * (c / fit);
    }
    if (out.ma200[i] !== null && out.ma200[i - 30] != null) {
      out.bearLock[i] = rows[i].close < out.ma200[i] && (out.ma200[i] / out.ma200[i - 30] - 1) < 0;
    }
    if (i >= 364) {
      let peak = 0;
      for (let j = i - 364; j <= i; j += 1) peak = Math.max(peak, rows[j].close);
      out.dd365[i] = rows[i].close / peak - 1;
    }
  }
  return out;
}

function validateAhr(rows, ind, ref) {
  const errors = [];
  for (let i = 0; i < rows.length; i += 1) {
    const reference = ref.get(rows[i].date);
    if (reference !== undefined && ind.ahr[i] !== null) errors.push(Math.abs(ind.ahr[i] / reference - 1));
  }
  errors.sort((a, b) => a - b);
  return {
    n: errors.length,
    medianAbsRelErr: errors.length ? errors[Math.floor(errors.length / 2)] : null,
    p90AbsRelErr: errors.length ? errors[Math.floor(errors.length * 0.9)] : null,
  };
}

function isSunday(row) {
  return new Date(row.ts).getUTCDay() === 0;
}

function entryGate(ind, idx) {
  return idx >= 0 && ind.ahr[idx] !== null && ind.ahr[idx] < 0.40 && ind.dd365[idx] !== null && ind.dd365[idx] <= -0.20;
}

function buildEpisodes(rows, ind, startIdx, endIdx) {
  const bySignalIdx = new Array(rows.length).fill(null);
  const episodes = [];
  let current = null;
  for (let d = startIdx - 1; d <= endIdx - 1; d += 1) {
    const gate = entryGate(ind, d);
    const contiguous = d > startIdx - 1 && rows[d].ts - rows[d - 1].ts === 86400000;
    if (!gate) {
      current = null;
      continue;
    }
    if (!current || !contiguous || bySignalIdx[d - 1] === null) {
      current = {
        id: `E${String(episodes.length + 1).padStart(2, '0')}`,
        signalStartIdx: d,
        signalEndIdx: d,
        signalStartDate: rows[d].date,
        signalEndDate: rows[d].date,
        minAhr: ind.ahr[d],
        minAhrIdx: d,
        minDd365: ind.dd365[d],
      };
      episodes.push(current);
    } else {
      current.signalEndIdx = d;
      current.signalEndDate = rows[d].date;
      if (ind.ahr[d] < current.minAhr) {
        current.minAhr = ind.ahr[d];
        current.minAhrIdx = d;
      }
      current.minDd365 = Math.min(current.minDd365, ind.dd365[d]);
    }
    bySignalIdx[d] = current.id;
  }
  return { episodes, bySignalIdx };
}

function tierUsd(ahr) {
  for (const tier of TIERS) if (ahr < tier.max) return tier.usd;
  return TIERS.at(-1).usd;
}

function frequencyAllows(freq, sunday) {
  return freq === 'daily' || sunday;
}

function simulateDca(rows, ind, episodeBySignalIdx, startIdx, endIdx, options) {
  const {
    l2Frequency = 'daily',
    useL3 = true,
    entryFrequency = 'sunday',
    calibrationFrequency = 'sunday',
    skipEpisodeIds = null,
    onlyEpisodeIds = null,
    captureSnapshots = true,
  } = options;

  let stack = 0;
  let ammo = 0;
  let invested = 0;
  let exposure = 1;
  let overrideActive = false;
  let overrideEntryIdx = null;
  let overrideEntrySignalIdx = null;
  let overrideEpisodeId = null;
  let activeEpisode = null;
  let breakerTripped = false;
  let hedgeEntryClose = null;
  let pendingBearSince = null;
  let switches = 0;
  let allFeeRate = 0;
  let l3FeeRate = 0;
  let hedgeDays = 0;
  let overrideDays = 0;
  let killSwitchCount = 0;
  let ratioPeak = 0;
  let ratioMdd = 0;
  let overlayRatio = 1;
  const hedgeEntryDelays = [];
  const feeEvents = [];
  const events = [];
  const completedEpisodes = [];
  const snapshots = captureSnapshots ? new Array(endIdx + 1).fill(null) : null;

  function updateActiveClose(idx) {
    if (!activeEpisode) return;
    const close = rows[idx].close;
    const dd = close / activeEpisode.entryReferenceClose - 1;
    if (close < activeEpisode.minClose) {
      activeEpisode.minClose = close;
      activeEpisode.minCloseIdx = idx;
    }
    activeEpisode.maxCloseDrawdownPct = Math.min(activeEpisode.maxCloseDrawdownPct, dd * 100);
  }

  function finishActive(endSignalIdx, reason) {
    if (!activeEpisode) return;
    activeEpisode.endSignalIdx = endSignalIdx;
    activeEpisode.endDate = rows[endSignalIdx].date;
    activeEpisode.endReason = reason;
    activeEpisode.durationDays = endSignalIdx - activeEpisode.entrySignalIdx;
    activeEpisode.postEntryMaxDrawdownPct = activeEpisode.maxCloseDrawdownPct;
    completedEpisodes.push({ ...activeEpisode });
    activeEpisode = null;
  }

  function recordSnapshot(i, isSunday, target) {
    if (!snapshots) return;
    snapshots[i] = {
      stack,
      invested,
      ammo,
      exposure,
      target,
      overrideActive,
      overlayRatio,
      cumulativeFeeRate: allFeeRate,
      cumulativeL3FeeRate: l3FeeRate,
      switches,
      isSunday,
    };
  }

  for (let i = startIdx; i <= endIdx; i += 1) {
    const d = i - 1;
    const sunday = isSunday(rows[i]);
    const bl = ind.bearLock[d] === true;
    const ahr = ind.ahr[d];
    const episodeId = episodeBySignalIdx[d];
    let entryEvent = null;
    let exitEvent = null;
    let killAtThisStep = false;

    // --- L3 state; this is the only frequency variable across V-A/V-B/V-C. ---
    if (useL3) {
      if (!overrideActive && frequencyAllows(entryFrequency, sunday) && entryGate(ind, d)) {
        const allowedByEpisode = !onlyEpisodeIds || onlyEpisodeIds.has(episodeId);
        const notSkipped = !skipEpisodeIds || !skipEpisodeIds.has(episodeId);
        if (episodeId && allowedByEpisode && notSkipped) {
          overrideActive = true;
          overrideEntryIdx = i;
          overrideEntrySignalIdx = d;
          overrideEpisodeId = episodeId;
          activeEpisode = {
            episodeId,
            entrySignalIdx: d,
            entryIdx: i,
            entrySignalDate: rows[d].date,
            firstAffectedReturnDate: rows[i].date,
            entryReferenceClose: rows[d].close,
            minClose: rows[d].close,
            minCloseIdx: d,
            maxCloseDrawdownPct: 0,
            endSignalIdx: null,
            endDate: null,
            endReason: null,
            killSwitchDate: null,
          };
          entryEvent = {
            type: 'entry',
            episodeId,
            signalIdx: d,
            signalDate: rows[d].date,
            affectedIdx: i,
            affectedDate: rows[i].date,
            entryReferenceClose: rows[d].close,
            feeRate: 0,
          };
          events.push(entryEvent);
        }
      } else if (overrideActive && frequencyAllows(calibrationFrequency, sunday) && ahr !== null && ahr >= 0.45) {
        finishActive(d, 'hysteresis_exit');
        overrideActive = false;
        overrideEntryIdx = null;
        overrideEntrySignalIdx = null;
        overrideEpisodeId = null;
        exitEvent = {
          type: 'exit',
          episodeId: activeEpisode?.episodeId || null,
          signalIdx: d,
          signalDate: rows[d].date,
          affectedIdx: i,
          affectedDate: rows[i].date,
          exitReason: 'hysteresis_exit',
          feeRate: 0,
        };
        // finishActive clears activeEpisode; recover the episode id from the
        // most recent completed record for the event payload.
        if (!exitEvent.episodeId && completedEpisodes.length) exitEvent.episodeId = completedEpisodes.at(-1).episodeId;
        events.push(exitEvent);
      }
    }
    if (!bl) breakerTripped = false;

    // --- Target exposure: exact E6 priority L3 > L2 > 1x. ---
    let target = exposure;
    let transitionCategory = null;
    const decideL2 = l2Frequency === 'daily' || (l2Frequency === 'weekly' && sunday);
    if (l2Frequency === 'none') {
      target = 1.0;
    } else if (useL3 && overrideActive) {
      const killed = overrideEntryIdx !== null && (i - overrideEntryIdx) > KILL_DAYS;
      target = killed ? 1.0 : OVERRIDE_LEV;
      if (killed && target !== exposure) {
        transitionCategory = 'l3_kill_switch';
        killAtThisStep = true;
        killSwitchCount += 1;
        if (activeEpisode) activeEpisode.killSwitchDate = rows[d].date;
      } else if (entryEvent) {
        transitionCategory = 'l3_entry';
      } else if (exitEvent) {
        transitionCategory = 'l3_exit';
      }
    } else if (decideL2) {
      if (bl) {
        if (exposure === 0 && hedgeEntryClose !== null && rows[d].close >= hedgeEntryClose * BREAKER_MULT) breakerTripped = true;
        target = breakerTripped ? 1.0 : 0.0;
      } else {
        target = 1.0;
      }
      if (target !== exposure) transitionCategory = 'l2';
    }

    if (bl && exposure !== 0 && pendingBearSince === null && !overrideActive && !breakerTripped && l2Frequency !== 'none') pendingBearSince = i;
    if (target === 0 && exposure !== 0 && pendingBearSince !== null) {
      hedgeEntryDelays.push(i - pendingBearSince);
      pendingBearSince = null;
    }
    if (!bl) pendingBearSince = null;

    if (target !== exposure) {
      const feeRate = Math.abs(target - exposure) * FEE;
      const feeMult = 1 - feeRate;
      stack *= feeMult;
      overlayRatio *= feeMult;
      allFeeRate += feeRate;
      if (transitionCategory && transitionCategory.startsWith('l3_')) l3FeeRate += feeRate;
      feeEvents.push({ idx: i, date: rows[i].date, from: exposure, to: target, feeRate, category: transitionCategory || 'other' });
      if (entryEvent) entryEvent.feeRate = feeRate;
      if (exitEvent) exitEvent.feeRate = feeRate;
      switches += 1;
      if (target === 0) hedgeEntryClose = rows[d].close;
    } else {
      if (entryEvent) entryEvent.feeRate = 0;
      if (exitEvent) exitEvent.feeRate = 0;
    }

    const dailyReturn = rows[i].close / rows[i - 1].close - 1;
    exposure = target;
    const overlayMult = (1 + exposure * dailyReturn) / (1 + dailyReturn);
    stack *= overlayMult;
    overlayRatio *= overlayMult;
    if (exposure === 0) hedgeDays += 1;
    if (useL3 && overrideActive) overrideDays += 1;

    if (useL3 && overrideActive && activeEpisode) updateActiveClose(i);

    ratioPeak = Math.max(ratioPeak, overlayRatio);
    ratioMdd = Math.min(ratioMdd, overlayRatio / ratioPeak - 1);

    // --- L1 DCA buy: exact E6 Sunday cash flow. ---
    if (sunday && ahr !== null) {
      let spend = tierUsd(ahr);
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
    recordSnapshot(i, sunday, target);

    // Keep lint-visible use of this state marker in the event trail without
    // changing the E6 calculations.
    if (killAtThisStep && activeEpisode) activeEpisode.killSwitchDate = rows[d].date;
  }

  if (activeEpisode) finishActive(endIdx, 'sample_end');

  const days = Math.max(1, endIdx - startIdx + 1);
  return {
    stack,
    invested,
    ammo,
    switches,
    allFeeRate,
    l3FeeRate,
    feeBtcPaidPct: allFeeRate * 100,
    l3FeePaidPct: l3FeeRate * 100,
    hedgeDays,
    overrideDays,
    killSwitchCount,
    hedgeEntryDelays,
    hedgeEntries: hedgeEntryDelays.length,
    avgHedgeEntryDelay: hedgeEntryDelays.length ? hedgeEntryDelays.reduce((a, b) => a + b, 0) / hedgeEntryDelays.length : null,
    overlayRatioMddPct: ratioMdd * 100,
    days,
    events,
    entryEvents: events.filter((e) => e.type === 'entry'),
    exitEvents: events.filter((e) => e.type === 'exit'),
    feeEvents,
    activeEpisodes: completedEpisodes,
    snapshots,
  };
}

function idxAtOrAfter(rows, ts) {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].ts >= ts) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function maeSummary(activeEpisodes) {
  const values = activeEpisodes.map((e) => e.postEntryMaxDrawdownPct).filter(Number.isFinite);
  return {
    n: values.length,
    p50Pct: quantile(values, 0.50),
    p90Pct: quantile(values, 0.90),
    p95Pct: quantile(values, 0.95),
    maxPct: values.length ? Math.min(...values) : null,
    minPct: values.length ? Math.min(...values) : null,
    valuesPct: values,
  };
}

function linearOverlayMultiplier(rows, fromIdx, toIdx, exposure) {
  let mult = 1;
  for (let i = fromIdx + 1; i <= toIdx; i += 1) {
    const r = rows[i].close / rows[i - 1].close - 1;
    mult *= (1 + exposure * r) / (1 + r);
  }
  return mult;
}

function nextSundayIndex(rows, signalIdx, endIdx) {
  for (let i = signalIdx + 1; i <= endIdx; i += 1) {
    if (isSunday(rows[i])) return i;
  }
  return null;
}

function forwardHypothetical(rows, signalIdx, horizon) {
  const to = signalIdx + horizon;
  if (to >= rows.length) return { available: false, returnPct: null, overlayReturnPct: null };
  const priceReturn = rows[to].close / rows[signalIdx].close - 1;
  return {
    available: true,
    endDate: rows[to].date,
    priceReturnPct: priceReturn * 100,
    overlayReturnPct: (linearOverlayMultiplier(rows, signalIdx, to, OVERRIDE_LEV) - 1) * 100,
  };
}

function skippedWindows(rows, ind, episodes, episodeBySignalIdx, vaSim, vbSim, vcSim, startIdx, endIdx) {
  const vaEntry = new Map(vaSim.entryEvents.map((e) => [e.episodeId, e]));
  const dailyEntries = {
    'V-B': new Map(vbSim.entryEvents.map((e) => [e.episodeId, e])),
    'V-C': new Map(vcSim.entryEvents.map((e) => [e.episodeId, e])),
  };
  const out = [];
  for (const ep of episodes) {
    if (vaEntry.has(ep.id)) continue;
    const sundayIdx = nextSundayIndex(rows, ep.signalStartIdx, endIdx);
    if (sundayIdx === null) continue;
    const sundaySignalIdx = sundayIdx - 1;
    let recoveryIdx = null;
    for (let i = ep.signalStartIdx + 1; i <= sundaySignalIdx; i += 1) {
      if (ind.ahr[i] !== null && ind.ahr[i] >= 0.40) {
        recoveryIdx = i;
        break;
      }
    }
    // This question is specifically about AHR recovering before the Sunday
    // check. Do not label a dd-only failure as an AHR timing miss.
    if (recoveryIdx === null) continue;
    const firstDailyEvent = {};
    for (const [name, map] of Object.entries(dailyEntries)) firstDailyEvent[name] = map.get(ep.id) || null;
    out.push({
      episodeId: ep.id,
      signalStartDate: rows[ep.signalStartIdx].date,
      signalEndDate: rows[ep.signalEndIdx].date,
      hypotheticalEntrySignalDate: rows[ep.signalStartIdx].date,
      hypotheticalFirstAffectedDate: rows[ep.signalStartIdx + 1]?.date || null,
      hypotheticalEntryClose: rows[ep.signalStartIdx].close,
      nextSundayDecisionDate: rows[sundayIdx].date,
      nextSundaySignalDate: rows[sundaySignalIdx].date,
      ahrRecoveryDate: rows[recoveryIdx].date,
      ahrAtRecovery: ind.ahr[recoveryIdx],
      minAhr: ep.minAhr,
      dd365AtStart: ind.dd365[ep.signalStartIdx],
      return30d: forwardHypothetical(rows, ep.signalStartIdx, 30),
      return90d: forwardHypothetical(rows, ep.signalStartIdx, 90),
      dailyEntryEvents: Object.fromEntries(Object.entries(firstDailyEvent).map(([name, e]) => [name, e ? { signalDate: e.signalDate, affectedDate: e.affectedDate } : null])),
      note: 'V-A 未在周日执行；该条目仅列 AHR 在周日检查前回到 0.40 以上的窗口。',
    });
  }
  return out;
}

function eventMap(sim) {
  return new Map(sim.entryEvents.map((e) => [e.episodeId, e]));
}

function snapshotAt(sim, idx) {
  if (!sim.snapshots) return null;
  for (let i = Math.min(idx, sim.snapshots.length - 1); i >= 0; i -= 1) if (sim.snapshots[i]) return sim.snapshots[i];
  return null;
}

function earlyEntryCosts(rows, episodes, simulations) {
  const vaMap = eventMap(simulations['V-A']);
  const rowsByVariant = {};
  for (const name of ['V-B', 'V-C']) {
    const sim = simulations[name];
    const candMap = eventMap(sim);
    rowsByVariant[name] = episodes.map((ep) => {
      const cand = candMap.get(ep.id) || null;
      const va = vaMap.get(ep.id) || null;
      if (!cand && !va) return null;
      if (!cand) return {
        episodeId: ep.id,
        timing: 'V-A_ONLY',
        candidateEntry: null,
        vaEntry: { signalDate: va.signalDate, affectedDate: va.affectedDate, close: va.entryReferenceClose },
        extraDrawdownToVaPct: null,
        priceReturnToVaPct: null,
        overlayReturnToVaPct: null,
        extraFeeRateToVaBps: null,
        extraL3TransitionsToVa: null,
        note: '候选方案未在该 episode 入场。',
      };
      if (!va) return {
        episodeId: ep.id,
        timing: 'DAILY_ONLY',
        candidateEntry: { signalDate: cand.signalDate, affectedDate: cand.affectedDate, close: cand.entryReferenceClose },
        vaEntry: null,
        extraDrawdownToVaPct: null,
        priceReturnToVaPct: null,
        overlayReturnToVaPct: null,
        extraFeeRateToVaBps: null,
        extraL3TransitionsToVa: null,
        note: 'V-A 未入场；机会成本在错过窗口表中单列。',
      };

      const from = cand.signalIdx;
      const to = va.signalIdx;
      if (from >= to) return {
        episodeId: ep.id,
        timing: 'SAME_OR_LATER',
        candidateEntry: { signalDate: cand.signalDate, affectedDate: cand.affectedDate, close: cand.entryReferenceClose },
        vaEntry: { signalDate: va.signalDate, affectedDate: va.affectedDate, close: va.entryReferenceClose },
        extraDrawdownToVaPct: 0,
        priceReturnToVaPct: 0,
        overlayReturnToVaPct: 0,
        extraFeeRateToVaBps: 0,
        extraL3TransitionsToVa: 0,
        note: '没有提前入场区间。',
      };
      const minClose = Math.min(...rows.slice(from, to + 1).map((r) => r.close));
      const priceReturn = rows[to].close / rows[from].close - 1;
      const overlayReturn = linearOverlayMultiplier(rows, from, to, OVERRIDE_LEV) - 1;
      // Compare only the lead-in interval. Cumulative fees from previous
      // episodes would be a cross-episode contamination of this row.
      const intervalStart = from + 1;
      const intervalEnd = to + 1;
      const candIntervalFees = sim.feeEvents.filter((e) => e.category.startsWith('l3_') && e.idx >= intervalStart && e.idx <= intervalEnd);
      const vaIntervalFees = simulations['V-A'].feeEvents.filter((e) => e.category.startsWith('l3_') && e.idx >= intervalStart && e.idx <= intervalEnd);
      const candIntervalFeeRate = candIntervalFees.reduce((sum, e) => sum + e.feeRate, 0);
      const vaIntervalFeeRate = vaIntervalFees.reduce((sum, e) => sum + e.feeRate, 0);
      return {
        episodeId: ep.id,
        timing: 'DAILY_EARLY',
        candidateEntry: { signalDate: cand.signalDate, affectedDate: cand.affectedDate, close: cand.entryReferenceClose },
        vaEntry: { signalDate: va.signalDate, affectedDate: va.affectedDate, close: va.entryReferenceClose },
        daysEarly: to - from,
        minCloseDuringLeadIn: minClose,
        extraDrawdownToVaPct: (minClose / rows[from].close - 1) * 100,
        priceReturnToVaPct: priceReturn * 100,
        overlayReturnToVaPct: overlayReturn * 100,
        candidateL3FeeToVaBps: candIntervalFeeRate * 10000,
        vaL3FeeToVaBps: vaIntervalFeeRate * 10000,
        extraFeeRateToVaBps: (candIntervalFeeRate - vaIntervalFeeRate) * 10000,
        extraL3TransitionsToVa: candIntervalFees.length - vaIntervalFees.length,
        note: '负值是提前承担的损失；正值是提前暴露期间的收益，不代表稳定优势。',
      };
    }).filter(Boolean);
  }
  return rowsByVariant;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// E5-style paired episode bootstrap. Each episode contributes the final stack
// multiplier of an isolated L3 episode over the same L2+DCA baseline. We pair
// candidate and V-A contributions, sample canonical episodes with replacement,
// and compare the observed full-system endpoint ratio in the same units.
function pairedEpisodeBootstrap(episodes, episodeOnlyContributions, variantName, vaName = 'V-A') {
  if (!episodes.length) return { draws: BOOTSTRAP_DRAWS, seed: BOOTSTRAP_SEED, nEpisodes: 0, p10RelativePct: null, p50RelativePct: null, p90RelativePct: null, probNonPositive: null };
  const candidate = episodeOnlyContributions[variantName];
  const va = episodeOnlyContributions[vaName];
  const rand = mulberry32(BOOTSTRAP_SEED);
  const draws = new Array(BOOTSTRAP_DRAWS);
  for (let k = 0; k < BOOTSTRAP_DRAWS; k += 1) {
    let ratio = 1;
    for (let j = 0; j < episodes.length; j += 1) {
      const idx = Math.floor(rand() * episodes.length);
      const vaMult = va[idx] || 1;
      const candMult = candidate[idx] || 1;
      ratio *= candMult / vaMult;
    }
    draws[k] = ratio - 1;
  }
  draws.sort((a, b) => a - b);
  const q = (x) => draws[Math.min(draws.length - 1, Math.floor(draws.length * x))];
  return {
    draws: BOOTSTRAP_DRAWS,
    seed: BOOTSTRAP_SEED,
    nEpisodes: episodes.length,
    p10RelativePct: q(0.10) * 100,
    p50RelativePct: q(0.50) * 100,
    p90RelativePct: q(0.90) * 100,
    probNonPositive: draws.filter((v) => v <= 0).length / draws.length,
    episodeMultipliers: episodes.map((ep, i) => ({ episodeId: ep.id, candidateMultiplier: candidate[i], vaMultiplier: va[i], pairedRelativePct: (candidate[i] / va[i] - 1) * 100 })),
    method: 'E5-style paired resampling of canonical L3 episodes; isolated episode contributions, with replacement.',
  };
}

function inversePnlBtc(q, size, p0, p1) {
  return q * size * ((1 / p0) - (1 / p1));
}

function runE2Path({ leverage, drop, days, wick, maintRate, fundingRate, entryPrice, initialEquityBtc }) {
  const dailyFactor = Math.pow(1 - drop, 1 / days);
  let equity = initialEquityBtc;
  let price = entryPrice;
  let contracts = 0;
  let minHeadroom = Infinity;
  let minHeadroomDay = null;
  let liquidated = false;
  let liquidationDay = null;
  let totalFundingBtc = 0;

  for (let day = 0; day <= days; day += 1) {
    const open = price;
    if (day % 7 === 0 && !liquidated) {
      const overlayBtc = (leverage - 1) * equity;
      contracts = Math.round((overlayBtc * open) / CONTRACT_SIZE_USD);
    }
    const close = day === 0 ? open : open * dailyFactor;
    const low = close * (1 - wick);
    for (let event = 0; event < E2_FUNDING_EVENTS_PER_DAY; event += 1) {
      const pnl = -(contracts * CONTRACT_SIZE_USD / close) * fundingRate;
      equity += pnl;
      totalFundingBtc += pnl;
    }
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
    entryPrice,
    endingEquityBtc: equity,
    equityLossPct: (1 - equity / initialEquityBtc) * 100,
    totalFundingBtc,
    minHeadroom,
    minHeadroomDay,
    liquidated,
    liquidationDay,
  };
}

function e2Grid(entryPrice = E2_BASE_ENTRY_PRICE, initialEquityBtc = E2_BASE_EQUITY_BTC, onlyLeverage = null) {
  const runs = [];
  const leverages = onlyLeverage === null ? E2_LEVERAGES : [onlyLeverage];
  for (const leverage of leverages) {
    for (const drop of E2_DROPS) {
      for (const days of E2_DURATIONS_DAYS) {
        for (const wick of E2_WICKS) {
          for (const maintRate of E2_MAINT_RATES) {
            for (const fundingRate of E2_FUNDING_RATES) {
              runs.push(runE2Path({ leverage, drop, days, wick, maintRate, fundingRate, entryPrice, initialEquityBtc }));
            }
          }
        }
      }
    }
  }
  const acceptance = runs.filter((r) => r.maintRatePct === 10 && r.wickPct === 20 && r.fundingPerEvent === 0.003);
  return { runs, acceptance };
}

function summarizeE2Base() {
  const grid = e2Grid();
  const byLeverage = E2_LEVERAGES.map((leverage) => {
    const all = grid.runs.filter((r) => r.leverage === leverage);
    const acceptance = grid.acceptance.filter((r) => r.leverage === leverage);
    return {
      leverage,
      worstMinHeadroomFullGrid: Math.min(...all.map((r) => r.minHeadroom)),
      worstMinHeadroomAcceptanceSlice: Math.min(...acceptance.map((r) => r.minHeadroom)),
      liquidatedAnywhereFullGrid: all.some((r) => r.liquidated),
      liquidatedInAcceptanceSlice: acceptance.some((r) => r.liquidated),
      passes3xHeadroom: Math.min(...acceptance.map((r) => r.minHeadroom)) >= 3,
    };
  });
  return {
    entryPrice: E2_BASE_ENTRY_PRICE,
    initialEquityBtc: E2_BASE_EQUITY_BTC,
    acceptanceRule: '10% maintenance, 20% wick, 0.003 funding/event; no liquidation and min headroom >= 3x',
    byLeverage,
    recommendedCap: Math.max(...byLeverage.filter((r) => r.passes3xHeadroom).map((r) => r.leverage)),
  };
}

function summarizeE2ForVariant(sim) {
  const entryRuns = [];
  for (const entry of sim.entryEvents) {
    // Preserve the E2 reference notional (300 contracts at 60,000 USD) while
    // changing the historical entry price. This prevents one-contract
    // rounding at low BTC prices from masquerading as leverage risk.
    const normalizedInitialEquityBtc = E2_BASE_EQUITY_BTC * E2_BASE_ENTRY_PRICE / entry.entryReferenceClose;
    const grid = e2Grid(entry.entryReferenceClose, normalizedInitialEquityBtc, 1.5);
    entryRuns.push({
      episodeId: entry.episodeId,
      entrySignalDate: entry.signalDate,
      entryReferenceClose: entry.entryReferenceClose,
      normalizedInitialEquityBtc,
      normalization: 'same E2 target notional as reference path; avoids discrete-contract rounding artifact',
      acceptanceRuns: grid.acceptance,
      minHeadroomAcceptanceSlice: Math.min(...grid.acceptance.map((r) => r.minHeadroom)),
      liquidatedInAcceptanceSlice: grid.acceptance.some((r) => r.liquidated),
    });
  }
  return {
    nEntries: entryRuns.length,
    minHeadroomAcrossEntries: entryRuns.length ? Math.min(...entryRuns.map((r) => r.minHeadroomAcceptanceSlice)) : null,
    liquidatedAcrossEntries: entryRuns.some((r) => r.liquidatedInAcceptanceSlice),
    passes3xAcrossEntries: entryRuns.length > 0 && entryRuns.every((r) => !r.liquidatedInAcceptanceSlice && r.minHeadroomAcceptanceSlice >= 3),
    entryRuns,
  };
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmtPct(value, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value) ? 'UNAVAILABLE' : `${value.toFixed(digits)}%`;
}

function fmtNum(value, digits = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? 'UNAVAILABLE' : value.toFixed(digits);
}

function renderReport(out) {
  const p = out.primaryComparison;
  const va = p.find((r) => r.variant === 'V-A');
  const lines = [];
  lines.push('# E7：BTC V4 深水区 override 入场/校准频率消融实验');
  lines.push('');
  lines.push('> 研究用途；不改生产 cron、不改 Forward Test ledger、不改冻结参数；最终结论等待人工裁决。深水区 episode 样本为个位数，以下均为方向性证据。');
  lines.push('');
  lines.push(`运行时间：${out.generatedAt}；预注册：${out.preregistration.commits.join(', ')}；证据基线：${out.preregistration.evidenceTag} / ${out.preregistration.evidenceCommit}`);
  lines.push('');
  lines.push('## 结论先行');
  lines.push('');
  lines.push(`**${out.conclusion.status}**`);
  lines.push('');
  lines.push(out.conclusion.text);
  lines.push('');
  lines.push(`本报告的裁决状态：${out.conclusion.humanDecision}。`);
  lines.push('');
  lines.push('## 共同口径');
  lines.push('');
  lines.push(`- 数据：Coin Metrics Community API，${out.data.priceWindow.start} 至 ${out.data.priceWindow.end}，${out.data.priceWindow.observations} 个连续日点；模拟从 ${out.data.simStart} 开始。`);
  lines.push('- 三组均为 E6 含 DCA 现金流全系统；唯一变量是 L3 入场/校准频率。L2 每日，1.5x 上限，0.40/0.45 滞后，dd365<=-20% 确认，182 天安全开关，10 bps 费用。');
  lines.push('- 时间约定：T-1 收盘计算信号，目标暴露作用于 T-1→T 收益；报告同时列信号日和首个受影响收益日。');
  lines.push('');
  lines.push('## 主结果：同一现金流、同一历史窗口');
  lines.push('');
  lines.push('| 变体 | 最终系统 BTC | 相对纯 DCA 超额 | 相对 V-A 终值 | L3 入场次数 | L3 活跃天数 | 总费用率 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const row of p) lines.push(`| ${row.variant} | ${fmtNum(row.systemBtc, 2)} | ${fmtPct(row.excessBtcPct)} | ${row.variant === 'V-A' ? '—' : fmtPct(row.relativeFinalBtcVsVaPct)} | ${row.l3Entries} | ${row.overrideDays} | ${fmtPct(row.feePaidPctOfStack)} |`);
  lines.push('');
  lines.push(`V-A 基准：${fmtNum(va.systemBtc, 2)} BTC；相对纯 DCA 超额 ${fmtPct(va.excessBtcPct)}。相对 V-A 的“终值差”与超额百分点差同时保存在 result.json，避免只看一个口径。`);
  lines.push('');
  lines.push('固定窗口稳健性检查：');
  lines.push('');
  lines.push('| 窗口 | V-A 超额 | V-B 超额 | V-C 超额 |');
  lines.push('|---|---:|---:|---:|');
  for (const w of out.windowComparison) lines.push(`| ${w.window} | ${fmtPct(w['V-A'])} | ${fmtPct(w['V-B'])} | ${fmtPct(w['V-C'])} |`);
  lines.push('');

  lines.push('## (a) V-A 错过的入场窗口');
  lines.push('');
  lines.push('定义是：共同入场门曾成立，AHR999 在下一个周日检查前回到 0.40 以上，且 V-A 没有入场；不是把 dd365 单独失效的 episode 也算进来。');
  lines.push('');
  if (!out.skippedEntryWindows.length) {
    lines.push('未发现符合该严格定义的窗口。该结果不等于周日方案已被证明更优。');
  } else {
    lines.push('| Episode | 首次信号 | AHR 回到≥0.40 | 周日检查 | 最低 AHR | 30d 价格/1.5x | 90d 价格/1.5x |');
    lines.push('|---|---|---|---|---:|---:|---:|');
    for (const w of out.skippedEntryWindows) lines.push(`| ${w.episodeId} | ${w.hypotheticalEntrySignalDate} | ${w.ahrRecoveryDate} | ${w.nextSundayDecisionDate} | ${fmtNum(w.minAhr, 3)} | ${fmtPct(w.return30d.priceReturnPct)} / ${fmtPct(w.return30d.overlayReturnPct)} | ${fmtPct(w.return90d.priceReturnPct)} / ${fmtPct(w.return90d.overlayReturnPct)} |`);
  }
  lines.push('');
  lines.push('30/90 日列同时给出 BTC 价格收益和不含 DCA/资金费的线性 1.5x 暴露收益；数据不够时写 UNAVAILABLE。');
  lines.push('');

  lines.push('## (b) 提前入场的损失与机会成本');
  lines.push('');
  lines.push('负的“提前区间回撤/1.5x 区间收益”代表提前承担的损失；V-A 没入场的 episode 则列为每日方案的机会成本。E6 没有同一目标暴露下的日内补仓订单，因此费用列只统计实际额外 L3 暴露变动，不把价格损益冒充补仓成本。');
  lines.push('');
  for (const name of ['V-B', 'V-C']) {
    lines.push(`### ${name}`);
    lines.push('');
    lines.push('| Episode | 时序 | 每日方案信号→V-A信号 | 区间最大回撤 | 价格收益 | 1.5x 暴露收益 | 额外费用(bps) | 额外 L3 变动 |');
    lines.push('|---|---|---|---:|---:|---:|---:|---:|');
    for (const r of out.earlyEntryCosts[name]) {
      const timing = r.timing;
      const dates = `${r.candidateEntry?.signalDate || '—'} → ${r.vaEntry?.signalDate || '—'}`;
      lines.push(`| ${r.episodeId} | ${timing} | ${dates} | ${fmtPct(r.extraDrawdownToVaPct)} | ${fmtPct(r.priceReturnToVaPct)} | ${fmtPct(r.overlayReturnToVaPct)} | ${fmtNum(r.extraFeeRateToVaBps, 2)} | ${r.extraL3TransitionsToVa ?? 'UNAVAILABLE'} |`);
    }
    if (!out.earlyEntryCosts[name].length) lines.push('| — | 无共同入场 episode | — | — | — | — | — | — |');
    lines.push('');
  }

  lines.push('## (c) Episode 级 leave-one-out');
  lines.push('');
  lines.push('每次删除同一个 episode 在候选和 V-A 中的 L3 入场，再跑完整 DCA+L2 系统；这样检查结论是否被单一历史事件支撑。');
  lines.push('');
  lines.push('| 候选 | 全样本相对 V-A | LOO 后同方向次数 | 翻转次数 | 是否依赖单一事件 |');
  lines.push('|---|---:|---:|---:|---|');
  for (const row of out.leaveOneOut.summary) lines.push(`| ${row.variant} | ${fmtPct(row.fullRelativeFinalBtcVsVaPct)} | ${row.nEpisodes - row.flipCount}/${row.nEpisodes} | ${row.flipCount} | ${row.flipCount > 0 ? '是' : '否'} |`);
  lines.push('');
  lines.push('| 候选 | Episode | 删除后相对 V-A | 是否翻转 |');
  lines.push('|---|---|---:|---|');
  for (const row of out.leaveOneOut.rows) lines.push(`| ${row.variant} | ${row.episodeId} | ${fmtPct(row.looRelativeFinalBtcVsVaPct)} | ${row.flipped ? '是' : '否'} |`);
  lines.push('');

  lines.push('## (d) 入场后最大跌幅与 E2 压力');
  lines.push('');
  lines.push('最大跌幅按日收盘、从 L3 入场参考价计算；这是市场价格回撤，不等于合约账户权益回撤。');
  lines.push('');
  lines.push('| 变体 | n | P50 | P90 | P95 | 最深 | 相对 V-A 尾部 |');
  lines.push('|---|---:|---:|---:|---:|---:|---|');
  for (const [name, row] of Object.entries(out.postEntryMae)) lines.push(`| ${name} | ${row.n} | ${fmtPct(row.p50Pct)} | ${fmtPct(row.p90Pct)} | ${fmtPct(row.p95Pct)} | ${fmtPct(row.minPct)} | ${name === 'V-A' ? '—' : (row.tailDeeperVsVa ? '最深值更深' : '不更深')} |`);
  lines.push('');
  lines.push(`E2 基准压力验收切片（10% 维持保证金、20% wick、高资金费率）中，1.5x 最小余量为 ${fmtNum(out.e2Stress.base.byLeverage.find((r) => r.leverage === 1.5).worstMinHeadroomAcceptanceSlice, 3)}x；无爆仓，达到 ≥3x。`);
  lines.push('');
  lines.push('| 变体 | 入场事件数 | 对应 E2 压力最小余量 | 验收切片爆仓 | ≥3x 且无爆仓 |');
  lines.push('|---|---:|---:|---|---|');
  for (const [name, row] of Object.entries(out.e2Stress.byVariant)) lines.push(`| ${name} | ${row.nEntries} | ${fmtNum(row.minHeadroomAcrossEntries, 3)}x | ${row.liquidatedAcrossEntries ? '是' : '否'} | ${row.passes3xAcrossEntries ? '是' : '否'} |`);
  lines.push('');
  lines.push('由于 V-B/V-C 的最深历史回撤更深，已按每个历史入场价补跑 E2 路径；初始保证金按 BTC 数量缩放，以保持与 E2 参考路径相同的目标名义规模，避免低价时期的离散合约取整伪影。路径沿用 40/50/60% 单向下跌、14/56/182 日、wick、资金费率和每周校准；这是压力覆盖，不是对真实未来路径的概率预测。');
  lines.push('');

  lines.push('## 统计晋级判据');
  lines.push('');
  lines.push('| 候选 | 实测相对 V-A 终值差 | bootstrap P10–P90 | 超过 P90 | LOO 不翻转 | E2 清偿力不侵蚀 | 全部通过 |');
  lines.push('|---|---:|---:|---|---|---|---|');
  for (const row of out.acceptance) lines.push(`| ${row.variant} | ${fmtPct(row.observedRelativeFinalBtcVsVaPct)} | ${fmtPct(row.bootstrap.p10RelativePct)} 至 ${fmtPct(row.bootstrap.p90RelativePct)} | ${row.passBootstrap ? '是' : '否'} | ${row.passLeaveOneOut ? '是' : '否'} | ${row.passSolvency ? '是' : '否'} | ${row.passAll ? '是' : '否'} |`);
  lines.push('');
  lines.push('bootstrap 固定为 E5 同款 10,000 次、有放回、seed=20260831；E7 将候选/V-A 的 canonical episode isolated contribution 做配对抽样，故它是 E5-style paired extension，不冒充独立同分布的精确置信区间。');
  lines.push('');
  lines.push('## 局限和人工裁决');
  lines.push('');
  lines.push('- episode 只有个位数，LOO 和 bootstrap 的统计力量有限，结论只能是方向性证据。');
  lines.push('- E6 是 BTC 单位线性暴露近似，不含资金费、inverse convexity、wick；清偿力由 E2 合成压力补足。');
  lines.push('- E2 压力假设是单向合成跌幅，不代表历史跌幅发生概率；经验 MAE 更深时已明确列出并重跑对应压力。');
  lines.push('- 报告同时呈现提前入场的损失与周日错过的机会成本，不能用任何单边叙事替代比较。');
  lines.push('');
  lines.push(`最终规则：${out.conclusion.text}`);
  lines.push('');
  lines.push('技术明细见同目录 `btc-v4-e7-l3-frequency-result.json`。');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { rows, manifest } = loadPrices();
  const ref = await loadReferenceAhr();
  const harmonic = computeIndicators(rows, 'harmonic');
  const geometric = computeIndicators(rows, 'geometric');
  const harmonicValidation = validateAhr(rows, harmonic, ref.map);
  const geometricValidation = validateAhr(rows, geometric, ref.map);
  // E6 selected geometric; keep that choice fixed for E7 and audit both.
  const ind = geometric;
  const ahrValidation = { selected: 'geometric', harmonic: harmonicValidation, geometric: geometricValidation, reference: { url: AHR_URL, sha256: ref.sha256, observations: ref.observations } };
  if (geometricValidation.medianAbsRelErr === null || geometricValidation.medianAbsRelErr > 0.05) throw new Error(`AHR replication failed E6 validation: ${JSON.stringify(ahrValidation)}`);

  const simStart = 400;
  const endIdx = rows.length - 1;
  const { episodes, bySignalIdx: episodeBySignalIdx } = buildEpisodes(rows, ind, simStart, endIdx);
  const baseFull = simulateDca(rows, ind, episodeBySignalIdx, simStart, endIdx, { l2Frequency: 'none', useL3: false });
  const simulations = {};
  for (const [name, def] of Object.entries(VARIANTS)) {
    simulations[name] = simulateDca(rows, ind, episodeBySignalIdx, simStart, endIdx, {
      l2Frequency: 'daily',
      useL3: true,
      entryFrequency: def.entryFrequency,
      calibrationFrequency: def.calibrationFrequency,
    });
  }

  const primaryComparison = Object.entries(VARIANTS).map(([name, def]) => {
    const sim = simulations[name];
    const excess = (sim.stack / baseFull.stack - 1) * 100;
    const va = simulations['V-A'];
    return {
      variant: name,
      description: def.description,
      systemBtc: sim.stack,
      pureDcaBtc: baseFull.stack,
      investedUsd: baseFull.invested,
      excessBtcPct: excess,
      relativeFinalBtcVsVaPct: name === 'V-A' ? 0 : (sim.stack / va.stack - 1) * 100,
      excessBtcPointDeltaVsVa: name === 'V-A' ? 0 : excess - ((va.stack / baseFull.stack - 1) * 100),
      switches: sim.switches,
      l3Entries: sim.entryEvents.length,
      feePaidPctOfStack: sim.feeBtcPaidPct,
      l3FeePaidPct: sim.l3FeePaidPct,
      hedgeDays: sim.hedgeDays,
      overrideDays: sim.overrideDays,
      killSwitchCount: sim.killSwitchCount,
      hedgeEntries: sim.hedgeEntries,
      avgHedgeEntryDelayDays: sim.avgHedgeEntryDelay,
      overlayRatioMddPct: sim.overlayRatioMddPct,
    };
  });

  const windows = [1, 3, 5, 10, 99];
  const windowComparison = [];
  for (const years of windows) {
    const ts = years === 99 ? rows[simStart].ts : rows[endIdx].ts - years * 365.25 * 86400000;
    const i0 = Math.max(idxAtOrAfter(rows, ts), simStart);
    if (i0 >= endIdx) {
      windowComparison.push({ window: years === 99 ? 'full' : `${years}y`, available: false, 'V-A': null, 'V-B': null, 'V-C': null });
      continue;
    }
    const base = simulateDca(rows, ind, episodeBySignalIdx, i0, endIdx, { l2Frequency: 'none', useL3: false });
    const row = { window: years === 99 ? 'full' : `${years}y`, available: true };
    for (const name of Object.keys(VARIANTS)) {
      const def = VARIANTS[name];
      const sim = simulateDca(rows, ind, episodeBySignalIdx, i0, endIdx, { l2Frequency: 'daily', useL3: true, entryFrequency: def.entryFrequency, calibrationFrequency: def.calibrationFrequency });
      row[name] = (sim.stack / base.stack - 1) * 100;
      row[`${name}SystemBtc`] = sim.stack;
    }
    row.investedUsd = base.invested;
    windowComparison.push(row);
  }

  const skipped = skippedWindows(rows, ind, episodes, episodeBySignalIdx, simulations['V-A'], simulations['V-B'], simulations['V-C'], simStart, endIdx);
  const earlyCosts = earlyEntryCosts(rows, episodes, simulations);
  const postEntryMae = Object.fromEntries(Object.entries(simulations).map(([name, sim]) => [name, maeSummary(sim.activeEpisodes)]));
  for (const name of ['V-B', 'V-C']) postEntryMae[name].tailDeeperVsVa = postEntryMae[name].minPct < postEntryMae['V-A'].minPct;

  // Episode-level LOO: remove the same canonical episode from candidate and V-A.
  const looRows = [];
  for (const name of ['V-B', 'V-C']) {
    const def = VARIANTS[name];
    for (const ep of episodes) {
      const candidateLoo = simulateDca(rows, ind, episodeBySignalIdx, simStart, endIdx, { l2Frequency: 'daily', useL3: true, entryFrequency: def.entryFrequency, calibrationFrequency: def.calibrationFrequency, skipEpisodeIds: new Set([ep.id]) });
      const vaDef = VARIANTS['V-A'];
      const vaLoo = simulateDca(rows, ind, episodeBySignalIdx, simStart, endIdx, { l2Frequency: 'daily', useL3: true, entryFrequency: vaDef.entryFrequency, calibrationFrequency: vaDef.calibrationFrequency, skipEpisodeIds: new Set([ep.id]) });
      const relative = (candidateLoo.stack / vaLoo.stack - 1) * 100;
      const fullRelative = (simulations[name].stack / simulations['V-A'].stack - 1) * 100;
      const flipped = (fullRelative > 0 && relative <= 0) || (fullRelative < 0 && relative >= 0);
      looRows.push({ variant: name, episodeId: ep.id, looRelativeFinalBtcVsVaPct: relative, fullRelativeFinalBtcVsVaPct: fullRelative, flipped });
    }
  }
  const looSummary = ['V-B', 'V-C'].map((name) => {
    const rowsForVariant = looRows.filter((r) => r.variant === name);
    return { variant: name, nEpisodes: rowsForVariant.length, fullRelativeFinalBtcVsVaPct: rowsForVariant[0]?.fullRelativeFinalBtcVsVaPct ?? null, positiveCount: rowsForVariant.filter((r) => r.looRelativeFinalBtcVsVaPct > 0).length, flipCount: rowsForVariant.filter((r) => r.flipped).length };
  });

  // E5-style isolated episode contributions, with the same L2+DCA baseline.
  const l2Only = simulateDca(rows, ind, episodeBySignalIdx, simStart, endIdx, { l2Frequency: 'daily', useL3: false });
  const episodeOnlyContributions = {};
  for (const [name, def] of Object.entries(VARIANTS)) {
    episodeOnlyContributions[name] = [];
    for (const ep of episodes) {
      const only = simulateDca(rows, ind, episodeBySignalIdx, simStart, endIdx, { l2Frequency: 'daily', useL3: true, entryFrequency: def.entryFrequency, calibrationFrequency: def.calibrationFrequency, onlyEpisodeIds: new Set([ep.id]), captureSnapshots: false });
      episodeOnlyContributions[name].push(only.stack / l2Only.stack);
    }
  }
  const bootstrap = {
    'V-B': pairedEpisodeBootstrap(episodes, episodeOnlyContributions, 'V-B'),
    'V-C': pairedEpisodeBootstrap(episodes, episodeOnlyContributions, 'V-C'),
  };

  const e2Base = summarizeE2Base();
  const e2ByVariant = Object.fromEntries(Object.entries(simulations).map(([name, sim]) => [name, summarizeE2ForVariant(sim)]));
  const vaE2 = e2ByVariant['V-A'];
  const acceptance = ['V-B', 'V-C'].map((name) => {
    const primary = primaryComparison.find((r) => r.variant === name);
    const boot = bootstrap[name];
    const loo = looSummary.find((r) => r.variant === name);
    const e2 = e2ByVariant[name];
    const passBootstrap = primary.relativeFinalBtcVsVaPct > boot.p90RelativePct && primary.relativeFinalBtcVsVaPct > 0;
    const passLeaveOneOut = loo.flipCount === 0;
    const passSolvency = e2.passes3xAcrossEntries && vaE2.passes3xAcrossEntries && e2.minHeadroomAcrossEntries >= vaE2.minHeadroomAcrossEntries;
    return { variant: name, observedRelativeFinalBtcVsVaPct: primary.relativeFinalBtcVsVaPct, observedExcessBtcPointDeltaVsVa: primary.excessBtcPointDeltaVsVa, bootstrap: boot, passBootstrap, passLeaveOneOut, passSolvency, passAll: passBootstrap && passLeaveOneOut && passSolvency };
  });
  const passing = acceptance.filter((r) => r.passAll).map((r) => r.variant);
  const conclusion = passing.length ? {
    status: `候选 ${passing.join('、')} 同时通过预注册三项门槛，但证据仍为方向性`,
    humanDecision: '待人工裁决，不自动替换 V-A',
    text: `按预注册口径，${passing.join('、')} 的实测相对 V-A 终值差超过 bootstrap P90、LOO 未翻转且 E2 清偿力未被侵蚀；这只说明它们获得了方向性支持，不构成自动改规则授权。`,
  } : {
    status: '维持 V-A（现行周日入场 / 周日校准）',
    humanDecision: '待人工裁决，不自动替换 V-A',
    text: '维持 V-A 的理由是证据不足，不是周日方案已被证明更优。至少一个候选未同时通过超额差、leave-one-out 和 E2 清偿力三项门槛。',
  };

  const out = {
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    productionChanged: false,
    researchVersion: 'btc-v4-e7-l3-frequency-v1',
    preregistration: { criteriaFile: 'research/btc-v4-e7-l3-frequency-criteria.md', commits: PREREG_COMMITS, evidenceTag: EVIDENCE_TAG, evidenceCommit: EVIDENCE_COMMIT, codeCommitAtRun: gitMeta().commit, scriptDirtyAtRun: gitMeta().scriptDirtyAtRun },
    data: { priceSource: manifest, priceWindow: { start: rows[0].date, end: rows[endIdx].date, observations: rows.length }, simStart: rows[simStart].date, ahrSource: { url: AHR_URL, sha256: ref.sha256, observations: ref.observations } },
    engine: {
      name: 'E6 DCA full-system engine with L3 frequency ablation',
      sourceMechanics: 'scripts/btc-v4-e6-dca-fullsystem.js',
      l2Frequency: 'daily',
      dca: { weeklyBudgetUsd: WEEKLY_BUDGET, tiers: TIERS.map((t) => ({ below: Number.isFinite(t.max) ? t.max : null, usd: t.usd })), ammoPool: true, buyDay: 'Sunday', feeBps: 10 },
      commonRules: { entryGate: 'AHR999 < 0.40 AND dd365 <= -0.20', overrideLeverageCap: 1.5, exitAhr: 0.45, killDays: 182, signal: 'T-1 close', handback: 'immediate L2 result' },
      variants: VARIANTS,
      caveats: ['Linear daily overlay in BTC terms; no funding, inverse convexity, or wicks.', 'Solvency/liquidation is assessed separately with the E2 synthetic engine.', 'E5-style paired episode bootstrap is an evidence band, not a formal iid confidence interval.'],
    },
    ahrValidation,
    episodeInventory: episodes,
    primaryComparison,
    windowComparison,
    skippedEntryWindows: skipped,
    earlyEntryCosts: earlyCosts,
    postEntryMae,
    postEntryMaeEpisodes: Object.fromEntries(Object.entries(simulations).map(([name, sim]) => [name, sim.activeEpisodes.map((e) => ({ episodeId: e.episodeId, entrySignalDate: e.entrySignalDate, entryReferenceClose: e.entryReferenceClose, firstAffectedReturnDate: e.firstAffectedReturnDate, endDate: e.endDate, endReason: e.endReason, durationDays: e.durationDays, postEntryMaxDrawdownPct: e.postEntryMaxDrawdownPct, minClose: e.minClose, minCloseDate: rows[e.minCloseIdx].date, killSwitchDate: e.killSwitchDate }))])),
    leaveOneOut: { summary: looSummary, rows: looRows },
    episodeOnlyContributions: Object.fromEntries(Object.entries(episodeOnlyContributions).map(([name, values]) => [name, values.map((value, i) => ({ episodeId: episodes[i].id, multiplier: value }))])),
    e5StylePairedBootstrap: bootstrap,
    e2Stress: { base: e2Base, byVariant: e2ByVariant },
    acceptance,
    conclusion,
    limitations: ['深水区 episode 样本为个位数，结论为方向性证据。', '所有变体使用相同现金流、数据窗口、L2 每日规则和 1.5x 上限。', '提前入场损失和周日机会成本并列报告，禁止单边叙事。'],
  };

  const researchDir = path.join(__dirname, '..', 'research');
  fs.mkdirSync(researchDir, { recursive: true });
  const resultFile = path.join(researchDir, 'btc-v4-e7-l3-frequency-result.json');
  const reportFile = path.join(researchDir, 'btc-v4-e7-l3-frequency-report.md');
  fs.writeFileSync(resultFile, JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(reportFile, renderReport(out));
  console.log(JSON.stringify({
    generatedAt: out.generatedAt,
    data: out.data.priceWindow,
    ahrValidation: out.ahrValidation,
    episodes: episodes.length,
    primary: out.primaryComparison.map((r) => ({ variant: r.variant, systemBtc: round(r.systemBtc, 2), excessBtcPct: round(r.excessBtcPct, 2), relativeFinalBtcVsVaPct: round(r.relativeFinalBtcVsVaPct, 2), l3Entries: r.l3Entries })),
    skippedWindows: skipped.length,
    mae: Object.fromEntries(Object.entries(postEntryMae).map(([name, r]) => [name, { n: r.n, p50Pct: round(r.p50Pct, 2), p90Pct: round(r.p90Pct, 2), p95Pct: round(r.p95Pct, 2), minPct: round(r.minPct, 2) }])),
    bootstrap: Object.fromEntries(Object.entries(bootstrap).map(([name, r]) => [name, { p10RelativePct: round(r.p10RelativePct, 2), p50RelativePct: round(r.p50RelativePct, 2), p90RelativePct: round(r.p90RelativePct, 2), probNonPositive: round(r.probNonPositive, 4) }])),
    acceptance: out.acceptance.map((r) => ({ variant: r.variant, observedRelativeFinalBtcVsVaPct: round(r.observedRelativeFinalBtcVsVaPct, 2), passBootstrap: r.passBootstrap, passLeaveOneOut: r.passLeaveOneOut, passSolvency: r.passSolvency, passAll: r.passAll })),
    conclusion: out.conclusion,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
