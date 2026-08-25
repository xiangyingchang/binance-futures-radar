'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { CONFIG, computeSignal, inversePnlBtc, targetContracts } = require('../lib/btc-v3-strategy');

const DAY = 86400000;
const START = Date.UTC(2020, 7, 1);
const END = Date.UTC(2026, 7, 0, 23, 59, 59, 999);
const FEE_BPS = 5;
const SLIPPAGE_BPS = 5;
const CONTRACT_SIZE = 100;
const BASE = 'https://data.binance.vision/data/futures/cm/monthly';

function monthKeys(start, end) {
  const out = [];
  const d = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1));
  const last = new Date(end);
  while (d.getTime() <= Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1)) {
    out.push([d.getUTCFullYear(), d.getUTCMonth() + 1]);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

async function fetchZipCsv(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'btc-v3-rebalance-frequency-research/2.0' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3freq-'));
  const zip = path.join(dir, 'a.zip');
  fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  try { return execFileSync('unzip', ['-p', zip], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function parse(csv) {
  if (!csv) return [];
  return csv.split(/\r?\n/).filter(Boolean).map((line) => line.split(',')).map((r) => ({
    openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), closeTime: Number(r[6]),
  })).filter((r) => [r.openTime,r.open,r.high,r.low,r.close,r.closeTime].every(Number.isFinite) && r.open > 0 && r.close > 0);
}

async function load(kind, symbol) {
  const all = [];
  for (const [y,m] of monthKeys(START, END)) {
    const mm = String(m).padStart(2,'0');
    const url = `${BASE}/${kind}/${symbol}/1d/${symbol}-1d-${y}-${mm}.zip`;
    const csv = await fetchZipCsv(url);
    if (csv) all.push(...parse(csv));
  }
  const seen = new Set();
  return all.filter((r) => r.openTime >= START && r.openTime <= END && !seen.has(r.openTime) && seen.add(r.openTime)).sort((a,b)=>a.openTime-b.openTime);
}

function weekKey(ts) {
  const d = new Date(ts);
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(copy.getUTCFullYear(),0,1));
  const w = Math.ceil((((copy-y0)/DAY)+1)/7);
  return `${copy.getUTCFullYear()}-W${String(w).padStart(2,'0')}`;
}

function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}

function maxDrawdown(values) {
  let peak=-Infinity, worst=0;
  for (const v of values) { if (v>peak) peak=v; if (peak>0) worst=Math.min(worst,v/peak-1); }
  return worst;
}

function shouldTrade({ policy, desired, heldTarget, ts, lastWeek, lastMonth }) {
  const wk = weekKey(ts);
  const mo = monthKey(ts);
  const newWeek = lastWeek === null || wk !== lastWeek;
  const newMonth = lastMonth === null || mo !== lastMonth;

  if (policy === 'daily') return { trade: true, target: desired, wk, mo };
  if (policy === 'weekly_strict') return { trade: newWeek, target: newWeek ? desired : heldTarget, wk, mo };
  if (policy === 'monthly_strict') return { trade: newMonth, target: newMonth ? desired : heldTarget, wk, mo };
  if (policy === 'daily_down_weekly_up') {
    if (desired < heldTarget - 1e-12) return { trade: true, target: desired, wk, mo };
    if (newWeek && desired > heldTarget + 1e-12) return { trade: true, target: desired, wk, mo };
    return { trade: false, target: heldTarget, wk, mo };
  }
  if (policy === 'threshold_025') {
    const material = Math.abs(desired - heldTarget) >= 0.25 - 1e-12;
    return { trade: material, target: material ? desired : heldTarget, wk, mo };
  }
  if (policy === 'daily_down_weekly_up_threshold_025') {
    if (desired <= heldTarget - 0.25 + 1e-12) return { trade: true, target: desired, wk, mo };
    if (newWeek && desired >= heldTarget + 0.25 - 1e-12) return { trade: true, target: desired, wk, mo };
    return { trade: false, target: heldTarget, wk, mo };
  }
  throw new Error(`unknown policy ${policy}`);
}

function run(indexDaily, executionDaily, policy) {
  const execMap = new Map(executionDaily.map(r=>[r.openTime,r]));
  let equityBtc=1, contracts=0, lastPrice=null, heldTarget=1, lastWeek=null, lastMonth=null;
  let fees=0, slippage=0, trades=0, turnover=0, decisionDays=0;
  const closes=[], btcNav=[], usdNav=[], exposures=[];

  for (const idx of indexDaily) {
    const ex = execMap.get(idx.openTime);
    if (!ex) continue;
    if (lastPrice !== null) equityBtc += inversePnlBtc(contracts, CONTRACT_SIZE, lastPrice, ex.open);
    lastPrice = ex.open;

    const signal = closes.length >= CONFIG.valuationLookbackDays ? computeSignal(closes) : null;
    const desired = signal?.ready ? signal.finalTarget : 1;
    const decision = shouldTrade({ policy, desired, heldTarget, ts: idx.openTime, lastWeek, lastMonth });
    lastWeek = decision.wk;
    lastMonth = decision.mo;

    if (decision.trade) {
      decisionDays += 1;
      heldTarget = decision.target;
      const sizing = targetContracts({ targetExposure: heldTarget, equityBtc, price: ex.open, contractSizeUsd: CONTRACT_SIZE, currentContracts: contracts });
      if (sizing.deltaContracts !== 0) {
        const delta = sizing.deltaContracts;
        const slip = SLIPPAGE_BPS/10000;
        const fill = ex.open * (delta>0 ? 1+slip : 1-slip);
        const slipPnl = inversePnlBtc(delta, CONTRACT_SIZE, fill, ex.open);
        equityBtc += slipPnl; slippage += slipPnl;
        const fee = Math.abs(delta)*CONTRACT_SIZE/fill*(FEE_BPS/10000);
        equityBtc -= fee; fees += fee;
        contracts = sizing.signedContracts; trades += 1; turnover += Math.abs(delta)*CONTRACT_SIZE;
      }
    }

    equityBtc += inversePnlBtc(contracts, CONTRACT_SIZE, ex.open, ex.close);
    lastPrice = ex.close;
    closes.push(idx.close);
    btcNav.push(equityBtc); usdNav.push(equityBtc*ex.close); exposures.push(heldTarget);
  }

  return {
    policy,
    endingBtc: btcNav.at(-1), btcGainPct:(btcNav.at(-1)-1)*100, endingUsd:usdNav.at(-1),
    btcMaxDrawdown:maxDrawdown(btcNav), usdMaxDrawdown:maxDrawdown(usdNav),
    totalFeesBtc:fees, totalSlippageBtc:slippage, tradeCount:trades, decisionDays, turnoverUsd:turnover,
    avgTargetExposure:exposures.reduce((a,b)=>a+b,0)/exposures.length, observations:btcNav.length,
  };
}

(async()=>{
  const [indexDaily, executionDaily] = await Promise.all([
    load('indexPriceKlines', CONFIG.coinMPair),
    load('klines', CONFIG.coinMSymbol),
  ]);
  if (!indexDaily.length || !executionDaily.length) throw new Error(`missing Vision data index=${indexDaily.length} execution=${executionDaily.length}`);

  const policies = [
    'daily',
    'weekly_strict',
    'monthly_strict',
    'daily_down_weekly_up',
    'threshold_025',
    'daily_down_weekly_up_threshold_025',
  ];
  const scenarios=policies.map(p=>run(indexDaily,executionDaily,p));
  const daily=scenarios[0];
  for (const s of scenarios) s.deltaVsDaily={
    endingBtc:s.endingBtc-daily.endingBtc,
    btcGainPctPoints:s.btcGainPct-daily.btcGainPct,
    btcMaxDrawdownPoints:(s.btcMaxDrawdown-daily.btcMaxDrawdown)*100,
    usdMaxDrawdownPoints:(s.usdMaxDrawdown-daily.usdMaxDrawdown)*100,
    tradeCountPct:(s.tradeCount/daily.tradeCount-1)*100,
    turnoverPct:(s.turnoverUsd/daily.turnoverUsd-1)*100,
  };

  const result={
    generatedAt:new Date().toISOString(), strategyVersion:CONFIG.version, researchOnly:true, productionChanged:false,
    dataSource:'Binance Vision COIN-M monthly indexPriceKlines + BTCUSD_PERP daily klines',
    dataWindow:{start:new Date(indexDaily[0].openTime).toISOString().slice(0,10),end:new Date(indexDaily.at(-1).openTime).toISOString().slice(0,10)},
    assumptions:{
      signalTiming:'T-1 closed daily index signal -> T perpetual open', feesBps:FEE_BPS, slippageBps:SLIPPAGE_BPS,
      funding:'omitted for apples-to-apples execution-policy screening',
      strictFrequency:'weekly/monthly scenarios size and trade only on their scheduled rebalance day; no hidden daily contract resizing',
      asymmetric:'risk reductions can execute daily; exposure increases only at first UTC day of ISO week',
      threshold:'0.25x target-exposure difference required before execution',
    },
    scenarios,
  };
  fs.mkdirSync('research',{recursive:true});
  fs.writeFileSync('research/btc-v3-rebalance-frequency-result.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exit(1);});
