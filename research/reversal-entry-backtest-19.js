'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
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
const ARCHIVE_BASE = 'https://data.binance.vision/data/futures/um';

// Same 19 mature signals used in the prior TP-exit study.
const SIGNALS = [
  ['ORDIUSDT', '2026-04-17'], ['HUMAUSDT', '2026-04-24'], ['BUSDT', '2026-05-03'],
  ['LABUSDT', '2026-05-03'], ['AKTUSDT', '2026-05-10'], ['RIFUSDT', '2026-05-13'],
  ['USELESSUSDT', '2026-05-13'], ['KITEUSDT', '2026-05-14'], ['BEATUSDT', '2026-06-08'],
  ['BEATUSDT', '2026-06-12'], ['MMTUSDT', '2026-06-23'], ['TRBUSDT', '2026-07-07'],
  ['DEXEUSDT', '2026-07-13'], ['BANKUSDT', '2026-07-17'], ['BANKUSDT', '2026-07-20'],
  ['SOONUSDT', '2026-07-29'], ['TUTUSDT', '2026-08-10'], ['CYSUSDT', '2026-08-12'],
  ['SQDUSDT', '2026-08-12'],
].map(([symbol, date]) => ({ symbol, date, evalTime: Date.parse(`${date}T00:00:00+08:00`) }));

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function ym(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; }
function monthStart(ts) { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
function nextMonth(ts) { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
function normalizeTs(v) { const n = Number(v); return n > 1e14 ? Math.floor(n / 1000) : n; }

const archiveCache = new Map();

async function downloadCsvFromZip(url) {
  if (archiveCache.has(url)) return archiveCache.get(url);
  const promise = (async () => {
    const res = await fetch(url, { headers: { 'User-Agent': 'binance-radar-reversal-archive/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const base = path.basename(new URL(url).pathname).replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = path.join(os.tmpdir(), `${process.pid}-${base}`);
    fs.writeFileSync(file, buffer);
    try {
      return execFileSync('unzip', ['-p', file], { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 });
    } finally {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  })();
  archiveCache.set(url, promise);
  try { return await promise; } catch (e) { archiveCache.delete(url); throw e; }
}

function parseCsvKlines(csv) {
  const rows = [];
  for (const line of String(csv || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const r = line.split(',');
    const openTime = normalizeTs(r[0]);
    if (!Number.isFinite(openTime)) continue; // header
    const row = {
      openTime,
      open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
      closeTime: normalizeTs(r[6]), quoteVolume: Number(r[7]),
    };
    if ([row.open, row.high, row.low, row.close, row.closeTime].every(Number.isFinite)) rows.push(row);
  }
  return rows;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}

function dailyUrls(symbol, interval, start, end) {
  const urls = [];
  let d = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate());
  const last = Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), new Date(end).getUTCDate());
  while (d <= last) {
    const date = ymd(d);
    urls.push(`${ARCHIVE_BASE}/daily/klines/${symbol}/${interval}/${symbol}-${interval}-${date}.zip`);
    d += DAY;
  }
  return urls;
}

async function loadMonth(symbol, interval, start, end, monthTs) {
  const month = ym(monthTs);
  const monthly = `${ARCHIVE_BASE}/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${month}.zip`;
  try {
    return parseCsvKlines(await downloadCsvFromZip(monthly));
  } catch (error) {
    if (!/HTTP 404/.test(error.message)) throw error;
    const mStart = monthTs;
    const mEnd = nextMonth(monthTs) - 1;
    const from = Math.max(start, mStart);
    const to = Math.min(end, mEnd);
    const urls = dailyUrls(symbol, interval, from, to);
    const csvs = await mapLimit(urls, 8, async (url) => {
      try { return await downloadCsvFromZip(url); }
      catch (e) { if (/HTTP 404/.test(e.message)) return ''; throw e; }
    });
    return csvs.flatMap(parseCsvKlines);
  }
}

async function loadArchiveKlines(symbol, interval, start, end) {
  const months = [];
  for (let m = monthStart(start); m <= monthStart(end); m = nextMonth(m)) months.push(m);
  const chunks = await mapLimit(months, 3, (m) => loadMonth(symbol, interval, start, end, m));
  const dedup = new Map();
  for (const row of chunks.flat()) {
    if (row.openTime >= start - DAY && row.openTime <= end + DAY) dedup.set(row.openTime, row);
  }
  return [...dedup.values()].sort((a, b) => a.openTime - b.openTime);
}

async function loadSignalData(signal) {
  const start = signal.evalTime - PRELOAD_HOURS * HOUR;
  const end = signal.evalTime + (TRIGGER_WAIT_HOURS + HOLD_HOURS + 8) * HOUR;
  const fourStart = start - 4 * DAY;
  const [hourly, fourHour] = await Promise.all([
    loadArchiveKlines(signal.symbol, '1h', start, end),
    loadArchiveKlines(signal.symbol, '4h', fourStart, end),
  ]);
  if (hourly.length < 80 || fourHour.length < 20) {
    throw new Error(`insufficient archive data h1=${hourly.length} h4=${fourHour.length}`);
  }
  return { hourly, fourHour };
}

function nextEntry(hourly, ts) {
  const c = hourly.find((x) => x.openTime >= ts);
  return c ? { price: c.open, time: c.openTime } : null;
}

function simulate(hourly, triggerTime) {
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
    if (c.high >= stop) { exit = { price: stop, time: c.closeTime, reason: 'stop30' }; break; }
    if (c.low <= tp) { exit = { price: tp, time: c.closeTime, reason: 'tp20' }; break; }
  }
  if (!exit) {
    const final = [...hourly].reverse().find((c) => c.closeTime <= deadline && c.openTime >= entry.time);
    if (!final) return null;
    exit = { price: final.close, time: final.closeTime, reason: '72h' };
  }

  const qty = NOTIONAL / entry.price;
  const gross = qty * (entry.price - exit.price);
  const fees = NOTIONAL * FEE_RATE + qty * exit.price * FEE_RATE;
  const net = gross - fees;
  return {
    entryTime: entry.time, entryPrice: entry.price, exitTime: exit.time, exitPrice: exit.price,
    exitReason: exit.reason, grossPnlU: gross, feesU: fees, fundingU: 0, netPnlU: net,
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
  for (const x of trades) { curve += x.netPnlU; peak = Math.max(peak, curve); maxDD = Math.min(maxDD, curve - peak); }
  const delays = rows.map((r) => r.meta[key]?.delayHours).filter(Number.isFinite);
  const maes = trades.map((x) => x.maePct).sort((a, b) => a - b);
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
    medianMaePct: maes.length ? maes[Math.floor(maes.length / 2)] : null,
    avgMfePct: trades.length ? trades.reduce((s, x) => s + x.mfePct, 0) / trades.length : null,
    avgTriggerDelayHours: delays.length ? delays.reduce((s, x) => s + x, 0) / delays.length : 0,
    feesU: trades.reduce((s, x) => s + x.feesU, 0),
    fundingU: 0,
  };
}

function roundObject(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(3)) : v]));
}

async function main() {
  const rows = [];
  console.log(`REVERSAL_ENTRY_BACKTEST_ARCHIVE signals=${SIGNALS.length} triggerWait=${TRIGGER_WAIT_HOURS}h TP=20 SL=30 hold=72 funding=excluded`);
  for (let i = 0; i < SIGNALS.length; i += 1) {
    const signal = SIGNALS[i];
    process.stdout.write(`[${i + 1}/${SIGNALS.length}] ${signal.symbol} ${signal.date} ... `);
    try {
      const data = await loadSignalData(signal);
      const results = { immediate: simulate(data.hourly, signal.evalTime) };
      const meta = { immediate: { delayHours: 0 } };
      for (const [key, predicate] of Object.entries(VARIANTS)) {
        if (key === 'immediate') continue;
        const trigger = findTrigger(data.hourly, data.fourHour, signal, predicate);
        meta[key] = trigger ? { delayHours: trigger.delayHours, flags: trigger.snapshot } : { noTrigger: true };
        results[key] = trigger ? simulate(data.hourly, trigger.time) : null;
      }
      rows.push({ signal, results, meta });
      console.log(`ok h1=${data.hourly.length} h4=${data.fourHour.length}`);
    } catch (error) {
      console.log(`ERROR ${error.message}`);
      rows.push({ signal, results: {}, meta: {}, error: error.message });
    }
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
        delayH: Number((r.meta[key]?.delayHours || 0).toFixed(2)), entry: Number(x.entryPrice.toPrecision(8)),
        exitReason: x.exitReason, net: Number(x.netPnlU.toFixed(2)), mae: Number(x.maePct.toFixed(2)), mfe: Number(x.mfePct.toFixed(2)),
      } : null;
    }
    console.log(JSON.stringify(compact));
  }

  const immediate = summary.immediate;
  if (!errors.length && immediate.trades === 19) {
    console.log(`\nSANITY immediate_tp20_net_ex_funding=${immediate.netPnlU} prior_tp20_net_incl_funding=776.9 prior_funding_about=19.0`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
