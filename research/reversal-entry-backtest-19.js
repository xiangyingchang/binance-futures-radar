'use strict';

const { analyzeReversal } = require('../lib/strategy');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOTIONAL = 1000;
const FEE_RATE = 0.0005;
const STOP_PCT = 0.30;
const TP_PCT = 0.20;
const HOLD_HOURS = 72;
const TRIGGER_WAIT_HOURS = 48;
const PRELOAD_HOURS = 96;

// The 19 mature v6-style signals used in the prior TP-exit research.
// Evaluation time is local midnight (+08:00), matching the prior research convention.
const SIGNALS = [
  ['ORDIUSDT', '2026-04-17'],
  ['HUMAUSDT', '2026-04-24'],
  ['BUSDT', '2026-05-03'],
  ['LABUSDT', '2026-05-03'],
  ['AKTUSDT', '2026-05-10'],
  ['RIFUSDT', '2026-05-13'],
  ['USELESSUSDT', '2026-05-13'],
  ['KITEUSDT', '2026-05-14'],
  ['BEATUSDT', '2026-06-08'],
  ['BEATUSDT', '2026-06-12'],
  ['MMTUSDT', '2026-06-23'],
  ['TRBUSDT', '2026-07-07'],
  ['DEXEUSDT', '2026-07-13'],
  ['BANKUSDT', '2026-07-17'],
  ['BANKUSDT', '2026-07-20'],
  ['SOONUSDT', '2026-07-29'],
  ['TUTUSDT', '2026-08-10'],
  ['CYSUSDT', '2026-08-12'],
  ['SQDUSDT', '2026-08-12'],
].map(([symbol, date]) => ({ symbol, date, evalTime: Date.parse(`${date}T00:00:00+08:00`) }));

const BASES = [
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJson(path, params = {}) {
  const errors = [];
  for (const base of BASES) {
    const url = new URL(path, base);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'binance-radar-reversal-research/1.0' },
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${base} HTTP ${res.status}: ${text.slice(0, 160)}`);
        return JSON.parse(text);
      } catch (error) {
        errors.push(error.message || String(error));
        if (attempt < 2) await sleep(300);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(errors.join(' | '));
}

function parseKlines(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
    closeTime: Number(r[6]), quoteVolume: Number(r[7]),
  })).filter((c) => Number.isFinite(c.close));
}

async function loadSignalData(signal) {
  const start = signal.evalTime - PRELOAD_HOURS * HOUR;
  const end = signal.evalTime + (TRIGGER_WAIT_HOURS + HOLD_HOURS + 8) * HOUR;
  const fundingStart = signal.evalTime - DAY;
  const [h1, h4, funding] = await Promise.all([
    fetchJson('/fapi/v1/klines', { symbol: signal.symbol, interval: '1h', startTime: start, endTime: end, limit: 1000 }),
    fetchJson('/fapi/v1/klines', { symbol: signal.symbol, interval: '4h', startTime: start - 4 * DAY, endTime: end, limit: 1000 }),
    fetchJson('/fapi/v1/fundingRate', { symbol: signal.symbol, startTime: fundingStart, endTime: end, limit: 1000 }),
  ]);
  return { hourly: parseKlines(h1), fourHour: parseKlines(h4), funding: Array.isArray(funding) ? funding : [] };
}

function nextEntry(hourly, ts) {
  const c = hourly.find((x) => x.openTime >= ts);
  return c ? { price: c.open, time: c.openTime } : null;
}

function fundingPnlShort(fundingRows, hourly, entry, exit) {
  let pnl = 0;
  for (const row of fundingRows) {
    const t = Number(row?.fundingTime);
    const rate = Number(row?.fundingRate);
    if (!Number.isFinite(t) || !Number.isFinite(rate) || t <= entry.time || t > exit.time) continue;
    const ref = [...hourly].reverse().find((c) => c.closeTime <= t)?.close || entry.price;
    pnl += (NOTIONAL / entry.price) * ref * rate;
  }
  return pnl;
}

function simulate(hourly, fundingRows, triggerTime) {
  const entry = nextEntry(hourly, triggerTime);
  if (!entry || !Number.isFinite(entry.price) || entry.price <= 0) return null;
  const stop = entry.price * (1 + STOP_PCT);
  const tp = entry.price * (1 - TP_PCT);
  const deadline = entry.time + HOLD_HOURS * HOUR;
  const candles = hourly.filter((c) => c.openTime >= entry.time && c.openTime < deadline);
  if (!candles.length) return null;

  let maxHigh = entry.price;
  let minLow = entry.price;
  let exit = null;
  for (const c of candles) {
    maxHigh = Math.max(maxHigh, c.high);
    minLow = Math.min(minLow, c.low);
    // Conservative same-candle ordering: stop first.
    if (c.high >= stop) {
      exit = { price: stop, time: c.closeTime, reason: 'stop30' };
      break;
    }
    if (c.low <= tp) {
      exit = { price: tp, time: c.closeTime, reason: 'tp20' };
      break;
    }
  }
  if (!exit) {
    const final = [...hourly].reverse().find((c) => c.closeTime <= deadline && c.openTime >= entry.time);
    if (!final) return null;
    exit = { price: final.close, time: final.closeTime, reason: '72h' };
  }

  const qty = NOTIONAL / entry.price;
  const gross = qty * (entry.price - exit.price);
  const fees = NOTIONAL * FEE_RATE + qty * exit.price * FEE_RATE;
  const funding = fundingPnlShort(fundingRows, hourly, entry, exit);
  const net = gross - fees + funding;
  return {
    entryTime: entry.time,
    entryPrice: entry.price,
    exitTime: exit.time,
    exitPrice: exit.price,
    exitReason: exit.reason,
    grossPnlU: gross,
    feesU: fees,
    fundingU: funding,
    netPnlU: net,
    maePct: Math.max(0, (maxHigh / entry.price - 1) * 100),
    mfePct: Math.max(0, (1 - minLow / entry.price) * 100),
  };
}

function triggerSnapshot(hourly, fourHour, ts) {
  const one = hourly.filter((c) => c.closeTime <= ts).slice(-80);
  const four = fourHour.filter((c) => c.closeTime <= ts).slice(-80);
  if (one.length < 20 || four.length < 20) return null;
  const r = analyzeReversal(one, four);
  const flags = {
    rsi80: Boolean(r.rsi1hCrossBelow80),
    divergence: Boolean(r.bearishDivergence),
    break1h: Boolean(r.structureBreak1h),
    break4h: Boolean(r.structureBreak4h),
  };
  return { ...flags, count: Object.values(flags).filter(Boolean).length, detail: r };
}

function findTrigger(hourly, fourHour, signal, predicate) {
  const end = signal.evalTime + TRIGGER_WAIT_HOURS * HOUR;
  const decisionCandles = hourly.filter((c) => c.closeTime >= signal.evalTime && c.closeTime <= end);
  for (const c of decisionCandles) {
    const snap = triggerSnapshot(hourly, fourHour, c.closeTime);
    if (snap && predicate(snap)) {
      return { time: c.closeTime + 1, delayHours: (c.closeTime + 1 - signal.evalTime) / HOUR, snapshot: snap };
    }
  }
  return null;
}

const VARIANTS = {
  immediate: null,
  rsi80: (x) => x.rsi80,
  divergence: (x) => x.divergence,
  break1h: (x) => x.break1h,
  break4h: (x) => x.break4h,
  any1of4: (x) => x.count >= 1,
  twoOf4: (x) => x.count >= 2,
  rsi80_or_break1h: (x) => x.rsi80 || x.break1h,
};

function summarize(rows, key) {
  const trades = rows.map((r) => r.results[key]).filter(Boolean);
  const net = trades.reduce((s, x) => s + x.netPnlU, 0);
  const wins = trades.filter((x) => x.netPnlU > 0).length;
  const gp = trades.filter((x) => x.netPnlU > 0).reduce((s, x) => s + x.netPnlU, 0);
  const gl = Math.abs(trades.filter((x) => x.netPnlU < 0).reduce((s, x) => s + x.netPnlU, 0));
  let curve = 0; let peak = 0; let maxDD = 0;
  for (const x of trades) {
    curve += x.netPnlU;
    peak = Math.max(peak, curve);
    maxDD = Math.min(maxDD, curve - peak);
  }
  const delays = rows.map((r) => r.meta[key]?.delayHours).filter(Number.isFinite);
  return {
    trades: trades.length,
    coveragePct: trades.length / SIGNALS.length * 100,
    wins,
    winRatePct: trades.length ? wins / trades.length * 100 : null,
    tp20Count: trades.filter((x) => x.exitReason === 'tp20').length,
    stop30Count: trades.filter((x) => x.exitReason === 'stop30').length,
    netPnlU: net,
    avgPnlPerTradeU: trades.length ? net / trades.length : null,
    avgPnlPerOriginalSignalU: net / SIGNALS.length,
    profitFactor: gl > 0 ? gp / gl : (gp > 0 ? 99 : null),
    maxDrawdownU: maxDD,
    avgMaePct: trades.length ? trades.reduce((s, x) => s + x.maePct, 0) / trades.length : null,
    medianMaePct: trades.length ? [...trades].sort((a, b) => a.maePct - b.maePct)[Math.floor(trades.length / 2)].maePct : null,
    avgMfePct: trades.length ? trades.reduce((s, x) => s + x.mfePct, 0) / trades.length : null,
    avgTriggerDelayHours: delays.length ? delays.reduce((s, x) => s + x, 0) / delays.length : 0,
    feesU: trades.reduce((s, x) => s + x.feesU, 0),
    fundingU: trades.reduce((s, x) => s + x.fundingU, 0),
  };
}

function roundObject(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(3)) : v]));
}

async function main() {
  const rows = [];
  console.log(`REVERSAL_ENTRY_BACKTEST start signals=${SIGNALS.length} triggerWait=${TRIGGER_WAIT_HOURS}h TP=${TP_PCT * 100}% SL=${STOP_PCT * 100}% hold=${HOLD_HOURS}h`);
  for (let i = 0; i < SIGNALS.length; i += 1) {
    const signal = SIGNALS[i];
    process.stdout.write(`[${i + 1}/${SIGNALS.length}] ${signal.symbol} ${signal.date} ... `);
    try {
      const data = await loadSignalData(signal);
      const results = {};
      const meta = {};
      results.immediate = simulate(data.hourly, data.funding, signal.evalTime);
      meta.immediate = { delayHours: 0 };
      for (const [key, predicate] of Object.entries(VARIANTS)) {
        if (key === 'immediate') continue;
        const trigger = findTrigger(data.hourly, data.fourHour, signal, predicate);
        meta[key] = trigger ? { delayHours: trigger.delayHours, flags: trigger.snapshot } : { noTrigger: true };
        results[key] = trigger ? simulate(data.hourly, data.funding, trigger.time) : null;
      }
      rows.push({ signal, results, meta });
      console.log('ok');
    } catch (error) {
      console.log(`ERROR ${error.message}`);
      rows.push({ signal, results: {}, meta: {}, error: error.message });
    }
    await sleep(120);
  }

  const errors = rows.filter((r) => r.error);
  console.log(`\nDATA_ERRORS ${errors.length}`);
  for (const r of errors) console.log(`  ${r.signal.symbol} ${r.signal.date}: ${r.error}`);

  console.log('\nSUMMARY_JSON');
  const summary = {};
  for (const key of Object.keys(VARIANTS)) {
    summary[key] = roundObject(summarize(rows, key));
    console.log(`${key} ${JSON.stringify(summary[key])}`);
  }

  console.log('\nTRADE_DETAIL_JSON');
  for (const r of rows) {
    const compact = { symbol: r.signal.symbol, date: r.signal.date, error: r.error || null, variants: {} };
    for (const key of Object.keys(VARIANTS)) {
      const x = r.results[key];
      compact.variants[key] = x ? {
        delayH: Number((r.meta[key]?.delayHours || 0).toFixed(2)),
        entry: Number(x.entryPrice.toPrecision(8)),
        exitReason: x.exitReason,
        net: Number(x.netPnlU.toFixed(2)),
        mae: Number(x.maePct.toFixed(2)),
        mfe: Number(x.mfePct.toFixed(2)),
      } : null;
    }
    console.log(JSON.stringify(compact));
  }

  // Sanity check against prior 19-signal TP20 result (~+776.9U). The exact value can drift
  // slightly because this rerun uses fresh Binance historical responses and explicit +08 timestamps.
  const immediate = summary.immediate;
  if (!errors.length && immediate.trades === 19) {
    console.log(`\nSANITY immediate_tp20_net=${immediate.netPnlU} prior_research_reference=776.9 delta=${Number((immediate.netPnlU - 776.9).toFixed(3))}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
