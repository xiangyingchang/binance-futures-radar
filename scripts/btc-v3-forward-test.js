'use strict';

const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, '..', 'data', 'btc-v3-forward-test.jsonl');
const SNAPSHOT_URL = process.env.BTC_V3_SNAPSHOT_URL
  || 'https://binance-futures-radar-v3.vercel.app/api/btc-v3';
const REQUEST_TIMEOUT_MS = Number(process.env.BTC_V3_SNAPSHOT_TIMEOUT_MS || 30000);

function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function append(record) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, `${JSON.stringify(record)}\n`, 'utf8');
}

async function fetchRemoteSnapshot() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(SNAPSHOT_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'btc-v3-forward-test-ledger/1.0' },
      cache: 'no-store',
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(payload?.message || payload?.error || `snapshot HTTP ${response.status}`);
    if (!payload || payload.autoTrade !== false || payload.executionMode !== 'READ_ONLY_FORWARD_TEST') {
      throw new Error('snapshot safety contract invalid');
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function compactSnapshot(snapshot) {
  const candle = snapshot.latestClosedCandle;
  const signal = snapshot.signal;
  const candleDate = candle?.openTimeIso?.slice(0, 10) || null;
  return {
    recordType: 'signal',
    strategyVersion: snapshot.strategyVersion,
    candleDate,
    observedAt: snapshot.observedAt,
    collectedAt: new Date().toISOString(),
    snapshotUrl: SNAPSHOT_URL,
    signalPriceSource: snapshot.signalPriceSource,
    latestClosedCandle: candle,
    instrument: snapshot.instrument,
    signal: {
      close: signal.close,
      ema15: signal.ema15,
      ema30: signal.ema30,
      ma200: signal.ma200,
      ma200Past: signal.ma200Past,
      ma200Slope30: signal.ma200Slope30,
      drawdown365: signal.drawdown365,
      ma200Deviation: signal.ma200Deviation,
      rv30: signal.rv30,
      trendScore: signal.trendScore,
      bearLock: signal.bearLock,
      cheap: signal.cheap,
      veryCheap: signal.veryCheap,
      regimeTarget: signal.regimeTarget,
      valuationAdjustedTarget: signal.valuationAdjustedTarget,
      volatilityCap: signal.volatilityCap,
      rawSignalTarget: signal.rawSignalTarget,
      marginCap: signal.marginCap,
      finalTarget: signal.finalTarget,
      tactical2xRequested: signal.tactical2xRequested,
    },
    funding: {
      currentRate: snapshot.funding.currentRate,
      markPrice: snapshot.funding.markPrice,
      indexPrice: snapshot.funding.indexPrice,
      intervalHours: snapshot.funding.intervalHours,
      nextFundingTime: snapshot.funding.nextFundingTime,
    },
    referenceSizingForOneBtc: snapshot.referenceSizingForOneBtc,
    dataQualityFlags: snapshot.dataQualityFlags,
    signalCodeCommitSha: snapshot.codeCommitSha || 'deployment-sha-unavailable',
    signalDeploymentUrl: snapshot.deploymentUrl || null,
    signalExecutionRegion: snapshot.executionRegion || null,
    deploymentEnvironment: snapshot.deploymentEnvironment || null,
    ledgerWriterCommitSha: process.env.GITHUB_SHA || 'writer-sha-unavailable',
    reconstructed: false,
    autoTrade: false,
  };
}

async function main() {
  const existing = readLedger();
  try {
    const snapshot = await fetchRemoteSnapshot();
    const record = compactSnapshot(snapshot);
    if (!record.candleDate) throw new Error('latest closed candle date unavailable');
    if (!snapshot.signal?.ready) throw new Error(`snapshot signal not ready: ${snapshot.signal?.reason || 'unknown'}`);
    const alreadyObserved = existing.some((item) => item.recordType === 'signal'
      && item.candleDate === record.candleDate
      && item.reconstructed !== true);
    if (alreadyObserved) {
      console.log(`BTC V3 ${record.candleDate} already observed; no backfill or overwrite performed.`);
      return;
    }
    append(record);
    console.log(`Appended BTC V3 forward-test signal for ${record.candleDate}: ${record.signal.finalTarget.toFixed(4)}x`);
  } catch (error) {
    const now = new Date();
    const intended = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86400000)
      .toISOString().slice(0, 10);
    append({
      recordType: 'failure',
      strategyVersion: 'btc-v3.1-coinm',
      candleDate: intended,
      observedAt: now.toISOString(),
      snapshotUrl: SNAPSHOT_URL,
      error: error.name === 'AbortError' ? `snapshot timeout after ${REQUEST_TIMEOUT_MS}ms` : (error.message || 'unknown forward-test failure'),
      ledgerWriterCommitSha: process.env.GITHUB_SHA || 'writer-sha-unavailable',
      reconstructed: false,
      autoTrade: false,
    });
    console.error(error);
    process.exitCode = 1;
  }
}

main();
